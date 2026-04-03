// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import "forge-std/Test.sol";
import {SwapBridgeRouter, IUniswapFuelSwap, CleanHandsData, PassportData} from "../SwapBridgeRouter.sol";
import {ISignatureTransfer} from "../interfaces/ISignatureTransfer.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {ERC20} from "@oz/token/ERC20/ERC20.sol";

// ─── Mock Contracts ──────────────────────────────────────────────────

contract MockToken is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice Mock Permit2 that simply transfers tokens using a pre-set approval.
///         For unit testing — real Permit2 signature verification is tested on fork.
contract MockPermit2 is ISignatureTransfer {
    function permitTransferFrom(PermitTransferFrom calldata, SignatureTransferDetails calldata, address, bytes calldata)
        external
        pure
        override
    {
        revert("MockPermit2: use witness transfer");
    }

    function permitWitnessTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32,
        string calldata,
        bytes calldata /* signature */
    ) external override {
        IERC20(permit.permitted.token).transferFrom(owner, transferDetails.to, transferDetails.requestedAmount);
    }
}

/// @notice Mock FeeJuicePortal that receives FeeJuice and returns dummy keys.
///         Records last deposit recipient for test assertions.
contract MockFeeJuicePortal {
    IERC20 public immutable UNDERLYING;
    uint256 private _callCount;
    bytes32 public lastRecipient;
    uint256 public lastAmount;

    constructor(address _underlying) {
        UNDERLYING = IERC20(_underlying);
    }

    function depositToAztecPublic(bytes32 _to, uint256 amount, bytes32)
        external
        returns (bytes32, uint256)
    {
        UNDERLYING.transferFrom(msg.sender, address(this), amount);
        lastRecipient = _to;
        lastAmount = amount;
        _callCount++;
        return (bytes32(_callCount), _callCount);
    }
}

/// @notice Mock TokenPortal that receives tokens and returns dummy keys.
contract MockTokenPortal {
    IERC20 public immutable token;
    uint256 private _callCount;

    constructor(address _token) {
        token = IERC20(_token);
    }

    function depositToAztecPublic(bytes32, uint256 amount, bytes32)
        external
        returns (bytes32, uint256, uint256)
    {
        token.transferFrom(msg.sender, address(this), amount);
        _callCount++;
        return (bytes32(_callCount), _callCount, amount);
    }

    function depositToAztecPrivate(
        uint256 amount,
        bytes32,
        CleanHandsData calldata,
        PassportData calldata
    ) external returns (bytes32, uint256, uint256) {
        token.transferFrom(msg.sender, address(this), amount);
        _callCount++;
        return (bytes32(_callCount), _callCount, amount);
    }

    function depositToAztecPrivateFor(
        address,
        uint256 amount,
        bytes32,
        CleanHandsData calldata,
        PassportData calldata
    ) external returns (bytes32, uint256, uint256) {
        token.transferFrom(msg.sender, address(this), amount);
        _callCount++;
        return (bytes32(_callCount), _callCount, amount);
    }
}

/// @notice Mock UniswapFuelSwap that does a simple 1:1 "swap" for testing.
contract MockSwap {
    MockToken public feeJuice;

    constructor(address _feeJuice) {
        feeJuice = MockToken(_feeJuice);
    }

    function swap(
        address inputToken,
        uint256 inputAmount,
        uint256 minOutput,
        IUniswapFuelSwap.PoolKey[] calldata,
        bool[] calldata
    ) external returns (uint256) {
        IERC20(inputToken).transferFrom(msg.sender, address(this), inputAmount);
        require(inputAmount >= minOutput, "MockSwap: slippage");
        // Mint 1:1 FeeJuice output
        feeJuice.mint(msg.sender, inputAmount);
        return inputAmount;
    }
}

// ─── Test Contract ───────────────────────────────────────────────────

