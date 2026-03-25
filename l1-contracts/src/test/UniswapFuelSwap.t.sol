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
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @notice Minimal mock ERC-20 for multi-hop tests.
contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/**
 * @notice Helper contract that seeds a V4 pool with liquidity via unlock callback.
 *         Supports both ERC-20 and native ETH pools.
 */
contract LiquiditySeeder is IUnlockCallback {
    using SafeERC20 for IERC20;

    IPoolManager public immutable pm;

    constructor(address _pm) {
        pm = IPoolManager(_pm);
    }

    receive() external payable {}

    function seedLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, int256 liquidityDelta) external {
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

        // Settle debts (negative delta = we owe tokens)
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

        // Take credits (positive delta = PoolManager owes us)
        if (d0 > 0) pm.take(key.currency0, address(this), uint256(uint128(d0)));
        if (d1 > 0) pm.take(key.currency1, address(this), uint256(uint128(d1)));

        return "";
    }
}

/**
 * @notice Fork tests for UniswapFuelSwap against Sepolia V4 PoolManager.
 *         Initializes its own pools on the forked PoolManager.
 *
 *         Run: SEPOLIA_RPC_URL=<url> forge test --match-contract UniswapFuelSwapTest -vvv
 */
contract UniswapFuelSwapTest is Test {
    // ── Sepolia addresses ────────────────────────────────────────────
    address constant POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address constant AZTEC = 0x35d0186d1FD53b72996475D965C5Ed171D52b986;

    // ── Pool parameters ──────────────────────────────────────────────
    uint24 constant POOL_FEE = 3000;      // 0.3%
    int24 constant TICK_SPACING = 60;
    uint160 constant INIT_SQRT_PRICE = 79228162514264337593543950336; // 1:1

    UniswapFuelSwap swapper;
    LiquiditySeeder seeder;

    // ERC-20 pool: AZTEC/WETH
    PoolKey poolKey;
    bool zeroForOne;

    // Native ETH pool: ETH/AZTEC
    PoolKey ethFeeKey;
    bool ethFeeZeroForOne;

    address user = address(0xBEEF);
    address attacker = address(0xDEAD);

    function setUp() public {
        vm.createSelectFork(vm.envString("SEPOLIA_RPC_URL"));

        swapper = new UniswapFuelSwap(POOL_MANAGER, AZTEC, WETH);
        seeder = new LiquiditySeeder(POOL_MANAGER);

        // ── ERC-20 pool: AZTEC/WETH ─────────────────────────────────
        (poolKey, zeroForOne) = _buildWethAztecPool();
        try IPoolManager(POOL_MANAGER).initialize(poolKey, INIT_SQRT_PRICE) {} catch {}

        uint256 seed = 100 ether;
        deal(AZTEC, address(seeder), seed);
        deal(WETH, address(seeder), seed);
        seeder.seedLiquidity(poolKey, -600, 600, 10e18);

        // ── Native ETH pool: ETH/AZTEC ──────────────────────────────
        (ethFeeKey, ethFeeZeroForOne) = _buildEthAztecPool();
        try IPoolManager(POOL_MANAGER).initialize(ethFeeKey, INIT_SQRT_PRICE) {} catch {}

        vm.deal(address(seeder), seed);
        deal(AZTEC, address(seeder), seed);
        seeder.seedLiquidity(ethFeeKey, -600, 600, 10e18);
    }

    // ═════════════════════════════════════════════════════════════════
    // SINGLE-HOP ERC-20 TESTS
    // ═════════════════════════════════════════════════════════════════

    function test_singleHopWethToAztec() public {
        uint256 inputAmount = 0.01 ether;
        deal(WETH, user, inputAmount);

        (PoolKey[] memory path, bool[] memory dirs) = _singlePath(poolKey, zeroForOne);

        vm.startPrank(user);
        IERC20(WETH).approve(address(swapper), inputAmount);
        uint256 output = swapper.swap(WETH, inputAmount, 0, path, dirs);
        vm.stopPrank();

        assertGt(output, 0, "Should receive some AZTEC");
        assertEq(IERC20(AZTEC).balanceOf(user), output, "AZTEC balance mismatch");
        assertEq(IERC20(WETH).balanceOf(user), 0, "WETH not fully consumed");
    }

    // ═════════════════════════════════════════════════════════════════
    // SINGLE-HOP NATIVE ETH TESTS
    // ═════════════════════════════════════════════════════════════════

    function test_singleHopNativeEthToAztec() public {
        uint256 inputAmount = 0.01 ether;
        deal(WETH, user, inputAmount);

        (PoolKey[] memory path, bool[] memory dirs) = _singlePath(ethFeeKey, ethFeeZeroForOne);

        vm.startPrank(user);
        IERC20(WETH).approve(address(swapper), inputAmount);
        uint256 output = swapper.swap(WETH, inputAmount, 0, path, dirs);
        vm.stopPrank();

        assertGt(output, 0, "Should receive some AZTEC");
        assertEq(IERC20(AZTEC).balanceOf(user), output, "AZTEC balance mismatch");
        assertEq(IERC20(WETH).balanceOf(user), 0, "WETH not fully consumed");
    }

    // ═════════════════════════════════════════════════════════════════
    // MULTI-HOP TESTS
    // ═════════════════════════════════════════════════════════════════

    function test_multiHopUsdcToWethToAztecViaNativeEth() public {
        // Deploy a mock ERC-20 for the first hop
        MockERC20 usdc = new MockERC20("Mock USDC", "USDC");
        address usdcAddr = address(usdc);

        // Build and initialize USDC/WETH pool
        (PoolKey memory usdcWethKey, bool usdcWethDir) = _buildPoolKey(usdcAddr, WETH);
        IPoolManager(POOL_MANAGER).initialize(usdcWethKey, INIT_SQRT_PRICE);

        // Seed USDC/WETH pool
        uint256 seed = 100 ether;
        usdc.mint(address(seeder), seed);
        deal(WETH, address(seeder), seed);
        seeder.seedLiquidity(usdcWethKey, -600, 600, 10e18);

        // Swap: USDC → WETH → AZTEC (via native ETH/AZTEC pool)
        uint256 inputAmount = 0.01 ether;
        usdc.mint(user, inputAmount);

        PoolKey[] memory path = new PoolKey[](2);
        path[0] = usdcWethKey;
        path[1] = ethFeeKey;
        bool[] memory dirs = new bool[](2);
        dirs[0] = usdcWethDir;
        dirs[1] = ethFeeZeroForOne;

        vm.startPrank(user);
        IERC20(usdcAddr).approve(address(swapper), inputAmount);
        uint256 output = swapper.swap(usdcAddr, inputAmount, 0, path, dirs);
        vm.stopPrank();

        assertGt(output, 0, "Should receive some AZTEC");
        assertEq(IERC20(AZTEC).balanceOf(user), output, "AZTEC balance mismatch");
        assertEq(IERC20(usdcAddr).balanceOf(user), 0, "USDC not fully consumed");
    }

    function test_multiHopUsdcToWethToAztecViaErc20Pool() public {
        MockERC20 usdc = new MockERC20("Mock USDC", "USDC");
        address usdcAddr = address(usdc);

        (PoolKey memory usdcWethKey, bool usdcWethDir) = _buildPoolKey(usdcAddr, WETH);
        IPoolManager(POOL_MANAGER).initialize(usdcWethKey, INIT_SQRT_PRICE);

        uint256 seed = 100 ether;
        usdc.mint(address(seeder), seed);
        deal(WETH, address(seeder), seed);
        seeder.seedLiquidity(usdcWethKey, -600, 600, 10e18);

        // Multi-hop via the WETH/AZTEC ERC-20 pool (not native ETH)
        uint256 inputAmount = 0.01 ether;
        usdc.mint(user, inputAmount);

        PoolKey[] memory path = new PoolKey[](2);
        path[0] = usdcWethKey;
        path[1] = poolKey; // ERC-20 pool
        bool[] memory dirs = new bool[](2);
        dirs[0] = usdcWethDir;
        dirs[1] = zeroForOne;

        vm.startPrank(user);
        IERC20(usdcAddr).approve(address(swapper), inputAmount);
        uint256 output = swapper.swap(usdcAddr, inputAmount, 0, path, dirs);
        vm.stopPrank();

        assertGt(output, 0, "Should receive some AZTEC");
        assertEq(IERC20(AZTEC).balanceOf(user), output, "AZTEC balance mismatch");
    }

    // ═════════════════════════════════════════════════════════════════
    // SLIPPAGE PROTECTION
    // ═════════════════════════════════════════════════════════════════

    function test_respectsMinOutput() public {
        uint256 inputAmount = 0.001 ether;
        deal(WETH, user, inputAmount);

        (PoolKey[] memory path, bool[] memory dirs) = _singlePath(poolKey, zeroForOne);

        vm.startPrank(user);
        IERC20(WETH).approve(address(swapper), inputAmount);
        vm.expectRevert("UniswapFuelSwap: insufficient output");
        swapper.swap(WETH, inputAmount, type(uint256).max, path, dirs);
        vm.stopPrank();
    }

    function test_minOutputPassesWhenSatisfied() public {
        uint256 inputAmount = 0.001 ether;
        deal(WETH, user, inputAmount * 2);

        (PoolKey[] memory path, bool[] memory dirs) = _singlePath(poolKey, zeroForOne);

        vm.startPrank(user);
        IERC20(WETH).approve(address(swapper), inputAmount * 2);

        // First swap to learn actual output
        uint256 output1 = swapper.swap(WETH, inputAmount, 0, path, dirs);
        assertGt(output1, 0);

        // Second swap with reasonable minOutput should succeed
        uint256 output2 = swapper.swap(WETH, inputAmount, 1, path, dirs);
        assertGt(output2, 0);
        vm.stopPrank();
    }

    // ═════════════════════════════════════════════════════════════════
    // INPUT VALIDATION
    // ═════════════════════════════════════════════════════════════════

    function test_revertOnEmptyPath() public {
        PoolKey[] memory path = new PoolKey[](0);
        bool[] memory dirs = new bool[](0);

        vm.prank(user);
        vm.expectRevert("UniswapFuelSwap: empty path");
        swapper.swap(WETH, 1 ether, 0, path, dirs);
    }

    function test_revertOnPathDirectionMismatch() public {
        PoolKey[] memory path = new PoolKey[](1);
        path[0] = poolKey;
        bool[] memory dirs = new bool[](2);

        vm.prank(user);
        vm.expectRevert("UniswapFuelSwap: path/direction mismatch");
        swapper.swap(WETH, 1 ether, 0, path, dirs);
    }

    function test_revertOnZeroInput() public {
        (PoolKey[] memory path, bool[] memory dirs) = _singlePath(poolKey, zeroForOne);

        vm.prank(user);
        vm.expectRevert("UniswapFuelSwap: zero input");
        swapper.swap(WETH, 0, 0, path, dirs);
    }

    function test_revertOnUnauthorizedCallback() public {
        vm.expectRevert("UniswapFuelSwap: unauthorized callback");
        swapper.unlockCallback("");
    }

    // ═════════════════════════════════════════════════════════════════
    // ACCESS CONTROL & SWEEP
    // ═════════════════════════════════════════════════════════════════

    function test_sweepErc20ByOwner() public {
        uint256 amount = 1000;
        deal(WETH, address(swapper), amount);

        address recipient = makeAddr("sweepRecipient");
        swapper.sweep(WETH, recipient);

        assertEq(IERC20(WETH).balanceOf(recipient), amount, "Recipient should receive swept tokens");
        assertEq(IERC20(WETH).balanceOf(address(swapper)), 0, "Swapper should be empty");
    }

    function test_sweepEthByOwner() public {
        uint256 amount = 1 ether;
        vm.deal(address(swapper), amount);

        address recipient = makeAddr("sweepEthRecipient");
        uint256 balBefore = recipient.balance;
        swapper.sweep(address(0), recipient);

        assertEq(recipient.balance - balBefore, amount, "Recipient should receive swept ETH");
        assertEq(address(swapper).balance, 0, "Swapper should have 0 ETH");
    }

    function test_revertSweepNonOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        swapper.sweep(WETH, attacker);
    }

    function test_revertSweepToZeroAddress() public {
        vm.expectRevert("UniswapFuelSwap: zero recipient");
        swapper.sweep(WETH, address(0));
    }

    // ═════════════════════════════════════════════════════════════════
    // OWNERSHIP
    // ═════════════════════════════════════════════════════════════════

    function test_ownerIsDeployer() public view {
        assertEq(swapper.owner(), address(this));
    }

    function test_transferOwnership() public {
        address newOwner = makeAddr("newOwner");
        swapper.transferOwnership(newOwner);

        // Still old owner until accepted
        assertEq(swapper.owner(), address(this));

        vm.prank(newOwner);
        swapper.acceptOwnership();
        assertEq(swapper.owner(), newOwner);
    }

    // ═════════════════════════════════════════════════════════════════
    // CONSTRUCTOR VALIDATION
    // ═════════════════════════════════════════════════════════════════

    function test_revertConstructorZeroPoolManager() public {
        vm.expectRevert("UniswapFuelSwap: zero poolManager");
        new UniswapFuelSwap(address(0), AZTEC, WETH);
    }

    function test_revertConstructorZeroFeeJuice() public {
        vm.expectRevert("UniswapFuelSwap: zero feeJuice");
        new UniswapFuelSwap(POOL_MANAGER, address(0), WETH);
    }

    function test_revertConstructorZeroWeth() public {
        vm.expectRevert("UniswapFuelSwap: zero weth");
        new UniswapFuelSwap(POOL_MANAGER, AZTEC, address(0));
    }

    // ═════════════════════════════════════════════════════════════════
    // EVENT EMISSION
    // ═════════════════════════════════════════════════════════════════

    function test_emitsSwapExecuted() public {
        uint256 inputAmount = 0.01 ether;
        deal(WETH, user, inputAmount);

        (PoolKey[] memory path, bool[] memory dirs) = _singlePath(poolKey, zeroForOne);

        vm.startPrank(user);
        IERC20(WETH).approve(address(swapper), inputAmount);

        vm.expectEmit(true, true, false, false);
        emit UniswapFuelSwap.SwapExecuted(user, WETH, inputAmount, 0); // output checked loosely
        swapper.swap(WETH, inputAmount, 0, path, dirs);
        vm.stopPrank();
    }

    // ═════════════════════════════════════════════════════════════════
    // NO LEFTOVER TOKENS
    // ═════════════════════════════════════════════════════════════════

    function test_noLeftoverTokensAfterSwap() public {
        uint256 inputAmount = 0.01 ether;
        deal(WETH, user, inputAmount);

        (PoolKey[] memory path, bool[] memory dirs) = _singlePath(poolKey, zeroForOne);

        vm.startPrank(user);
        IERC20(WETH).approve(address(swapper), inputAmount);
        swapper.swap(WETH, inputAmount, 0, path, dirs);
        vm.stopPrank();

        assertEq(IERC20(WETH).balanceOf(address(swapper)), 0, "No leftover WETH");
        assertEq(IERC20(AZTEC).balanceOf(address(swapper)), 0, "No leftover AZTEC");
        assertEq(address(swapper).balance, 0, "No leftover ETH");
    }

    function test_noLeftoverTokensAfterNativeEthSwap() public {
        uint256 inputAmount = 0.01 ether;
        deal(WETH, user, inputAmount);

        (PoolKey[] memory path, bool[] memory dirs) = _singlePath(ethFeeKey, ethFeeZeroForOne);

        vm.startPrank(user);
        IERC20(WETH).approve(address(swapper), inputAmount);
        swapper.swap(WETH, inputAmount, 0, path, dirs);
        vm.stopPrank();

        assertEq(IERC20(WETH).balanceOf(address(swapper)), 0, "No leftover WETH");
        assertEq(IERC20(AZTEC).balanceOf(address(swapper)), 0, "No leftover AZTEC");
        assertEq(address(swapper).balance, 0, "No leftover ETH");
    }

    // ═════════════════════════════════════════════════════════════════
    // PARTIAL FILL / INSUFFICIENT LIQUIDITY
    // ═════════════════════════════════════════════════════════════════

    function test_revertOnPartialFillInsufficientLiquidity() public {
        // Attempt to swap more than the pool can handle
        uint256 hugeAmount = 50 ether; // pool only has ~10e18 liquidity
        deal(WETH, user, hugeAmount);

        (PoolKey[] memory path, bool[] memory dirs) = _singlePath(poolKey, zeroForOne);

        vm.startPrank(user);
        IERC20(WETH).approve(address(swapper), hugeAmount);
        vm.expectRevert("UniswapFuelSwap: partial fill (insufficient liquidity)");
        swapper.swap(WETH, hugeAmount, 0, path, dirs);
        vm.stopPrank();
    }

    function test_revertOnPartialFillNativeEth() public {
        uint256 hugeAmount = 50 ether;
        deal(WETH, user, hugeAmount);

        (PoolKey[] memory path, bool[] memory dirs) = _singlePath(ethFeeKey, ethFeeZeroForOne);

        vm.startPrank(user);
        IERC20(WETH).approve(address(swapper), hugeAmount);
        vm.expectRevert("UniswapFuelSwap: partial fill (insufficient liquidity)");
        swapper.swap(WETH, hugeAmount, 0, path, dirs);
        vm.stopPrank();
    }

    // ═════════════════════════════════════════════════════════════════
    // ROUTE VALIDATION
    // ═════════════════════════════════════════════════════════════════

    function test_revertOnFirstHopInputMismatch() public {
        MockERC20 wrongToken = new MockERC20("Wrong", "WRONG");
        uint256 amount = 0.001 ether;
        wrongToken.mint(user, amount);

        // Try to swap WRONG through AZTEC/WETH pool (first hop expects WETH, not WRONG)
        (PoolKey[] memory path, bool[] memory dirs) = _singlePath(poolKey, zeroForOne);

        vm.startPrank(user);
        wrongToken.approve(address(swapper), amount);
        vm.expectRevert("UniswapFuelSwap: first hop input mismatch");
        swapper.swap(address(wrongToken), amount, 0, path, dirs);
        vm.stopPrank();
    }

    function test_revertOnLastHopNotFeeJuice() public {
        // Build a pool where the output is WETH, not FeeJuice
        MockERC20 otherToken = new MockERC20("Other", "OTHER");
        (PoolKey memory badKey,) = _buildPoolKey(address(otherToken), WETH);
        IPoolManager(POOL_MANAGER).initialize(badKey, INIT_SQRT_PRICE);

        uint256 seed = 100 ether;
        otherToken.mint(address(seeder), seed);
        deal(WETH, address(seeder), seed);
        seeder.seedLiquidity(badKey, -600, 600, 10e18);

        uint256 amount = 0.001 ether;
        otherToken.mint(user, amount);

        // Single-hop path where output is WETH, not AZTEC
        PoolKey[] memory path = new PoolKey[](1);
        path[0] = badKey;
        bool[] memory dirs = new bool[](1);
        dirs[0] = address(otherToken) < WETH;

        vm.startPrank(user);
        otherToken.approve(address(swapper), amount);
        vm.expectRevert("UniswapFuelSwap: last hop must output feeJuice");
        swapper.swap(address(otherToken), amount, 0, path, dirs);
        vm.stopPrank();
    }

    function test_revertOnNativeRouteWithNonWethInput() public {
        MockERC20 notWeth = new MockERC20("NotWETH", "NW");
        uint256 amount = 0.001 ether;
        notWeth.mint(user, amount);

        // ethFeeKey has currency0=address(0), so firstInput=address(0) which maps to WETH
        // but we're passing notWeth as inputToken
        (PoolKey[] memory path, bool[] memory dirs) = _singlePath(ethFeeKey, ethFeeZeroForOne);

        vm.startPrank(user);
        notWeth.approve(address(swapper), amount);
        vm.expectRevert("UniswapFuelSwap: native route requires WETH input");
        swapper.swap(address(notWeth), amount, 0, path, dirs);
        vm.stopPrank();
    }

    function test_revertOnInputOverflow() public {
        uint256 overflow = uint256(type(int256).max) + 1;

        (PoolKey[] memory path, bool[] memory dirs) = _singlePath(poolKey, zeroForOne);

        vm.prank(user);
        vm.expectRevert("UniswapFuelSwap: input overflow");
        swapper.swap(WETH, overflow, 0, path, dirs);
    }

    // ═════════════════════════════════════════════════════════════════
    // MULTIPLE SWAPS (state consistency)
    // ═════════════════════════════════════════════════════════════════

    function test_multipleSequentialSwaps() public {
        uint256 inputAmount = 0.001 ether;
        deal(WETH, user, inputAmount * 3);

        (PoolKey[] memory path, bool[] memory dirs) = _singlePath(poolKey, zeroForOne);

        vm.startPrank(user);
        IERC20(WETH).approve(address(swapper), inputAmount * 3);

        uint256 output1 = swapper.swap(WETH, inputAmount, 0, path, dirs);
        uint256 output2 = swapper.swap(WETH, inputAmount, 0, path, dirs);
        uint256 output3 = swapper.swap(WETH, inputAmount, 0, path, dirs);
        vm.stopPrank();

        assertGt(output1, 0, "First swap should produce output");
        assertGt(output2, 0, "Second swap should produce output");
        assertGt(output3, 0, "Third swap should produce output");

        // Each subsequent swap should get slightly less due to price impact
        assertGe(output1, output2, "Price impact: later swaps get less");
        assertGe(output2, output3, "Price impact: later swaps get less");

        // Swapper should be clean after all swaps
        assertEq(IERC20(WETH).balanceOf(address(swapper)), 0, "No leftover WETH");
        assertEq(IERC20(AZTEC).balanceOf(address(swapper)), 0, "No leftover AZTEC");
    }

    // ═════════════════════════════════════════════════════════════════
    // HELPERS
    // ═════════════════════════════════════════════════════════════════

    function _singlePath(PoolKey memory key, bool dir) internal pure returns (PoolKey[] memory, bool[] memory) {
        PoolKey[] memory path = new PoolKey[](1);
        path[0] = key;
        bool[] memory dirs = new bool[](1);
        dirs[0] = dir;
        return (path, dirs);
    }

    function _buildWethAztecPool() internal pure returns (PoolKey memory, bool) {
        // V4 requires currency0 < currency1 numerically
        // AZTEC (0x35d...) < WETH (0xfFf...), so currency0=AZTEC, currency1=WETH
        // zeroForOne=false means selling currency1 (WETH) for currency0 (AZTEC)
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(AZTEC),
            currency1: Currency.wrap(WETH),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
        return (key, false);
    }

    function _buildEthAztecPool() internal pure returns (PoolKey memory, bool) {
        // address(0) < AZTEC, so currency0=ETH, currency1=AZTEC
        // zeroForOne=true means selling currency0 (ETH) for currency1 (AZTEC)
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(AZTEC),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
        return (key, true);
    }

    function _buildPoolKey(address tokenA, address tokenB) internal pure returns (PoolKey memory, bool) {
        (address c0, address c1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
        // zeroForOne = true when selling currency0 (tokenA is the smaller address)
        return (key, tokenA < tokenB);
    }
}
