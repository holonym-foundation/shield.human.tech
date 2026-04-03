// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import "forge-std/Test.sol";
import {UniswapFuelSwap} from "../UniswapFuelSwap.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {ERC20} from "@oz/token/ERC20/ERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolSeeder} from "../../script/SeedUniswapPools.s.sol";

/// @notice Minimal mintable ERC-20 (mirrors TestERC20 deployed by bridge-script)
contract TestERC20 is ERC20 {
    uint8 private _dec;
    constructor(string memory name, string memory symbol, uint8 dec) ERC20(name, symbol) { _dec = dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function decimals() public view override returns (uint8) { return _dec; }
}

interface IFeeAssetHandler {
    function mint(address) external;
}

interface IWETH {
    function deposit() external payable;
}

/**
 * @title E2EPoolSeedAndSwapTest
 * @notice End-to-end fork test that mirrors the exact bridge-script deployment flow:
 *
 *   1. Deploy PoolSeeder
 *   2. Mint FeeJuice -> seed ETH/AZTEC pool (same params as index-devnet.ts)
 *   3. Mint USDC + wrap WETH -> seed USDC/WETH pool (same params as index-devnet.ts)
 *   4. Sweep leftovers
 *   5. Deploy UniswapFuelSwap
 *   6. Execute multi-hop swap: USDC -> WETH -> FeeJuice
 *   7. Verify output, no leftover tokens, pool balances changed
 *
 * This is the "dry run" — if it passes, the devnet script should work.
 *
 * Run:
 *   SEPOLIA_RPC_URL=<url> forge test --match-contract E2EPoolSeedAndSwapTest -vvv
 */
contract E2EPoolSeedAndSwapTest is Test {
    using SafeERC20 for IERC20;

    // ── Sepolia constants (must match bridge-script/index-devnet.ts) ──
    address constant POOL_MANAGER      = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address constant WETH              = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address constant AZTEC             = 0x35d0186d1FD53b72996475D965C5Ed171D52b986;
    address constant FEE_ASSET_HANDLER = 0xED9c5557d2E0abCc7c7FCA958eE4292199413494;

    // ── ETH/AZTEC pool params (must match index-devnet.ts / seed-pools.ts) ──
    uint160 constant ETH_AZTEC_SQRT_PRICE  = 7922816251426433759354395033600;
    int24   constant ETH_AZTEC_TICK_LOWER  = 69060;
    int24   constant ETH_AZTEC_TICK_UPPER  = 115140;
    uint24  constant ETH_AZTEC_FEE         = 3000;
    int24   constant ETH_AZTEC_TICK_SPACING = 60;
    int256  constant ETH_AZTEC_LIQUIDITY   = 1e18; // matches bridge-script: 0.00684 ETH + 68.4 FJ
    uint256 constant ETH_SEED              = 0.05 ether; // matches bridge-script (covers price drift; excess swept)
    uint256 constant FEE_MINT_COUNT        = 1; // 1 x 1000 FJ (1e18 liquidity needs 68.4 FJ)

    // ── ERC20/WETH pool params (must match index-devnet.ts / seed-pools.ts) ──
    uint160 constant ERC20_WETH_SQRT_PRICE  = 1728916962386276374966316084832192;
    int24   constant ERC20_WETH_TICK_LOWER  = 169800;
    int24   constant ERC20_WETH_TICK_UPPER  = 229800;
    uint24  constant ERC20_WETH_FEE         = 3000;
    int24   constant ERC20_WETH_TICK_SPACING = 60;
    int256  constant ERC20_WETH_LIQUIDITY   = 1000000000000; // 1e12 — matches bridge-script
    uint256 constant WETH_SEED             = 0.02 ether; // matches bridge-script

    // ── Fuel test params (must match index-devnet.ts) ────────────────
    uint256 constant FUEL_TOTAL_AMOUNT = 1e5;  // 0.1 USDC total (matches bridge-script)
    uint256 constant FUEL_AMOUNT       = 2e4;  // 0.02 USDC swapped to FeeJuice (~0.095 FJ output)

    // ── Deployed in setUp ────────────────────────────────────────────
    TestERC20 usdc;
    UniswapFuelSwap swapper;

    PoolKey ethAztecKey;
    PoolKey usdcWethKey;
    bool usdcWethDir;

    address deployer;

    function setUp() public {
        vm.createSelectFork(vm.envString("SEPOLIA_RPC_URL"));
        deployer = address(this);
        vm.deal(deployer, 5 ether); // realistic devnet budget

        // Deploy a mock USDC (6 decimals, like the real TestERC20 on Sepolia)
        usdc = new TestERC20("Test USDC", "USDC", 6);
    }

    // ═════════════════════════════════════════════════════════════════
    // E2E: Full pool seed + multi-hop swap (mirrors devnet script)
    // ═════════════════════════════════════════════════════════════════

    function test_e2e_seedPoolsAndMultiHopSwap() public {
        // ── Step 1: Seed ETH/AZTEC pool ──────────────────────────────
        _seedEthAztecPool();

        // ── Step 2: Seed USDC/WETH pool ──────────────────────────────
        _seedUsdcWethPool();

        // ── Step 3: Verify pool balances ─────────────────────────────
        uint256 pmFj = IERC20(AZTEC).balanceOf(POOL_MANAGER);
        uint256 pmUsdc = usdc.balanceOf(POOL_MANAGER);
        uint256 pmWeth = IERC20(WETH).balanceOf(POOL_MANAGER);
        uint256 pmEth = POOL_MANAGER.balance;

        assertGt(pmFj, 0, "PoolManager should have FeeJuice after ETH/AZTEC seed");
        assertGt(pmUsdc, 0, "PoolManager should have USDC after USDC/WETH seed");
        assertGt(pmWeth, 0, "PoolManager should have WETH after USDC/WETH seed");
        // ETH balance might not change if ETH was fully consumed as liquidity

        emit log_named_uint("PoolManager FeeJuice", pmFj);
        emit log_named_uint("PoolManager USDC", pmUsdc);
        emit log_named_uint("PoolManager WETH", pmWeth);
        emit log_named_uint("PoolManager ETH", pmEth);

        // ── Step 4: Deploy UniswapFuelSwap ───────────────────────────
        swapper = new UniswapFuelSwap(POOL_MANAGER, AZTEC, WETH);

        // ── Step 5: Multi-hop swap USDC -> WETH -> FeeJuice ───────────
        uint256 swapInput = FUEL_AMOUNT; // 2 USDC (same as fuel test)
        usdc.mint(deployer, swapInput);
        usdc.approve(address(swapper), swapInput);

        // Track pre-swap balances (deployer may hold tokens from pool sweeps)
        uint256 fjBefore = IERC20(AZTEC).balanceOf(deployer);
        uint256 usdcBefore = usdc.balanceOf(deployer);

        PoolKey[] memory path = new PoolKey[](2);
        path[0] = usdcWethKey;
        path[1] = ethAztecKey;

        bool[] memory dirs = new bool[](2);
        dirs[0] = usdcWethDir;
        dirs[1] = true; // ETH(0x0) < AZTEC, selling ETH for AZTEC -> zeroForOne=true

        uint256 output = swapper.swap(address(usdc), swapInput, 0, path, dirs);

        assertGt(output, 0, "Should receive FeeJuice from multi-hop swap");
        assertEq(IERC20(AZTEC).balanceOf(deployer), fjBefore + output, "Deployer FJ should increase by swap output");
        assertEq(usdc.balanceOf(deployer), usdcBefore - swapInput, "Swap USDC should be fully consumed");
        assertEq(usdc.balanceOf(address(swapper)), 0, "No leftover USDC in swapper");
        assertEq(IERC20(AZTEC).balanceOf(address(swapper)), 0, "No leftover AZTEC in swapper");
        assertEq(address(swapper).balance, 0, "No leftover ETH in swapper");

        emit log_named_uint("Swap input (USDC)", swapInput);
        emit log_named_uint("Swap output (FeeJuice)", output);
    }

    // ═════════════════════════════════════════════════════════════════
    // E2E: Pool seed with real PoolSeeder contract
    // ═════════════════════════════════════════════════════════════════

    function test_e2e_poolSeederDeployAndSetup() public {
        // This test uses the actual PoolSeeder contract (from script/SeedUniswapPools.s.sol)
        // to verify it works correctly, since that's what the bridge-script deploys on-chain.

        PoolSeeder seeder = new PoolSeeder(POOL_MANAGER);
        assertEq(address(seeder.pm()), POOL_MANAGER, "PoolSeeder should reference correct PoolManager");
        assertEq(seeder.deployer(), deployer, "PoolSeeder deployer should be test contract");

        // ── ETH/AZTEC via PoolSeeder.setup ───────────────────────────
        // Mint FeeJuice to seeder
        for (uint256 i = 0; i < FEE_MINT_COUNT; i++) {
            IFeeAssetHandler(FEE_ASSET_HANDLER).mint(address(seeder));
        }
        uint256 seederFj = IERC20(AZTEC).balanceOf(address(seeder));
        assertGt(seederFj, 0, "Seeder should have FeeJuice after minting");
        emit log_named_uint("Seeder FeeJuice after mint", seederFj);

        // Build pool key
        PoolKey memory ethKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(AZTEC),
            fee: ETH_AZTEC_FEE,
            tickSpacing: ETH_AZTEC_TICK_SPACING,
            hooks: IHooks(address(0))
        });

        // Setup — initializes pool + adds liquidity
        seeder.setup{value: ETH_SEED}(
            ethKey, ETH_AZTEC_SQRT_PRICE, ETH_AZTEC_TICK_LOWER, ETH_AZTEC_TICK_UPPER, ETH_AZTEC_LIQUIDITY
        );

        // Verify liquidity was added
        uint256 pmFjAfter = IERC20(AZTEC).balanceOf(POOL_MANAGER);
        assertGt(pmFjAfter, 0, "PoolManager should have FeeJuice");

        // Sweep leftovers back to deployer
        uint256 deployerEthBefore = deployer.balance;
        seeder.sweep(address(0));
        seeder.sweep(AZTEC);
        assertGe(deployer.balance, deployerEthBefore, "Deployer should get ETH back from sweep");

        emit log_named_uint("PoolManager FJ after seed", pmFjAfter);
    }

    function test_e2e_poolSeederRevertNotDeployer() public {
        PoolSeeder seeder = new PoolSeeder(POOL_MANAGER);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(AZTEC),
            fee: ETH_AZTEC_FEE,
            tickSpacing: ETH_AZTEC_TICK_SPACING,
            hooks: IHooks(address(0))
        });

        vm.prank(address(0xDEAD));
        vm.expectRevert("not deployer");
        seeder.setup(key, ETH_AZTEC_SQRT_PRICE, ETH_AZTEC_TICK_LOWER, ETH_AZTEC_TICK_UPPER, ETH_AZTEC_LIQUIDITY);
    }

    function test_e2e_poolSeederSweepRevertNotDeployer() public {
        PoolSeeder seeder = new PoolSeeder(POOL_MANAGER);

        vm.prank(address(0xDEAD));
        vm.expectRevert("not deployer");
        seeder.sweep(address(0));
    }

    // ═════════════════════════════════════════════════════════════════
    // E2E: Seed then verify swap fails with too-large amount
    // ═════════════════════════════════════════════════════════════════

    function test_e2e_seedThenRevertOnExcessiveSwap() public {
        _seedEthAztecPool();
        _seedUsdcWethPool();

        swapper = new UniswapFuelSwap(POOL_MANAGER, AZTEC, WETH);

        // Try to swap WAY more than pool liquidity
        uint256 hugeAmount = 1_000_000e6; // 1M USDC
        usdc.mint(deployer, hugeAmount);
        usdc.approve(address(swapper), hugeAmount);

        PoolKey[] memory path = new PoolKey[](2);
        path[0] = usdcWethKey;
        path[1] = ethAztecKey;
        bool[] memory dirs = new bool[](2);
        dirs[0] = usdcWethDir;
        dirs[1] = true;

        // May revert with "partial fill" from either hop or "CurrencyNotSettled" from PM
        vm.expectRevert();
        swapper.swap(address(usdc), hugeAmount, 0, path, dirs);
    }

    // ═════════════════════════════════════════════════════════════════
    // E2E: Seed with same params twice (idempotent pool init)
    // ═════════════════════════════════════════════════════════════════

    function test_e2e_doubleSeedIsIdempotent() public {
        // First seed
        _seedEthAztecPool();
        uint256 pmFjAfterFirst = IERC20(AZTEC).balanceOf(POOL_MANAGER);

        // Second seed (pool already initialized — should add more liquidity)
        _seedEthAztecPool();
        uint256 pmFjAfterSecond = IERC20(AZTEC).balanceOf(POOL_MANAGER);

        assertGt(pmFjAfterSecond, pmFjAfterFirst, "Double seed should add more liquidity");
        emit log_named_uint("FJ after 1st seed", pmFjAfterFirst);
        emit log_named_uint("FJ after 2nd seed", pmFjAfterSecond);
    }

    // ═════════════════════════════════════════════════════════════════
    // E2E: Seed USDC/WETH pool with insufficient tokens -> revert
    // ═════════════════════════════════════════════════════════════════

    function test_e2e_seedRevertOnInsufficientTokens() public {
        PoolSeeder seeder = new PoolSeeder(POOL_MANAGER);

        // Don't fund the seeder with any tokens — setup should revert
        PoolKey memory key = _buildUsdcWethKey();

        // ERC20InsufficientBalance — PoolSeeder has 0 tokens
        vm.expectRevert();
        seeder.setup(key, ERC20_WETH_SQRT_PRICE, ERC20_WETH_TICK_LOWER, ERC20_WETH_TICK_UPPER, ERC20_WETH_LIQUIDITY);
    }

    // ═════════════════════════════════════════════════════════════════
    // E2E: Full flow with exact devnet fuel test amounts
    // ═════════════════════════════════════════════════════════════════

    function test_e2e_fuelTestAmountsWork() public {
        _seedEthAztecPool();
        _seedUsdcWethPool();

        swapper = new UniswapFuelSwap(POOL_MANAGER, AZTEC, WETH);

        // Exact amounts from the devnet fuel tests
        uint256 fuelAmount = FUEL_AMOUNT; // 2 USDC
        usdc.mint(deployer, fuelAmount);
        usdc.approve(address(swapper), fuelAmount);

        PoolKey[] memory path = new PoolKey[](2);
        path[0] = usdcWethKey;
        path[1] = ethAztecKey;
        bool[] memory dirs = new bool[](2);
        dirs[0] = usdcWethDir;
        dirs[1] = true;

        uint256 output = swapper.swap(address(usdc), fuelAmount, 0, path, dirs);
        assertGt(output, 0, "Fuel amount swap should produce FeeJuice output");

        emit log_named_uint("Fuel swap input (USDC)", fuelAmount);
        emit log_named_uint("Fuel swap output (FeeJuice)", output);
        emit log_named_string("Result", "PASS - fuel test amounts work with seeded pools");
    }

    // ═════════════════════════════════════════════════════════════════
    // E2E: Single-hop swap after seeding (WETH -> FeeJuice)
    // ═════════════════════════════════════════════════════════════════

    function test_e2e_singleHopWethToFeeJuice() public {
        _seedEthAztecPool();

        swapper = new UniswapFuelSwap(POOL_MANAGER, AZTEC, WETH);

        uint256 inputAmount = 0.000001 ether; // small — pool has ~68.4 FJ depth at 10000:1
        deal(WETH, deployer, inputAmount);
        IERC20(WETH).approve(address(swapper), inputAmount);

        PoolKey[] memory path = new PoolKey[](1);
        path[0] = ethAztecKey;
        bool[] memory dirs = new bool[](1);
        dirs[0] = true; // selling ETH for AZTEC

        uint256 output = swapper.swap(WETH, inputAmount, 0, path, dirs);
        assertGt(output, 0, "Single-hop WETH -> FeeJuice should work after seeding");

        emit log_named_uint("Single-hop input (WETH)", inputAmount);
        emit log_named_uint("Single-hop output (FeeJuice)", output);
    }

    // ═════════════════════════════════════════════════════════════════
    // INTERNAL: Pool seeding helpers (mirror index-devnet.ts exactly)
    // ═════════════════════════════════════════════════════════════════

    function _seedEthAztecPool() internal {
        PoolSeeder seeder = new PoolSeeder(POOL_MANAGER);

        // Mint FeeJuice to seeder (same as: for (let i = 0; i < FEE_MINT_COUNT; i++) feeHandler.write.mint([seederAddr]))
        for (uint256 i = 0; i < FEE_MINT_COUNT; i++) {
            IFeeAssetHandler(FEE_ASSET_HANDLER).mint(address(seeder));
        }

        // Transfer any deployer FJ to seeder
        uint256 deployerFj = IERC20(AZTEC).balanceOf(deployer);
        if (deployerFj > 0) {
            IERC20(AZTEC).transfer(address(seeder), deployerFj);
        }

        // Build pool key
        ethAztecKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(AZTEC),
            fee: ETH_AZTEC_FEE,
            tickSpacing: ETH_AZTEC_TICK_SPACING,
            hooks: IHooks(address(0))
        });

        // Seed
        seeder.setup{value: ETH_SEED}(
            ethAztecKey, ETH_AZTEC_SQRT_PRICE, ETH_AZTEC_TICK_LOWER, ETH_AZTEC_TICK_UPPER, ETH_AZTEC_LIQUIDITY
        );

        // Sweep
        seeder.sweep(address(0));
        seeder.sweep(AZTEC);
    }

    function _seedUsdcWethPool() internal {
        PoolSeeder seeder = new PoolSeeder(POOL_MANAGER);

        // Mint USDC to deployer then transfer to seeder (same as bridge-script flow)
        uint256 erc20Amount = 100 * (10 ** usdc.decimals()); // 100 USDC (matches bridge-script)
        usdc.mint(deployer, erc20Amount);

        // Wrap ETH to WETH
        IWETH(WETH).deposit{value: WETH_SEED}();

        // Transfer to seeder
        usdc.transfer(address(seeder), erc20Amount);
        IERC20(WETH).transfer(address(seeder), WETH_SEED);

        // Build pool key (currency0 must be < currency1)
        usdcWethKey = _buildUsdcWethKey();
        usdcWethDir = address(usdc) < WETH; // true if USDC is currency0

        // Seed
        seeder.setup(
            usdcWethKey, ERC20_WETH_SQRT_PRICE, ERC20_WETH_TICK_LOWER, ERC20_WETH_TICK_UPPER, ERC20_WETH_LIQUIDITY
        );

        // Sweep
        seeder.sweep(address(usdc));
        seeder.sweep(WETH);
    }

    function _buildUsdcWethKey() internal view returns (PoolKey memory) {
        address c0 = address(usdc) < WETH ? address(usdc) : WETH;
        address c1 = address(usdc) < WETH ? WETH : address(usdc);
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: ERC20_WETH_FEE,
            tickSpacing: ERC20_WETH_TICK_SPACING,
            hooks: IHooks(address(0))
        });
    }

    receive() external payable {}
}
