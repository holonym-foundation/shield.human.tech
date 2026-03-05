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

/**
 * @notice Helper deployed on-chain to batch-mint FEE, initialize pool, and seed liquidity.
 *         Implements IUnlockCallback so PoolManager can call back for liquidity provision.
 */
contract PoolSetupHelper is IUnlockCallback {
    using SafeERC20 for IERC20;

    IPoolManager public immutable pm;
    address public immutable feeAssetHandler;
    address public immutable feeJuice;
    address public immutable owner;

    constructor(address _pm, address _feeAssetHandler, address _feeJuice) {
        pm = IPoolManager(_pm);
        feeAssetHandler = _feeAssetHandler;
        feeJuice = _feeJuice;
        owner = msg.sender;
    }

    receive() external payable {}

    /**
     * @notice All-in-one: batch-mint FEE, initialize pool, seed liquidity.
     *         Send ETH via msg.value for the pool's native ETH side.
     */
    function setup(
        uint256 mintCount,
        PoolKey calldata key,
        uint160 sqrtPriceX96,
        int24 tickLower,
        int24 tickUpper,
        int256 liquidityDelta
    ) external payable {
        require(msg.sender == owner, "not owner");

        // 1. Batch mint FEE (each call mints 1,000 FEE to this contract)
        for (uint256 i = 0; i < mintCount; i++) {
            IFeeAssetHandler(feeAssetHandler).mint(address(this));
        }

        // 2. Initialize pool
        pm.initialize(key, sqrtPriceX96);

        // 3. Seed liquidity via unlock callback
        bytes memory data = abi.encode(key, tickLower, tickUpper, liquidityDelta);
        pm.unlock(data);
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

    /// @notice Sweep leftover tokens/ETH back to owner.
    function sweep(address token) external {
        require(msg.sender == owner, "not owner");
        if (token == address(0)) {
            uint256 bal = address(this).balance;
            if (bal > 0) payable(owner).transfer(bal);
        } else {
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal > 0) IERC20(token).safeTransfer(owner, bal);
        }
    }
}

contract DeployNativeEthPool is Script {
    // Sepolia addresses
    address constant POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address constant AZTEC = 0x35d0186d1FD53b72996475D965C5Ed171D52b986;
    address constant FEE_ASSET_HANDLER = 0xED9c5557d2E0abCc7c7FCA958eE4292199413494;

    uint24 constant POOL_FEE = 3000;
    int24 constant TICK_SPACING = 60;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);

        // ── 1. Deploy UniswapFuelSwap ────────────────────────────────
        UniswapFuelSwap swapper = new UniswapFuelSwap(POOL_MANAGER, AZTEC, WETH);
        console.log("UniswapFuelSwap deployed at:", address(swapper));

        // ── 2. Deploy PoolSetupHelper ────────────────────────────────
        PoolSetupHelper helper = new PoolSetupHelper(POOL_MANAGER, FEE_ASSET_HANDLER, AZTEC);
        console.log("PoolSetupHelper deployed at:", address(helper));

        // ── 3. Build pool key: ETH(address(0)) / AZTEC(0x35d...) ───
        // address(0) < 0x35d... so currency0=ETH, currency1=AZTEC
        PoolKey memory ethFeeKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(AZTEC),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });

        // ── 4. Call setup: mint 100 * 1000 FEE, init pool, seed ─────
        //
        // Price: 1 ETH = 10,000 FEE  →  price = 10000  →  sqrtPriceX96 = 100 * 2^96
        // 100 * 2^96 = 7922816251426433759354395033600
        //
        // Tick range: ~10x in both directions from current tick (~92100)
        //   tickLower = 69060  (price ≈ 1,000 FEE/ETH)
        //   tickUpper = 115140 (price ≈ 100,000 FEE/ETH)
        //
        // liquidityDelta: 1e18 (substantial for testing)
        //
        // Send 1.5 ETH to cover the pool's native ETH side.
        helper.setup{value: 1.5 ether}(
            100,                  // mintCount: 100 * 1000 = 100,000 FEE
            ethFeeKey,
            7922816251426433759354395033600, // sqrtPriceX96 for price=10000
            69060,                // tickLower
            115140,               // tickUpper
            1e18                  // liquidityDelta
        );
        console.log("Pool initialized and liquidity seeded!");

        // ── 5. Sweep leftover tokens/ETH from helper ────────────────
        helper.sweep(address(0));
        helper.sweep(AZTEC);
        console.log("Swept leftovers from helper");

        vm.stopBroadcast();
    }
}
