// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import "forge-std/Script.sol";
import {UniswapFuelSwap} from "../src/UniswapFuelSwap.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

interface IFeeAssetHandler {
    function mint(address) external;
}

interface IWETH {
    function deposit() external payable;
}

/**
 * @notice On-chain helper: optionally batch-mints FEE, initializes a V4 pool (idempotent),
 *         and seeds liquidity. Implements IUnlockCallback for PoolManager.
 *         Deployed as part of the script, used once, then leftovers are swept.
 */
contract PoolSetupHelper is IUnlockCallback {
    using SafeERC20 for IERC20;

    IPoolManager public immutable pm;
    address public immutable feeAssetHandler;
    address public immutable feeJuice;
    address public immutable deployer;

    constructor(address _pm, address _feeAssetHandler, address _feeJuice) {
        pm = IPoolManager(_pm);
        feeAssetHandler = _feeAssetHandler;
        feeJuice = _feeJuice;
        deployer = msg.sender;
    }

    receive() external payable {}

    /**
     * @notice Idempotent pool setup: batch-mint FEE (if mintCount > 0),
     *         initialize pool (skip if already exists), seed liquidity.
     *         Send ETH via msg.value for native ETH pools.
     *         For ERC-20 only pools, transfer tokens to this contract first and set mintCount=0.
     * @param mintCount     Number of mint() calls (each mints 1,000 FEE). 0 to skip.
     * @param key           PoolKey for the V4 pool.
     * @param sqrtPriceX96  Initial sqrt price (Q64.96 format). Ignored if pool exists.
     * @param tickLower     Lower tick boundary for liquidity.
     * @param tickUpper     Upper tick boundary for liquidity.
     * @param liquidityDelta Amount of liquidity to provision.
     */
    function setup(
        uint256 mintCount,
        PoolKey calldata key,
        uint160 sqrtPriceX96,
        int24 tickLower,
        int24 tickUpper,
        int256 liquidityDelta
    ) external payable {
        require(msg.sender == deployer, "not deployer");

        // 1. Batch mint FEE (each call mints 1,000 FEE to this contract)
        for (uint256 i = 0; i < mintCount; i++) {
            IFeeAssetHandler(feeAssetHandler).mint(address(this));
        }

        // 2. Initialize pool (idempotent — skip if already exists)
        try pm.initialize(key, sqrtPriceX96) returns (int24) {
            // Pool initialized successfully
        } catch {
            // Pool already initialized, continue to add liquidity
        }

        // 3. Seed liquidity via unlock callback
        pm.unlock(abi.encode(key, tickLower, tickUpper, liquidityDelta));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(pm), "only pm");

        (PoolKey memory key, int24 tickLower, int24 tickUpper, int256 liquidityDelta) =
            abi.decode(data, (PoolKey, int24, int24, int256));

        (BalanceDelta delta,) = pm.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: liquidityDelta,
                salt: bytes32(0)
            }),
            ""
        );

        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();

        if (d0 < 0) {
            uint256 owed = uint256(uint128(-d0));
            if (Currency.unwrap(key.currency0) == address(0)) {
                pm.settle{value: owed}();
            } else {
                pm.sync(key.currency0);
                IERC20(Currency.unwrap(key.currency0)).safeTransfer(address(pm), owed);
                pm.settle();
            }
        }
        if (d1 < 0) {
            uint256 owed = uint256(uint128(-d1));
            if (Currency.unwrap(key.currency1) == address(0)) {
                pm.settle{value: owed}();
            } else {
                pm.sync(key.currency1);
                IERC20(Currency.unwrap(key.currency1)).safeTransfer(address(pm), owed);
                pm.settle();
            }
        }

        if (d0 > 0) pm.take(key.currency0, address(this), uint256(uint128(d0)));
        if (d1 > 0) pm.take(key.currency1, address(this), uint256(uint128(d1)));

        return "";
    }

    /// @notice Sweep leftover tokens/ETH back to deployer.
    function sweep(address token) external {
        require(msg.sender == deployer, "not deployer");
        if (token == address(0)) {
            uint256 bal = address(this).balance;
            if (bal > 0) payable(deployer).transfer(bal);
        } else {
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal > 0) IERC20(token).safeTransfer(deployer, bal);
        }
    }
}

/**
 * @notice Deploy UniswapFuelSwap + create and seed V4 pools on Sepolia:
 *         1) Native ETH/AZTEC pool (~10,000 FEE per ETH)
 *         2) USDC/WETH pool (~2,100 USDC per WETH)
 *
 *         Usage:
 *           source .env
 *           forge script script/DeployUniswapFuelSwap.s.sol:DeployUniswapFuelSwap \
 *             --rpc-url $RPC_URL --broadcast -vvv
 *
 *         Env vars (all optional):
 *           MINT_COUNT             — FeeAssetHandler.mint() calls (default: 100 → 100k FEE)
 *           ETH_SEED               — ETH for ETH/AZTEC pool (default: 0.5 ether)
 *           LIQUIDITY_DELTA        — Liquidity for ETH/AZTEC pool (default: 1e18)
 *           WETH_SEED              — ETH to wrap for USDC/WETH pool (default: 1.5 ether)
 *           USDC_SEED              — USDC to seed USDC/WETH pool (default: 3000e6)
 *           USDC_WETH_LIQUIDITY    — Liquidity for USDC/WETH pool (default: 6e13)
 */