contract SwapBridgeRouterTest is Test {
    MockToken usdc;
    MockToken feeJuice;
    MockPermit2 permit2;
    MockFeeJuicePortal feeJuicePortal;
    MockTokenPortal tokenPortal;
    MockSwap mockSwap;
    SwapBridgeRouter router;

    address user = address(0xBEEF);
    address attacker = address(0xDEAD);

    bytes32 constant AZTEC_RECIPIENT = bytes32(uint256(0x1234));
    bytes32 constant FPC_RECIPIENT = bytes32(uint256(0xFFC0));
    bytes32 constant TOKEN_SECRET = bytes32(uint256(0x5678));
    bytes32 constant FUEL_SECRET = bytes32(uint256(0x9ABC));

    function setUp() public {
        usdc = new MockToken("USDC", "USDC");
        feeJuice = new MockToken("FeeJuice", "FJ");

        permit2 = new MockPermit2();
        feeJuicePortal = new MockFeeJuicePortal(address(feeJuice));
        tokenPortal = new MockTokenPortal(address(usdc));
        mockSwap = new MockSwap(address(feeJuice));

        router = new SwapBridgeRouter(
            address(permit2),
            address(feeJuicePortal),
            address(mockSwap)
        );

        // Fund user with USDC and approve Permit2 (mock permit2 uses transferFrom)
        usdc.mint(user, 1000e6);
        vm.prank(user);
        usdc.approve(address(permit2), type(uint256).max);
    }

    // ═════════════════════════════════════════════════════════════════
    // HAPPY PATH
    // ═════════════════════════════════════════════════════════════════

    function test_bridgeWithFuel() public {
        SwapBridgeRouter.BridgeParams memory p = _defaultBridgeParams(100e6, 10e6);
        SwapBridgeRouter.PermitParams memory permit = _defaultPermitParams();

        vm.prank(user);
        router.bridgeWithFuel(p, permit);

        // Token portal should have received 90e6 USDC
        assertEq(usdc.balanceOf(address(tokenPortal)), 90e6, "TokenPortal balance");
        // FeeJuice portal should have received 10e6 FeeJuice (1:1 mock)
        assertEq(feeJuice.balanceOf(address(feeJuicePortal)), 10e6, "FeeJuicePortal balance");
        // User should have 900e6 remaining
        assertEq(usdc.balanceOf(user), 900e6, "User balance");
        // Router should have nothing left
        assertEq(usdc.balanceOf(address(router)), 0, "Router USDC balance");
        assertEq(feeJuice.balanceOf(address(router)), 0, "Router FJ balance");
    }

    function test_emitsBridgeWithFuelEvent() public {
        SwapBridgeRouter.BridgeParams memory p = _defaultBridgeParams(100e6, 10e6);
        SwapBridgeRouter.PermitParams memory permit = _defaultPermitParams();

        vm.prank(user);
        vm.expectEmit(true, false, false, false);
        emit SwapBridgeRouter.BridgeWithFuel(
            AZTEC_RECIPIENT, bytes32(0), 0, 0, bytes32(0), bytes32(0), 0, 0, bytes32(0)
        );
        router.bridgeWithFuel(p, permit);
    }

    function test_fuelRecipientDiffersFromAztecRecipient() public {
        SwapBridgeRouter.BridgeParams memory p = _defaultBridgeParams(100e6, 10e6);
        p.fuelRecipient = FPC_RECIPIENT; // FPC address, different from aztecRecipient
        SwapBridgeRouter.PermitParams memory permit = _defaultPermitParams();

        vm.prank(user);
        router.bridgeWithFuel(p, permit);

        // FeeJuice portal should have received the fuel with FPC as recipient
        assertEq(feeJuicePortal.lastRecipient(), FPC_RECIPIENT, "Fuel recipient should be FPC");
        assertEq(feeJuicePortal.lastAmount(), 10e6, "Fuel amount");
        // Token portal still receives tokens (bridgeAmount = 90e6)
        assertEq(usdc.balanceOf(address(tokenPortal)), 90e6, "TokenPortal balance");
    }

    function test_fuelRecipientMatchesAztecRecipientForPublicFuel() public {
        SwapBridgeRouter.BridgeParams memory p = _defaultBridgeParams(100e6, 10e6);
        // fuelRecipient = aztecRecipient (default from helper) — public fuel case
        SwapBridgeRouter.PermitParams memory permit = _defaultPermitParams();

        vm.prank(user);
        router.bridgeWithFuel(p, permit);

        assertEq(feeJuicePortal.lastRecipient(), AZTEC_RECIPIENT, "Fuel recipient should be user");
    }

    // ═════════════════════════════════════════════════════════════════
    // INPUT VALIDATION
    // ═════════════════════════════════════════════════════════════════

    function test_revertOnZeroAmount() public {
        SwapBridgeRouter.BridgeParams memory p = _defaultBridgeParams(0, 0);
        SwapBridgeRouter.PermitParams memory permit = _defaultPermitParams();

        vm.prank(user);
        vm.expectRevert("SwapBridgeRouter: zero amount");
        router.bridgeWithFuel(p, permit);
    }

    function test_revertOnFuelEqualToTotal() public {
        SwapBridgeRouter.BridgeParams memory p = _defaultBridgeParams(100e6, 100e6);
        SwapBridgeRouter.PermitParams memory permit = _defaultPermitParams();

        vm.prank(user);
        vm.expectRevert("SwapBridgeRouter: invalid fuelAmount");
        router.bridgeWithFuel(p, permit);
    }

    function test_revertOnFuelGreaterThanTotal() public {
        SwapBridgeRouter.BridgeParams memory p = _defaultBridgeParams(100e6, 200e6);
        SwapBridgeRouter.PermitParams memory permit = _defaultPermitParams();

        vm.prank(user);
        vm.expectRevert("SwapBridgeRouter: invalid fuelAmount");
        router.bridgeWithFuel(p, permit);
    }

    function test_revertOnEmptyPath() public {
        SwapBridgeRouter.BridgeParams memory p = _defaultBridgeParams(100e6, 10e6);
        p.path = new IUniswapFuelSwap.PoolKey[](0);
        p.zeroForOnes = new bool[](0);
        SwapBridgeRouter.PermitParams memory permit = _defaultPermitParams();

        vm.prank(user);
        vm.expectRevert("SwapBridgeRouter: empty path");
        router.bridgeWithFuel(p, permit);
    }

    function test_revertOnPathDirectionMismatch() public {
        SwapBridgeRouter.BridgeParams memory p = _defaultBridgeParams(100e6, 10e6);
        p.zeroForOnes = new bool[](2); // mismatch: path has 1, dirs has 2
        SwapBridgeRouter.PermitParams memory permit = _defaultPermitParams();

        vm.prank(user);
        vm.expectRevert("SwapBridgeRouter: path/direction mismatch");
        router.bridgeWithFuel(p, permit);
    }

    function test_revertOnZeroTokenPortal() public {
        SwapBridgeRouter.BridgeParams memory p = _defaultBridgeParams(100e6, 10e6);
        p.tokenPortal = address(0);
        SwapBridgeRouter.PermitParams memory permit = _defaultPermitParams();

        vm.prank(user);
        vm.expectRevert("SwapBridgeRouter: zero tokenPortal");
        router.bridgeWithFuel(p, permit);
    }

    // ═════════════════════════════════════════════════════════════════
    // GOVERNANCE — setSwapTarget
    // ═════════════════════════════════════════════════════════════════

    function test_setSwapTargetByOwner() public {
        address newTarget = makeAddr("newSwapTarget");

        vm.expectEmit(true, true, false, false);
        emit SwapBridgeRouter.SwapTargetUpdated(address(mockSwap), newTarget);
        router.setSwapTarget(newTarget);

        assertEq(address(router.swapTarget()), newTarget);
    }

    function test_revertSetSwapTargetByNonOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        router.setSwapTarget(makeAddr("newTarget"));
    }

    function test_revertSetSwapTargetToZero() public {
        vm.expectRevert("SwapBridgeRouter: zero swapTarget");
        router.setSwapTarget(address(0));
    }

    // ═════════════════════════════════════════════════════════════════
    // OWNERSHIP
    // ═════════════════════════════════════════════════════════════════

    function test_ownerIsDeployer() public view {
        assertEq(router.owner(), address(this));
    }

    function test_transferOwnership2Step() public {
        address newOwner = makeAddr("newOwner");
        router.transferOwnership(newOwner);
        assertEq(router.owner(), address(this)); // still old
        vm.prank(newOwner);
        router.acceptOwnership();
        assertEq(router.owner(), newOwner);
    }

    // ═════════════════════════════════════════════════════════════════
    // SWEEP
    // ═════════════════════════════════════════════════════════════════

    function test_sweepErc20() public {
        usdc.mint(address(router), 100e6);
        address recipient = makeAddr("recipient");

        router.sweep(address(usdc), recipient);
        assertEq(usdc.balanceOf(recipient), 100e6);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_sweepEth() public {
        vm.deal(address(router), 1 ether);
        address recipient = makeAddr("recipient");

        router.sweep(address(0), recipient);
        assertEq(recipient.balance, 1 ether);
    }

    function test_revertSweepNonOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        router.sweep(address(usdc), attacker);
    }

    function test_revertSweepToZero() public {
        vm.expectRevert("SwapBridgeRouter: zero recipient");
        router.sweep(address(usdc), address(0));
    }

    // ═════════════════════════════════════════════════════════════════
    // CONSTRUCTOR VALIDATION
    // ═════════════════════════════════════════════════════════════════

    function test_revertConstructorZeroPermit2() public {
        vm.expectRevert("SwapBridgeRouter: zero permit2");
        new SwapBridgeRouter(address(0), address(feeJuicePortal), address(mockSwap));
    }

    function test_revertConstructorZeroPortal() public {
        vm.expectRevert("SwapBridgeRouter: zero feeJuicePortal");
        new SwapBridgeRouter(address(permit2), address(0), address(mockSwap));
    }

    function test_revertConstructorZeroSwapTarget() public {
        vm.expectRevert("SwapBridgeRouter: zero swapTarget");
        new SwapBridgeRouter(address(permit2), address(feeJuicePortal), address(0));
    }

    // ═════════════════════════════════════════════════════════════════
    // NO LEFTOVER TOKENS
    // ═════════════════════════════════════════════════════════════════

    function test_noLeftoverTokensAfterBridge() public {
        SwapBridgeRouter.BridgeParams memory p = _defaultBridgeParams(100e6, 10e6);
        SwapBridgeRouter.PermitParams memory permit = _defaultPermitParams();

        vm.prank(user);
        router.bridgeWithFuel(p, permit);

        assertEq(usdc.balanceOf(address(router)), 0, "No leftover USDC");
        assertEq(feeJuice.balanceOf(address(router)), 0, "No leftover FeeJuice");
    }

    // ═════════════════════════════════════════════════════════════════
    // BRIDGE (non-fuel, public)
    // ═════════════════════════════════════════════════════════════════

    function test_bridgePublic() public {
        SwapBridgeRouter.SimpleBridgeParams memory p = SwapBridgeRouter.SimpleBridgeParams({
            tokenPortal: address(tokenPortal),
            bridgeToken: address(usdc),
            amount: 100e6,
            aztecRecipient: AZTEC_RECIPIENT,
            secretHash: TOKEN_SECRET,
            isPrivate: false,
            cleanHands: _emptyCleanHands(),
            passport: _emptyPassport()
        });
        SwapBridgeRouter.PermitParams memory permit = _defaultPermitParams();

        vm.prank(user);
        router.bridge(p, permit);

        // Token portal should have received 100e6 USDC
        assertEq(usdc.balanceOf(address(tokenPortal)), 100e6, "TokenPortal balance");
        // User should have 900e6 remaining
        assertEq(usdc.balanceOf(user), 900e6, "User balance");
        // Router should have nothing left
        assertEq(usdc.balanceOf(address(router)), 0, "Router USDC balance");
    }

    function test_emitsBridgeEvent() public {
        SwapBridgeRouter.SimpleBridgeParams memory p = SwapBridgeRouter.SimpleBridgeParams({
            tokenPortal: address(tokenPortal),
            bridgeToken: address(usdc),
            amount: 100e6,
            aztecRecipient: AZTEC_RECIPIENT,
            secretHash: TOKEN_SECRET,
            isPrivate: false,
            cleanHands: _emptyCleanHands(),
            passport: _emptyPassport()
        });
        SwapBridgeRouter.PermitParams memory permit = _defaultPermitParams();

        vm.prank(user);
        vm.expectEmit(true, false, false, false);
        emit SwapBridgeRouter.Bridge(AZTEC_RECIPIENT, bytes32(0), 0, 0, bytes32(0));
        router.bridge(p, permit);
    }

    function test_bridgeRevertOnZeroAmount() public {
        SwapBridgeRouter.SimpleBridgeParams memory p = SwapBridgeRouter.SimpleBridgeParams({
            tokenPortal: address(tokenPortal),
            bridgeToken: address(usdc),
            amount: 0,
            aztecRecipient: AZTEC_RECIPIENT,
            secretHash: TOKEN_SECRET,
            isPrivate: false,
            cleanHands: _emptyCleanHands(),
            passport: _emptyPassport()
        });
        SwapBridgeRouter.PermitParams memory permit = _defaultPermitParams();

        vm.prank(user);
        vm.expectRevert("SwapBridgeRouter: zero amount");
        router.bridge(p, permit);
    }

    function test_bridgeRevertOnZeroPortal() public {
        SwapBridgeRouter.SimpleBridgeParams memory p = SwapBridgeRouter.SimpleBridgeParams({
            tokenPortal: address(0),
            bridgeToken: address(usdc),
            amount: 100e6,
            aztecRecipient: AZTEC_RECIPIENT,
            secretHash: TOKEN_SECRET,
            isPrivate: false,
            cleanHands: _emptyCleanHands(),
            passport: _emptyPassport()
        });
        SwapBridgeRouter.PermitParams memory permit = _defaultPermitParams();

        vm.prank(user);
        vm.expectRevert("SwapBridgeRouter: zero tokenPortal");
        router.bridge(p, permit);
    }

    function test_noLeftoverTokensAfterBridge_simple() public {
        SwapBridgeRouter.SimpleBridgeParams memory p = SwapBridgeRouter.SimpleBridgeParams({
            tokenPortal: address(tokenPortal),
            bridgeToken: address(usdc),
            amount: 100e6,
            aztecRecipient: AZTEC_RECIPIENT,
            secretHash: TOKEN_SECRET,
            isPrivate: false,
            cleanHands: _emptyCleanHands(),
            passport: _emptyPassport()
        });
        SwapBridgeRouter.PermitParams memory permit = _defaultPermitParams();

        vm.prank(user);
        router.bridge(p, permit);

        assertEq(usdc.balanceOf(address(router)), 0, "No leftover USDC");
    }

    // ═════════════════════════════════════════════════════════════════
    // BRIDGE (private)
    // ═════════════════════════════════════════════════════════════════

    function test_bridgePrivate() public {
        SwapBridgeRouter.SimpleBridgeParams memory p = SwapBridgeRouter.SimpleBridgeParams({
            tokenPortal: address(tokenPortal),
            bridgeToken: address(usdc),
            amount: 50e6,
            aztecRecipient: AZTEC_RECIPIENT,
            secretHash: TOKEN_SECRET,
            isPrivate: true,
            cleanHands: _emptyCleanHands(),
            passport: _emptyPassport()
        });
        SwapBridgeRouter.PermitParams memory permit = _defaultPermitParams();

        vm.prank(user);
        router.bridge(p, permit);

        assertEq(usdc.balanceOf(address(tokenPortal)), 50e6, "TokenPortal balance (private)");
        assertEq(usdc.balanceOf(user), 950e6, "User balance (private)");
        assertEq(usdc.balanceOf(address(router)), 0, "Router balance (private)");
    }

    function test_bridgeWithFuelPrivate() public {
        SwapBridgeRouter.BridgeParams memory p = _defaultBridgeParams(100e6, 10e6);
        p.isPrivate = true;
        SwapBridgeRouter.PermitParams memory permit = _defaultPermitParams();

        vm.prank(user);
        router.bridgeWithFuel(p, permit);

        // Token portal should have received 90e6 USDC (via depositToAztecPrivate)
        assertEq(usdc.balanceOf(address(tokenPortal)), 90e6, "TokenPortal balance (private fuel)");
        // FeeJuice portal should have received 10e6 FeeJuice (1:1 mock)
        assertEq(feeJuice.balanceOf(address(feeJuicePortal)), 10e6, "FeeJuicePortal balance (private fuel)");
        // Router should have nothing left
        assertEq(usdc.balanceOf(address(router)), 0, "Router USDC balance (private fuel)");
        assertEq(feeJuice.balanceOf(address(router)), 0, "Router FJ balance (private fuel)");
    }

    // ═════════════════════════════════════════════════════════════════
    // HELPERS
    // ═════════════════════════════════════════════════════════════════

    function _emptyCleanHands() internal pure returns (CleanHandsData memory) {
        return CleanHandsData({ nonce: 0, signature: "" });
    }

    function _emptyPassport() internal pure returns (PassportData memory) {
        return PassportData({ maxAmount: 0, nonce: 0, deadline: 0, signature: "" });
    }

    function _defaultBridgeParams(uint256 total, uint256 fuel)
        internal
        view
        returns (SwapBridgeRouter.BridgeParams memory)
    {
        IUniswapFuelSwap.PoolKey[] memory path = new IUniswapFuelSwap.PoolKey[](1);
        path[0] = IUniswapFuelSwap.PoolKey({
            currency0: address(0),
            currency1: address(feeJuice),
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
        bool[] memory dirs = new bool[](1);
        dirs[0] = true;

        return SwapBridgeRouter.BridgeParams({
            tokenPortal: address(tokenPortal),
            bridgeToken: address(usdc),
            totalAmount: total,
            fuelAmount: fuel,
            aztecRecipient: AZTEC_RECIPIENT,
            fuelRecipient: AZTEC_RECIPIENT,
            tokenSecretHash: TOKEN_SECRET,
            fuelSecretHash: FUEL_SECRET,
            minFuelOutput: 0,
            path: path,
            zeroForOnes: dirs,
            isPrivate: false,
            cleanHands: _emptyCleanHands(),
            passport: _emptyPassport()
        });
    }

    function _defaultPermitParams()
        internal
        pure
        returns (SwapBridgeRouter.PermitParams memory)
    {
        return SwapBridgeRouter.PermitParams({
            nonce: 0,
            deadline: type(uint256).max,
            signature: "" // MockPermit2 ignores signatures
        });
    }
}
