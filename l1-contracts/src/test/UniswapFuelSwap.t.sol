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

/// @notice Minimal ERC-20 for multi-hop tests.
contract MockERC20 is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/**
 * @notice Helper contract that seeds a V4 pool with liquidity inside an unlock callback.
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

        // Settle debts: negative delta = we owe tokens to PoolManager
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

        // Take credits: positive delta = PoolManager owes us tokens (refund)
        if (d0 > 0) pm.take(key.currency0, address(this), uint256(uint128(d0)));
        if (d1 > 0) pm.take(key.currency1, address(this), uint256(uint128(d1)));

        return "";
    }
}

/**
 * @notice Fork tests for UniswapFuelSwap against Sepolia.
 * Initializes its own pools on the forked PoolManager.
 * Run: SEPOLIA_RPC_URL=<url> forge test --match-contract UniswapFuelSwapTest -vvv
 */
contract UniswapFuelSwapTest is Test {
    // Sepolia addresses
    address constant POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address constant AZTEC = 0x35d0186d1FD53b72996475D965C5Ed171D52b986;

    // Pool parameters for the test pools
    uint24 constant POOL_FEE = 3000; // 0.3%
    int24 constant TICK_SPACING = 60;

    UniswapFuelSwap swapper;
    LiquiditySeeder seeder;

    // ERC-20 pool: AZTEC/WETH
    PoolKey poolKey;
    bool zeroForOne;

    // Native ETH pool: ETH/AZTEC
    PoolKey ethFeeKey;
    bool ethFeeZeroForOne;

    address user = address(0xBEEF);

    function setUp() public {
        vm.createSelectFork(vm.envString("SEPOLIA_RPC_URL"));

        swapper = new UniswapFuelSwap(POOL_MANAGER, AZTEC, WETH);
        seeder = new LiquiditySeeder(POOL_MANAGER);

        // ── ERC-20 pool: AZTEC/WETH ──────────────────────────────────
        (poolKey, zeroForOne) = _buildWethAztecPool();
        IPoolManager(POOL_MANAGER).initialize(poolKey, 79228162514264337593543950336);

        uint256 seed = 100 ether;
        deal(AZTEC, address(seeder), seed);
        deal(WETH, address(seeder), seed);
        seeder.seedLiquidity(poolKey, -600, 600, 10e18);

        // ── Native ETH pool: ETH/AZTEC ──────────────────────────────
        (ethFeeKey, ethFeeZeroForOne) = _buildEthAztecPool();
        IPoolManager(POOL_MANAGER).initialize(ethFeeKey, 79228162514264337593543950336);

        vm.deal(address(seeder), seed);
        deal(AZTEC, address(seeder), seed);
        seeder.seedLiquidity(ethFeeKey, -600, 600, 10e18);
    }

    // ── ERC-20 Tests (regression) ────────────────────────────────────

    function test_singleHopWethToAztec() public {
        uint256 inputAmount = 0.01 ether;
        deal(WETH, user, inputAmount);

        PoolKey[] memory path = new PoolKey[](1);
        path[0] = poolKey;
        bool[] memory dirs = new bool[](1);
        dirs[0] = zeroForOne;

        vm.startPrank(user);
        IERC20(WETH).approve(address(swapper), inputAmount);
        uint256 output = swapper.swap(WETH, inputAmount, 0, path, dirs);
        vm.stopPrank();

        assertGt(output, 0, "Should receive some AZTEC");
        assertEq(IERC20(AZTEC).balanceOf(user), output, "AZTEC should be in user balance");
        assertEq(IERC20(WETH).balanceOf(user), 0, "All WETH should be consumed");
    }

    function test_respectsMinOutput() public {
        uint256 inputAmount = 0.001 ether;
        deal(WETH, user, inputAmount);

        PoolKey[] memory path = new PoolKey[](1);
        path[0] = poolKey;
        bool[] memory dirs = new bool[](1);
        dirs[0] = zeroForOne;

        vm.startPrank(user);
        IERC20(WETH).approve(address(swapper), inputAmount);

        // First, do a swap with minOutput=0 to see what we get
        uint256 output = swapper.swap(WETH, inputAmount, 0, path, dirs);
        vm.stopPrank();

        assertGt(output, 0, "Should get some output");

        // Now try again with an impossibly high minOutput
        deal(WETH, user, inputAmount);
        vm.startPrank(user);
        IERC20(WETH).approve(address(swapper), inputAmount);
        vm.expectRevert("UniswapFuelSwap: insufficient output");
        swapper.swap(WETH, inputAmount, type(uint256).max, path, dirs);
        vm.stopPrank();
    }

    function test_revertOnUnauthorizedCallback() public {
        vm.expectRevert("UniswapFuelSwap: unauthorized callback");
        swapper.unlockCallback("");
    }

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

    function test_sweepByOwner() public {
        uint256 amount = 1000;
        deal(WETH, address(swapper), amount);

        address recipient = makeAddr("sweepRecipient");
        uint256 balBefore = IERC20(WETH).balanceOf(recipient);
        swapper.sweep(WETH, recipient);
        uint256 balAfter = IERC20(WETH).balanceOf(recipient);

        assertEq(balAfter - balBefore, amount, "Recipient should receive swept amount");
        assertEq(IERC20(WETH).balanceOf(address(swapper)), 0, "Swapper should have 0");
    }

    function test_sweepEthByOwner() public {
        uint256 amount = 1 ether;
        vm.deal(address(swapper), amount);

        address recipient = makeAddr("sweepEthRecipient");
        uint256 balBefore = recipient.balance;
        swapper.sweep(address(0), recipient);
        uint256 balAfter = recipient.balance;

        assertEq(balAfter - balBefore, amount, "Recipient should receive swept ETH");
        assertEq(address(swapper).balance, 0, "Swapper should have 0 ETH");
    }

    function test_revertSweepNonOwner() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert("UniswapFuelSwap: not owner");
        swapper.sweep(WETH, address(0xDEAD));
    }

    // ── Native ETH Tests ─────────────────────────────────────────────

    function test_singleHopNativeEthToFee() public {
        uint256 inputAmount = 0.01 ether;
        deal(WETH, user, inputAmount);

        PoolKey[] memory path = new PoolKey[](1);
        path[0] = ethFeeKey;
        bool[] memory dirs = new bool[](1);
        dirs[0] = ethFeeZeroForOne;

        vm.startPrank(user);
        IERC20(WETH).approve(address(swapper), inputAmount);
        uint256 output = swapper.swap(WETH, inputAmount, 0, path, dirs);
        vm.stopPrank();

        assertGt(output, 0, "Should receive some AZTEC");
        assertEq(IERC20(AZTEC).balanceOf(user), output, "AZTEC should be in user balance");
        assertEq(IERC20(WETH).balanceOf(user), 0, "All WETH should be consumed");
    }

    function test_multiHopTokenToFeeViaNativeEth() public {
        // Deploy a mock ERC-20 for the first hop
        MockERC20 usdc = new MockERC20();
        address usdcAddr = address(usdc);

        // Build and initialize USDC/WETH pool
        (PoolKey memory usdcWethKey, bool usdcWethDir) = _buildPoolKey(usdcAddr, WETH);
        IPoolManager(POOL_MANAGER).initialize(usdcWethKey, 79228162514264337593543950336);

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
        assertEq(IERC20(AZTEC).balanceOf(user), output, "AZTEC should be in user balance");
        assertEq(IERC20(usdcAddr).balanceOf(user), 0, "All USDC should be consumed");
    }

    // ── Helpers ──────────────────────────────────────────────────────

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
        // zeroForOne = true when selling currency0 (= tokenA is the smaller address and we're selling tokenA)
        bool dir = tokenA < tokenB;
        return (key, dir);
    }
}