contract DeployUniswapFuelSwap is Script {
    using SafeERC20 for IERC20;

    // ── Sepolia addresses ────────────────────────────────────────────
    address constant POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address constant WETH         = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address constant AZTEC        = 0x35d0186d1FD53b72996475D965C5Ed171D52b986;
    address constant FEE_ASSET_HANDLER = 0xED9c5557d2E0abCc7c7FCA958eE4292199413494;
    address constant USDC         = 0x47E16BD8702BCef388085c0371Ba0B87fA883f5e;

    // ── ETH/AZTEC pool parameters ────────────────────────────────────
    // Native ETH/AZTEC pool at ~10,000 FEE per ETH
    // sqrtPriceX96 = sqrt(10000) * 2^96 = 100 * 2^96
    uint24  constant ETH_AZTEC_FEE          = 3000;  // 0.3%
    int24   constant ETH_AZTEC_TICK_SPACING  = 60;
    uint160 constant ETH_AZTEC_SQRT_PRICE    = 7922816251426433759354395033600;
    int24   constant ETH_AZTEC_TICK_LOWER    = 69060;   // price ~ 1,000 FEE/ETH
    int24   constant ETH_AZTEC_TICK_UPPER    = 115140;  // price ~ 100,000 FEE/ETH

    // ── USDC/WETH pool parameters ────────────────────────────────────
    // currency0 = USDC (0x47E...) < currency1 = WETH (0xfFf...)
    // Target: ~2,100 USDC per WETH
    // price_raw = 1e18 / (2100 * 1e6) = 476,190,476
    // sqrtPriceX96 = sqrt(476190476) * 2^96 ≈ 21822 * 2^96
    uint24  constant USDC_WETH_FEE           = 3000;  // 0.3%
    int24   constant USDC_WETH_TICK_SPACING  = 60;
    uint160 constant USDC_WETH_SQRT_PRICE    = 1728916962386276374966316084832192;
    int24   constant USDC_WETH_TICK_LOWER    = 169800;  // ~ $42,000/WETH
    int24   constant USDC_WETH_TICK_UPPER    = 229800;  // ~ $104/WETH

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");

        // Configurable parameters
        uint256 mintCount         = vm.envOr("MINT_COUNT", uint256(100));
        uint256 ethSeed           = vm.envOr("ETH_SEED", uint256(0.5 ether));
        int256  liquidityDelta    = int256(vm.envOr("LIQUIDITY_DELTA", uint256(1e18)));
        uint256 wethSeed          = vm.envOr("WETH_SEED", uint256(1.5 ether));
        uint256 usdcSeed          = vm.envOr("USDC_SEED", uint256(3000e6));
        int256  usdcWethLiquidity = int256(vm.envOr("USDC_WETH_LIQUIDITY", uint256(6e13)));

        vm.startBroadcast(pk);

        // ── 1. Deploy UniswapFuelSwap ────────────────────────────────
        UniswapFuelSwap swapper = new UniswapFuelSwap(POOL_MANAGER, AZTEC, WETH);
        console.log("UniswapFuelSwap deployed at:", address(swapper));

        // ── 2. Deploy PoolSetupHelper ────────────────────────────────
        PoolSetupHelper helper = new PoolSetupHelper(POOL_MANAGER, FEE_ASSET_HANDLER, AZTEC);
        console.log("PoolSetupHelper deployed at:", address(helper));

        // ── 3. Setup ETH/AZTEC pool (idempotent) ─────────────────────
        PoolKey memory ethAztecKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(AZTEC),
            fee: ETH_AZTEC_FEE,
            tickSpacing: ETH_AZTEC_TICK_SPACING,
            hooks: IHooks(address(0))
        });
        helper.setup{value: ethSeed}(
            mintCount,
            ethAztecKey,
            ETH_AZTEC_SQRT_PRICE,
            ETH_AZTEC_TICK_LOWER,
            ETH_AZTEC_TICK_UPPER,
            liquidityDelta
        );
        console.log("ETH/AZTEC pool setup complete");

        // ── 4. Wrap ETH -> WETH for USDC/WETH pool ──────────────────
        IWETH(WETH).deposit{value: wethSeed}();

        // ── 5. Transfer USDC + WETH to helper ────────────────────────
        IERC20(WETH).safeTransfer(address(helper), wethSeed);
        IERC20(USDC).safeTransfer(address(helper), usdcSeed);

        // ── 6. Setup USDC/WETH pool (idempotent) ─────────────────────
        PoolKey memory usdcWethKey = PoolKey({
            currency0: Currency.wrap(USDC),
            currency1: Currency.wrap(WETH),
            fee: USDC_WETH_FEE,
            tickSpacing: USDC_WETH_TICK_SPACING,
            hooks: IHooks(address(0))
        });
        helper.setup(
            0, // no minting needed for USDC/WETH
            usdcWethKey,
            USDC_WETH_SQRT_PRICE,
            USDC_WETH_TICK_LOWER,
            USDC_WETH_TICK_UPPER,
            usdcWethLiquidity
        );
        console.log("USDC/WETH pool setup complete");

        // ── 7. Sweep leftover tokens/ETH from helper ─────────────────
        helper.sweep(address(0));
        helper.sweep(AZTEC);
        helper.sweep(WETH);
        helper.sweep(USDC);
        console.log("Swept leftovers from helper");

        vm.stopBroadcast();
    }
}
