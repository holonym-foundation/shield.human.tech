// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import "forge-std/Script.sol";
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

interface ITestERC20 {
    function mint(address to, uint256 amount) external;
    function decimals() external view returns (uint8);
}

/**
 * @notice On-chain helper for pool setup. Deployed once per script run, used to
 *         initialize pools and seed liquidity via PoolManager.unlock callback.
 */
contract PoolSeeder is IUnlockCallback {
    using SafeERC20 for IERC20;

    IPoolManager public immutable pm;
    address public immutable deployer;

    constructor(address _pm) {
        pm = IPoolManager(_pm);
        deployer = msg.sender;
    }

    receive() external payable {}

    function setup(
        PoolKey calldata key,
        uint160 sqrtPriceX96,
        int24 tickLower,
        int24 tickUpper,
        int256 liquidityDelta
    ) external payable {
        require(msg.sender == deployer, "not deployer");

        // Initialize pool (idempotent — skip if already exists)
        try pm.initialize(key, sqrtPriceX96) returns (int24) {
            console.log("  Pool initialized");
        } catch {
            console.log("  Pool already exists, adding liquidity");
        }

        // Seed liquidity via unlock callback
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

    /**
     * @notice Remove liquidity from a pool and return tokens to this contract.
     *         Call sweep() afterwards to transfer tokens to the deployer.
     */
    function removeLiquidity(
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        int256 liquidityDelta
    ) external {
        require(msg.sender == deployer, "not deployer");
        require(liquidityDelta < 0, "must be negative");
        pm.unlock(abi.encode(key, tickLower, tickUpper, liquidityDelta));
    }

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
 * @notice Seed Uniswap V4 pools on Sepolia without deploying new contracts.
 *         Creates and seeds two pools:
 *           1) Native ETH / FeeJuice (AZTEC) pool
 *           2) ERC20 (e.g. USDC) / WETH pool
 *
 *         Usage:
 *           PRIVATE_KEY=0x... forge script script/SeedUniswapPools.s.sol:SeedUniswapPools \
 *             --rpc-url $RPC_URL --broadcast -vvv
 *
 *         Optional env vars:
 *           ERC20_TOKEN          — Token address for ERC20/WETH pool (default: new deployment's USDC)
 *           ERC20_DECIMALS       — Decimals for the ERC20 token (default: 6)
 *           FEE_MINT_COUNT       — FeeAssetHandler.mint() calls, each mints 1000 FJ (default: 100)
 *           ETH_SEED             — ETH for ETH/AZTEC pool (default: 0.3 ether)
 *           ETH_AZTEC_LIQUIDITY  — Liquidity for ETH/AZTEC pool (default: 1e18)
 *           ERC20_AMOUNT         — ERC20 amount to seed (default: 5000 * 10^decimals)
 *           WETH_SEED            — ETH to wrap for ERC20/WETH pool (default: 1.5 ether)
 *           ERC20_WETH_LIQUIDITY — Liquidity for ERC20/WETH pool (default: 6e13)
 */
contract SeedUniswapPools is Script {
    using SafeERC20 for IERC20;

    // ── Sepolia constants ──────────────────────────────────────────
    address constant POOL_MANAGER      = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address constant WETH              = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    // AZTEC and FEE_ASSET_HANDLER are read from env (differ per environment)

    // ── ETH/AZTEC pool params (~10,000 FeeJuice per ETH) ───────────
    uint24  constant ETH_AZTEC_FEE         = 3000;
    int24   constant ETH_AZTEC_TICK_SPACING = 60;
    uint160 constant ETH_AZTEC_SQRT_PRICE  = 7922816251426433759354395033600;
    int24   constant ETH_AZTEC_TICK_LOWER  = -887220;  // full range (tick spacing = 60)
    int24   constant ETH_AZTEC_TICK_UPPER  = 887220;   // full range

    // ── ERC20/WETH pool params (~2,100 USDC per WETH) ──────────────
    uint24  constant ERC20_WETH_FEE         = 3000;
    int24   constant ERC20_WETH_TICK_SPACING = 60;
    uint160 constant ERC20_WETH_SQRT_PRICE  = 1728916962386276374966316084832192;
    int24   constant ERC20_WETH_TICK_LOWER  = -887220;  // full range
    int24   constant ERC20_WETH_TICK_UPPER  = 887220;   // full range

    // ── ERC20/AZTEC direct pool params (~10 FeeJuice per USDC) ──────
    // NOTE: sqrtPriceX96 depends on currency ordering (lower address = currency0).
    // The script computes the correct price at runtime based on actual addresses.
    uint24  constant DIRECT_FEE         = 3000;
    int24   constant DIRECT_TICK_SPACING = 60;
    int24   constant DIRECT_TICK_LOWER  = -887220;  // full range
    int24   constant DIRECT_TICK_UPPER  = 887220;   // full range

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");

        // AZTEC (FeeJuice) and FeeAssetHandler addresses — MUST be set per environment
        address AZTEC             = vm.envAddress("AZTEC_TOKEN");
        address FEE_ASSET_HANDLER = vm.envAddress("FEE_ASSET_HANDLER");

        // ERC20 token for the ERC20/WETH pool (defaults to the USDC from old deploy script)
        address erc20Token = vm.envOr("ERC20_TOKEN", address(0));

        // Log addresses so the operator can verify before broadcasting
        console.log("\n=== Address verification ===");
        console.log("  AZTEC (FeeJuice):", AZTEC);
        console.log("  FEE_ASSET_HANDLER:", FEE_ASSET_HANDLER);
        console.log("  ERC20_TOKEN:", erc20Token);
        console.log("  Verify these match your active frontend deployment before proceeding.");
        console.log("============================\n");

        // Configurable params
        uint256 feeMintCount       = vm.envOr("FEE_MINT_COUNT", uint256(100));
        uint256 ethSeed            = vm.envOr("ETH_SEED", uint256(0.3 ether));
        int256  ethAztecLiquidity  = int256(vm.envOr("ETH_AZTEC_LIQUIDITY", uint256(1e18)));
        uint256 wethSeed           = vm.envOr("WETH_SEED", uint256(1.5 ether));
        int256  erc20WethLiquidity = int256(vm.envOr("ERC20_WETH_LIQUIDITY", uint256(6e13)));

        vm.startBroadcast(pk);

        // ── Deploy helper ──────────────────────────────────────────
        PoolSeeder seeder = new PoolSeeder(POOL_MANAGER);
        console.log("PoolSeeder deployed at:", address(seeder));

        // ── Pool 1: ETH/AZTEC (FeeJuice) ──────────────────────────
        bool skipEthAztec = vm.envOr("SKIP_ETH_AZTEC", false);
        if (!skipEthAztec) {
            console.log("\n--- ETH/AZTEC pool ---");
            console.log("  Minting FeeJuice:", feeMintCount, "x 1000 FJ");
            for (uint256 i = 0; i < feeMintCount; i++) {
                IFeeAssetHandler(FEE_ASSET_HANDLER).mint(address(seeder));
            }

            // Also transfer any FJ the deployer already holds to the seeder
            uint256 deployerFjBal = IERC20(AZTEC).balanceOf(vm.addr(pk));
            if (deployerFjBal > 0) {
                IERC20(AZTEC).safeTransfer(address(seeder), deployerFjBal);
                console.log("  Transferred deployer FJ to seeder:", deployerFjBal);
            }

            PoolKey memory ethAztecKey = PoolKey({
                currency0: Currency.wrap(address(0)),
                currency1: Currency.wrap(AZTEC),
                fee: ETH_AZTEC_FEE,
                tickSpacing: ETH_AZTEC_TICK_SPACING,
                hooks: IHooks(address(0))
            });

            seeder.setup{value: ethSeed}(
                ethAztecKey,
                ETH_AZTEC_SQRT_PRICE,
                ETH_AZTEC_TICK_LOWER,
                ETH_AZTEC_TICK_UPPER,
                ethAztecLiquidity
            );
            console.log("  ETH/AZTEC pool seeded");
        } else {
            console.log("\n--- Skipping ETH/AZTEC pool (SKIP_ETH_AZTEC=true) ---");
        }

        // ── Pool 2: ERC20/WETH ─────────────────────────────────────
        bool skipErc20Weth = vm.envOr("SKIP_ERC20_WETH", false);
        if (erc20Token != address(0) && !skipErc20Weth) {
            console.log("\n--- ERC20/WETH pool ---");
            console.log("  ERC20 token:", erc20Token);

            uint8 decimals = ITestERC20(erc20Token).decimals();
            uint256 erc20Amount = vm.envOr("ERC20_AMOUNT", uint256(5000 * 10 ** decimals));

            // Mint ERC20 tokens to deployer (TestERC20 has public mint)
            address deployer = vm.addr(pk);
            ITestERC20(erc20Token).mint(deployer, erc20Amount);
            console.log("  Minted ERC20:", erc20Amount);

            // Wrap ETH -> WETH
            IWETH(WETH).deposit{value: wethSeed}();
            console.log("  Wrapped WETH:", wethSeed);

            // Transfer to seeder
            IERC20(erc20Token).safeTransfer(address(seeder), erc20Amount);
            IERC20(WETH).safeTransfer(address(seeder), wethSeed);

            // Determine currency ordering (lower address = currency0)
            address c0 = erc20Token < WETH ? erc20Token : WETH;
            address c1 = erc20Token < WETH ? WETH : erc20Token;

            PoolKey memory erc20WethKey = PoolKey({
                currency0: Currency.wrap(c0),
                currency1: Currency.wrap(c1),
                fee: ERC20_WETH_FEE,
                tickSpacing: ERC20_WETH_TICK_SPACING,
                hooks: IHooks(address(0))
            });

            seeder.setup(
                erc20WethKey,
                ERC20_WETH_SQRT_PRICE,
                ERC20_WETH_TICK_LOWER,
                ERC20_WETH_TICK_UPPER,
                erc20WethLiquidity
            );
            console.log("  ERC20/WETH pool seeded");

            seeder.sweep(erc20Token);
        } else {
            console.log("\n--- Skipping ERC20/WETH pool (no ERC20_TOKEN set) ---");
        }

        // ── Pool 3: ERC20/AZTEC direct pool (testnet only) ──────────
        bool seedDirectPool = vm.envOr("SEED_DIRECT_POOL", false);
        if (seedDirectPool && erc20Token != address(0)) {
            console.log("\n--- ERC20/AZTEC direct pool ---");

            uint8 decimals = ITestERC20(erc20Token).decimals();
            uint256 directErc20Amount = vm.envOr("DIRECT_ERC20_AMOUNT", uint256(50000 * 10 ** decimals));
            uint256 directFjMintCount = vm.envOr("DIRECT_FJ_MINT_COUNT", uint256(100));

            // Mint ERC20 for direct pool
            ITestERC20(erc20Token).mint(address(seeder), directErc20Amount);
            console.log("  Minted ERC20:", directErc20Amount);

            // Mint FeeJuice for direct pool
            for (uint256 i = 0; i < directFjMintCount; i++) {
                IFeeAssetHandler(FEE_ASSET_HANDLER).mint(address(seeder));
            }
            console.log("  Minted FJ:", directFjMintCount, "x 1000 FJ");

            // Also transfer any deployer FJ to seeder
            uint256 deployerFjBal2 = IERC20(AZTEC).balanceOf(vm.addr(pk));
            if (deployerFjBal2 > 0) {
                IERC20(AZTEC).safeTransfer(address(seeder), deployerFjBal2);
                console.log("  Transferred deployer FJ to seeder:", deployerFjBal2);
            }

            // Compute sqrtPriceX96 based on currency ordering
            // Target: 10 FJ (18 dec) per 1 USDC (6 dec) → raw price = 10e18/1e6 = 1e13
            // If AZTEC < ERC20: price = ERC20/AZTEC = 1e6/10e18 = 1e-13 → sqrtPriceX96 ≈ 25054139607112
            // If ERC20 < AZTEC: price = AZTEC/ERC20 = 10e18/1e6 = 1e13 → sqrtPriceX96 ≈ 250541396071120286692299382636675072
            uint160 directSqrtPrice;
            if (erc20Token < AZTEC) {
                // ERC20 is currency0, AZTEC is currency1 → price = AZTEC/ERC20 = high
                directSqrtPrice = 250541396071120286692299382636675072;
            } else {
                // AZTEC is currency0, ERC20 is currency1 → price = ERC20/AZTEC = low
                directSqrtPrice = 25054144837504792002560;
            }

            int256 directLiquidity = int256(vm.envOr("DIRECT_LIQUIDITY", uint256(1e15)));
            seeder.setup(
                PoolKey({
                    currency0: Currency.wrap(erc20Token < AZTEC ? erc20Token : AZTEC),
                    currency1: Currency.wrap(erc20Token < AZTEC ? AZTEC : erc20Token),
                    fee: DIRECT_FEE,
                    tickSpacing: DIRECT_TICK_SPACING,
                    hooks: IHooks(address(0))
                }),
                directSqrtPrice,
                DIRECT_TICK_LOWER,
                DIRECT_TICK_UPPER,
                directLiquidity
            );
            console.log("  ERC20/AZTEC direct pool seeded");

            seeder.sweep(erc20Token);
        } else if (seedDirectPool) {
            console.log("\n--- Skipping ERC20/AZTEC pool (no ERC20_TOKEN set) ---");
        }

        // ── Sweep leftovers ────────────────────────────────────────
        seeder.sweep(address(0));
        seeder.sweep(AZTEC);
        seeder.sweep(WETH);
        console.log("\nSwept leftovers from seeder");

        vm.stopBroadcast();
    }
}
