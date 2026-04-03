// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test, console2} from "forge-std/Test.sol";
import {TokenPortal} from "../TokenPortal.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {ERC20Mock} from "@oz/mocks/token/ERC20Mock.sol";

// Custom errors from TokenPortal
error AlreadyInitialized();
error InvalidAddress();
error FeeTooHigh();
error NoFeesToWithdraw();
error InvalidVerification();
error PassportNonceUsed();
error CleanHandsNonceUsed();
error InvalidPassportSignature();
error AmountExceedsLimit();
error Unauthorized();
error NoPendingOwner();
error NotTrustedForwarder();
error DepositsPaused();

// Mock contracts for Aztec dependencies
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";

contract MockRegistry {
    address public rollup;

    constructor(address _rollup) {
        rollup = _rollup;
    }

    function getCanonicalRollup() external view returns (address) {
        return rollup;
    }
}

contract MockRollup {
    address public outboxAddr;
    address public inboxAddr;
    uint256 public version;

    constructor(address _outbox, address _inbox, uint256 _version) {
        outboxAddr = _outbox;
        inboxAddr = _inbox;
        version = _version;
    }

    function getOutbox() external view returns (IOutbox) {
        return IOutbox(outboxAddr);
    }

    function getInbox() external view returns (IInbox) {
        return IInbox(inboxAddr);
    }

    function getVersion() external view returns (uint256) {
        return version;
    }
}

contract MockInbox {
    uint256 private messageCount;

    function sendL2Message(DataStructures.L2Actor memory, bytes32, bytes32) external returns (bytes32, uint256) {
        messageCount++;
        return (keccak256(abi.encodePacked(messageCount)), messageCount);
    }
}

contract MockOutbox {
    mapping(bytes32 => bool) public consumed;

    function consume(DataStructures.L2ToL1Msg memory message, uint256, uint256, bytes32[] calldata) external {
        bytes32 messageHash = keccak256(abi.encode(message));
        require(!consumed[messageHash], "Already consumed");
        consumed[messageHash] = true;
    }
}

contract TokenPortalTest is Test {
    TokenPortal public portal;
    ERC20Mock public token;
    MockRegistry public registry;
    MockRollup public rollup;
    MockInbox public inbox;
    MockOutbox public outbox;

    address public deployer;
    address public owner;
    address public feeRecipient;
    address public humanIdAttester;
    address public passportSigner;
    address public user;
    address public newOwner;

    uint256 public attesterPrivateKey;
    uint256 public passportSignerPrivateKey;
    uint256 public constant FEE_BASIS_POINTS = 100; // 1%
    uint256 public constant CLEAN_HANDS_CIRCUIT_ID = 0x1c98fc4f7f1ad3805aefa81ad25fa466f8342292accf69566b43691d12742a19;
    uint256 public constant CLEAN_HANDS_ACTION_ID = 123456789;
    bytes32 public constant L2_BRIDGE = bytes32(uint256(0x123));
    uint256 public constant ROLLUP_VERSION = 1;

    event Initialized(address indexed registry, address indexed underlying, bytes32 l2Bridge);
    event DepositToAztecPublic(
        bytes32 indexed to, uint256 amount, uint256 fee, bytes32 secretHash, bytes32 key, uint256 index
    );
    event DepositToAztecPrivate(uint256 amount, uint256 fee, bytes32 secretHash, bytes32 key, uint256 index);
    event FeeUpdated(uint256 newFeeBasisPoints);
    event FeeRecipientUpdated(address indexed newFeeRecipient);
    event FeesWithdrawn(address indexed recipient, uint256 amount);
    event TokensRescued(address indexed token, address indexed to, uint256 amount);
    event AttestationConfigUpdated(address indexed attester, uint256 circuitId, uint256 actionId, address indexed signer);
    event TrustedForwarderUpdated(address indexed forwarder, bool trusted);
    event OwnershipTransferProposed(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferCancelled(address indexed currentOwner);
    event DepositsBlocked();
    event DepositsUnblocked();

    function setUp() public {
        deployer = address(this);
        owner = makeAddr("owner");
        feeRecipient = makeAddr("feeRecipient");
        user = makeAddr("user");
        newOwner = makeAddr("newOwner");

        attesterPrivateKey = 0xA11CE;
        humanIdAttester = vm.addr(attesterPrivateKey);

        passportSignerPrivateKey = 0xB0B;
        passportSigner = vm.addr(passportSignerPrivateKey);

        // Deploy mocks
        token = new ERC20Mock();
        outbox = new MockOutbox();
        inbox = new MockInbox();
        rollup = new MockRollup(address(outbox), address(inbox), ROLLUP_VERSION);
        registry = new MockRegistry(address(rollup));

        // Deploy portal
        portal = new TokenPortal(
            owner, feeRecipient, FEE_BASIS_POINTS, humanIdAttester, CLEAN_HANDS_CIRCUIT_ID, CLEAN_HANDS_ACTION_ID, passportSigner
        );

        // Initialize portal
        portal.initialize(address(registry), address(token), L2_BRIDGE);

        // Setup token balances
        token.mint(user, 1000000 ether);
        vm.prank(user);
        token.approve(address(portal), type(uint256).max);
    }

    // ─── Signing Helpers ────────────────────────────────────────────────────────

    function _signCleanHands(uint256 nonce, uint256 actionId, address signer)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = keccak256(abi.encodePacked(nonce, CLEAN_HANDS_CIRCUIT_ID, actionId, signer));
        bytes32 personalSignPreimage = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPrivateKey, personalSignPreimage);
        return abi.encodePacked(r, s, v);
    }

    function _signCleanHandsWithKey(uint256 nonce, uint256 actionId, address signer, uint256 privateKey)
        internal
        pure
        returns (bytes memory)
    {
        bytes32 digest = keccak256(abi.encodePacked(nonce, CLEAN_HANDS_CIRCUIT_ID, actionId, signer));
        bytes32 personalSignPreimage = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, personalSignPreimage);
        return abi.encodePacked(r, s, v);
    }

    function _signPassport(address depositor, uint256 maxAmount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 messageHash = keccak256(abi.encodePacked(depositor, maxAmount, nonce, deadline, address(portal)));
        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(passportSignerPrivateKey, ethSignedMessageHash);
        return abi.encodePacked(r, s, v);
    }

    function _signPassportWithKey(address depositor, uint256 maxAmount, uint256 nonce, uint256 deadline, uint256 privateKey)
        internal
        view
        returns (bytes memory)
    {
        bytes32 messageHash = keccak256(abi.encodePacked(depositor, maxAmount, nonce, deadline, address(portal)));
        bytes32 ethSignedMessageHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, ethSignedMessageHash);
        return abi.encodePacked(r, s, v);
    }

    function _makeCleanHands(uint256 nonce, address signer)
        internal
        view
        returns (TokenPortal.CleanHandsData memory, TokenPortal.PassportData memory)
    {
        return (
            TokenPortal.CleanHandsData({nonce: nonce, signature: _signCleanHands(nonce, CLEAN_HANDS_ACTION_ID, signer)}),
            TokenPortal.PassportData({maxAmount: 0, nonce: 0, deadline: 0, signature: ""})
        );
    }

    function _makePassport(address depositor, uint256 nonce, uint256 maxAmount)
        internal
        view
        returns (TokenPortal.CleanHandsData memory, TokenPortal.PassportData memory)
    {
        uint256 deadline = block.timestamp + 1 hours;
        return (
            TokenPortal.CleanHandsData({nonce: 0, signature: ""}),
            TokenPortal.PassportData({maxAmount: maxAmount, nonce: nonce, deadline: deadline, signature: _signPassport(depositor, maxAmount, nonce, deadline)})
        );
    }

    // =============================================================
    // CONSTRUCTOR TESTS
    // =============================================================

    function test_Constructor() public view {
        assertEq(portal.owner(), owner);
        assertEq(portal.feeRecipient(), feeRecipient);
        assertEq(portal.feeBasisPoints(), FEE_BASIS_POINTS);
        assertEq(portal.humanIdAttester(), humanIdAttester);
        assertEq(portal.cleanHandsCircuitId(), CLEAN_HANDS_CIRCUIT_ID);
        assertEq(portal.passportSigner(), passportSigner);
    }

    function test_Constructor_RevertWhen_InvalidFeeRecipient() public {
        vm.expectRevert(InvalidAddress.selector);
        new TokenPortal(owner, address(0), FEE_BASIS_POINTS, humanIdAttester, CLEAN_HANDS_CIRCUIT_ID, CLEAN_HANDS_ACTION_ID, passportSigner);
    }

    function test_Constructor_RevertWhen_FeeTooHigh() public {
        vm.expectRevert(FeeTooHigh.selector);
        new TokenPortal(owner, feeRecipient, 1001, humanIdAttester, CLEAN_HANDS_CIRCUIT_ID, CLEAN_HANDS_ACTION_ID, passportSigner);
    }

    // =============================================================
    // INITIALIZATION TESTS
    // =============================================================

    function test_Initialize() public {
        TokenPortal newPortal = new TokenPortal(
            owner, feeRecipient, FEE_BASIS_POINTS, humanIdAttester, CLEAN_HANDS_CIRCUIT_ID, CLEAN_HANDS_ACTION_ID, passportSigner
        );

        vm.expectEmit(true, true, true, true);
        emit Initialized(address(registry), address(token), L2_BRIDGE);

        newPortal.initialize(address(registry), address(token), L2_BRIDGE);

        assertEq(address(newPortal.registry()), address(registry));
        assertEq(address(newPortal.underlying()), address(token));
        assertEq(newPortal.l2Bridge(), L2_BRIDGE);
    }

    function test_Initialize_RevertWhen_NotDeployer() public {
        TokenPortal newPortal = new TokenPortal(
            owner, feeRecipient, FEE_BASIS_POINTS, humanIdAttester, CLEAN_HANDS_CIRCUIT_ID, CLEAN_HANDS_ACTION_ID, passportSigner
        );
        vm.prank(user);
        vm.expectRevert(Unauthorized.selector);
        newPortal.initialize(address(registry), address(token), L2_BRIDGE);
    }

    function test_Initialize_RevertWhen_AlreadyInitialized() public {
        vm.expectRevert(AlreadyInitialized.selector);
        portal.initialize(address(registry), address(token), L2_BRIDGE);
    }

    function test_Initialize_RevertWhen_InvalidRegistryAddress() public {
        TokenPortal p = new TokenPortal(owner, feeRecipient, FEE_BASIS_POINTS, humanIdAttester, CLEAN_HANDS_CIRCUIT_ID, CLEAN_HANDS_ACTION_ID, passportSigner);
        vm.expectRevert(InvalidAddress.selector);
        p.initialize(address(0), address(token), L2_BRIDGE);
    }

    function test_Initialize_RevertWhen_InvalidUnderlyingAddress() public {
        TokenPortal p = new TokenPortal(owner, feeRecipient, FEE_BASIS_POINTS, humanIdAttester, CLEAN_HANDS_CIRCUIT_ID, CLEAN_HANDS_ACTION_ID, passportSigner);
        vm.expectRevert(InvalidAddress.selector);
        p.initialize(address(registry), address(0), L2_BRIDGE);
    }

    function test_Initialize_RevertWhen_InvalidL2Bridge() public {
        TokenPortal p = new TokenPortal(owner, feeRecipient, FEE_BASIS_POINTS, humanIdAttester, CLEAN_HANDS_CIRCUIT_ID, CLEAN_HANDS_ACTION_ID, passportSigner);
        vm.expectRevert(InvalidAddress.selector);
        p.initialize(address(registry), address(token), bytes32(0));
    }

    // =============================================================
    // DEPOSIT TO AZTEC PUBLIC TESTS
    // =============================================================

    function test_DepositToAztecPublic() public {
        uint256 amount = 1000 ether;
        uint256 expectedFee = portal.calculateFee(amount);

        vm.prank(user);
        (bytes32 key, uint256 index, uint256 amountAfterFee) = portal.depositToAztecPublic(bytes32(uint256(0x456)), amount, bytes32(uint256(0x789)));

        assertEq(portal.collectedFees(), expectedFee);
        assertEq(token.balanceOf(address(portal)), amount);
        assertEq(amountAfterFee, amount - expectedFee);
        assertTrue(key != bytes32(0));
        assertEq(index, 1);
    }

    function test_DepositToAztecPublic_ZeroFee() public {
        // Deploy portal with 0% fee
        TokenPortal zeroFeePortal = new TokenPortal(owner, feeRecipient, 0, humanIdAttester, CLEAN_HANDS_CIRCUIT_ID, CLEAN_HANDS_ACTION_ID, passportSigner);
        zeroFeePortal.initialize(address(registry), address(token), L2_BRIDGE);

        token.mint(user, 1000 ether);
        vm.prank(user);
        token.approve(address(zeroFeePortal), type(uint256).max);

        vm.prank(user);
        zeroFeePortal.depositToAztecPublic(bytes32(uint256(1)), 1000 ether, bytes32(0));
        assertEq(zeroFeePortal.collectedFees(), 0);
    }

    function test_DepositToAztecPublic_MultipleDeposits_FeeAccumulation() public {
        vm.startPrank(user);
        portal.depositToAztecPublic(bytes32(uint256(1)), 100 ether, bytes32(0));
        portal.depositToAztecPublic(bytes32(uint256(2)), 200 ether, bytes32(0));
        portal.depositToAztecPublic(bytes32(uint256(3)), 300 ether, bytes32(0));
        vm.stopPrank();

        uint256 expectedFees =
            portal.calculateFee(100 ether) + portal.calculateFee(200 ether) + portal.calculateFee(300 ether);
        assertEq(portal.collectedFees(), expectedFees);
    }

    function test_DepositToAztecPublic_RevertWhen_Paused() public {
        vm.prank(owner);
        portal.pause();

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        portal.depositToAztecPublic(bytes32(0), 100 ether, bytes32(0));
    }

    function test_DepositToAztecPublic_RevertWhen_ZeroAmount() public {
        vm.prank(user);
        vm.expectRevert("Amount must be greater than zero");
        portal.depositToAztecPublic(bytes32(0), 0, bytes32(0));
    }

    // =============================================================
    // DEPOSIT TO AZTEC PRIVATE — CLEAN HANDS
    // =============================================================

    function test_DepositPrivate_CleanHands() public {
        (TokenPortal.CleanHandsData memory ch, TokenPortal.PassportData memory pp) = _makeCleanHands(1, user);

        vm.prank(user);
        portal.depositToAztecPrivate(1000 ether, bytes32(uint256(0x789)), ch, pp);

        assertEq(portal.collectedFees(), portal.calculateFee(1000 ether));
        assertTrue(portal.cleanHandsNonces(user, 1));
    }

    function test_DepositPrivate_CleanHands_RevertWhen_NonceReused() public {
        (TokenPortal.CleanHandsData memory ch, TokenPortal.PassportData memory pp) = _makeCleanHands(1, user);

        vm.prank(user);
        portal.depositToAztecPrivate(100 ether, bytes32(0), ch, pp);

        vm.prank(user);
        vm.expectRevert(CleanHandsNonceUsed.selector);
        portal.depositToAztecPrivate(100 ether, bytes32(0), ch, pp);
    }

    function test_DepositPrivate_CleanHands_RevertWhen_WrongSigner() public {
        // Sign with wrong key — should fail clean hands, then fail passport (no passport sig)
        bytes memory badSig = _signCleanHandsWithKey(1, 100, user, 0xBAD);
        TokenPortal.CleanHandsData memory ch = TokenPortal.CleanHandsData({nonce: 1, signature: badSig});
        TokenPortal.PassportData memory pp = TokenPortal.PassportData({maxAmount: 0, nonce: 0, deadline: 0, signature: ""});

        vm.prank(user);
        vm.expectRevert(InvalidVerification.selector);
        portal.depositToAztecPrivate(100 ether, bytes32(0), ch, pp);
    }

    function test_DepositPrivate_CleanHands_RevertWhen_SignedForDifferentUser() public {
        // Attestation signed for `user` but tx sent from a different address
        address attacker = makeAddr("attacker");
        token.mint(attacker, 1000 ether);
        vm.prank(attacker);
        token.approve(address(portal), type(uint256).max);

        // Sign for `user`, not `attacker`
        (TokenPortal.CleanHandsData memory ch, TokenPortal.PassportData memory pp) = _makeCleanHands(1, user);

        // Attacker sends tx — clean hands signed for `user` won't match `attacker` as depositor
        vm.prank(attacker);
        vm.expectRevert(InvalidVerification.selector);
        portal.depositToAztecPrivate(100 ether, bytes32(0), ch, pp);
    }

    // =============================================================
    // DEPOSIT TO AZTEC PRIVATE — PASSPORT
    // =============================================================

    function test_DepositPrivate_Passport() public {
        (TokenPortal.CleanHandsData memory ch, TokenPortal.PassportData memory pp) = _makePassport(user, 1, 1000 ether);

        vm.prank(user);
        portal.depositToAztecPrivate(500 ether, bytes32(0), ch, pp);

        assertTrue(portal.passportNonces(user, 1));
    }

    function test_DepositPrivate_Passport_RevertWhen_NonceReused() public {
        (TokenPortal.CleanHandsData memory ch, TokenPortal.PassportData memory pp) = _makePassport(user, 1, 1000 ether);

        vm.prank(user);
        portal.depositToAztecPrivate(100 ether, bytes32(0), ch, pp);

        vm.prank(user);
        vm.expectRevert(PassportNonceUsed.selector);
        portal.depositToAztecPrivate(100 ether, bytes32(0), ch, pp);
    }

    function test_DepositPrivate_Passport_RevertWhen_AmountExceedsLimit() public {
        (TokenPortal.CleanHandsData memory ch, TokenPortal.PassportData memory pp) = _makePassport(user, 1, 1000 ether);

        vm.prank(user);
        vm.expectRevert(AmountExceedsLimit.selector);
        portal.depositToAztecPrivate(2000 ether, bytes32(0), ch, pp);
    }

    function test_DepositPrivate_Passport_RevertWhen_Expired() public {
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _signPassport(user, 1000 ether, 1, deadline);
        TokenPortal.CleanHandsData memory ch = TokenPortal.CleanHandsData({nonce: 0, signature: ""});
        TokenPortal.PassportData memory pp = TokenPortal.PassportData({maxAmount: 1000 ether, nonce: 1, deadline: deadline, signature: sig});

        vm.prank(user);
        vm.expectRevert(InvalidPassportSignature.selector);
        portal.depositToAztecPrivate(100 ether, bytes32(0), ch, pp);
    }

    function test_DepositPrivate_Passport_RevertWhen_WrongSigner() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory badSig = _signPassportWithKey(user, 1000 ether, 1, deadline, 0xBAD);
        TokenPortal.CleanHandsData memory ch = TokenPortal.CleanHandsData({nonce: 0, signature: ""});
        TokenPortal.PassportData memory pp = TokenPortal.PassportData({maxAmount: 1000 ether, nonce: 1, deadline: deadline, signature: badSig});

        vm.prank(user);
        vm.expectRevert(InvalidPassportSignature.selector);
        portal.depositToAztecPrivate(100 ether, bytes32(0), ch, pp);
    }

    function test_DepositPrivate_Passport_RevertWhen_SignedForDifferentUser() public {
        address attacker = makeAddr("attacker");
        token.mint(attacker, 1000 ether);
        vm.prank(attacker);
        token.approve(address(portal), type(uint256).max);

        // Passport signed for `user`, attacker sends tx
        (TokenPortal.CleanHandsData memory ch, TokenPortal.PassportData memory pp) = _makePassport(user, 1, 1000 ether);

        vm.prank(attacker);
        vm.expectRevert(InvalidPassportSignature.selector);
        portal.depositToAztecPrivate(100 ether, bytes32(0), ch, pp);
    }

    // =============================================================
    // ATTESTATION FALLBACK: CLEAN HANDS FAILS → PASSPORT SUCCEEDS
    // =============================================================

    function test_DepositPrivate_CleanHandsFails_FallsBackToPassport() public {
        bytes memory badCleanHandsSig = _signCleanHandsWithKey(1, CLEAN_HANDS_ACTION_ID, user, 0xBAD);
        TokenPortal.CleanHandsData memory ch = TokenPortal.CleanHandsData({nonce: 1, signature: badCleanHandsSig});

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory goodPassportSig = _signPassport(user, 1000 ether, 2, deadline);
        TokenPortal.PassportData memory pp = TokenPortal.PassportData({maxAmount: 1000 ether, nonce: 2, deadline: deadline, signature: goodPassportSig});

        vm.prank(user);
        portal.depositToAztecPrivate(500 ether, bytes32(0), ch, pp);

        // Both nonces consumed
        assertTrue(portal.cleanHandsNonces(user, 1));
        assertTrue(portal.passportNonces(user, 2));
    }

    function test_DepositPrivate_NoSignatures_Reverts() public {
        TokenPortal.CleanHandsData memory ch = TokenPortal.CleanHandsData({nonce: 0, signature: ""});
        TokenPortal.PassportData memory pp = TokenPortal.PassportData({maxAmount: 0, nonce: 0, deadline: 0, signature: ""});

        vm.prank(user);
        vm.expectRevert(InvalidVerification.selector);
        portal.depositToAztecPrivate(100 ether, bytes32(0), ch, pp);
    }

    function test_DepositPrivate_RevertWhen_Paused() public {
        vm.prank(owner);
        portal.pause();

        (TokenPortal.CleanHandsData memory ch, TokenPortal.PassportData memory pp) = _makeCleanHands(1, user);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        portal.depositToAztecPrivate(100 ether, bytes32(0), ch, pp);
    }

    function test_DepositPrivate_RevertWhen_ZeroAmount() public {
        (TokenPortal.CleanHandsData memory ch, TokenPortal.PassportData memory pp) = _makeCleanHands(1, user);
        vm.prank(user);
        vm.expectRevert("Amount must be greater than zero");
        portal.depositToAztecPrivate(0, bytes32(0), ch, pp);
    }

    // =============================================================
    // TRUSTED FORWARDER — depositToAztecPrivateFor
    // =============================================================

    function _setupForwarder(address forwarder, uint256 tokenAmount) internal {
        vm.prank(owner);
        portal.setTrustedForwarder(forwarder, true);
        token.mint(forwarder, tokenAmount);
        vm.prank(forwarder);
        token.approve(address(portal), type(uint256).max);
    }

    function test_PrivateFor_CleanHands() public {
        address forwarder = makeAddr("forwarder");
        _setupForwarder(forwarder, 1000 ether);

        // Attestation signed for `user` (the depositor), not `forwarder`
        (TokenPortal.CleanHandsData memory ch, TokenPortal.PassportData memory pp) = _makeCleanHands(1, user);

        vm.prank(forwarder);
        portal.depositToAztecPrivateFor(user, 1000 ether, bytes32(uint256(0x789)), ch, pp);

        assertTrue(portal.cleanHandsNonces(user, 1));
        assertEq(token.balanceOf(forwarder), 0);
        assertEq(token.balanceOf(address(portal)), 1000 ether);
    }

    function test_PrivateFor_Passport() public {
        address forwarder = makeAddr("forwarder");
        _setupForwarder(forwarder, 500 ether);

        (TokenPortal.CleanHandsData memory ch, TokenPortal.PassportData memory pp) = _makePassport(user, 1, 1000 ether);

        vm.prank(forwarder);
        portal.depositToAztecPrivateFor(user, 500 ether, bytes32(0), ch, pp);

        assertTrue(portal.passportNonces(user, 1));
    }

    function test_PrivateFor_RevertWhen_NotTrustedForwarder() public {
        address notForwarder = makeAddr("notForwarder");

        TokenPortal.CleanHandsData memory ch;
        TokenPortal.PassportData memory pp;

        vm.prank(notForwarder);
        vm.expectRevert(NotTrustedForwarder.selector);
        portal.depositToAztecPrivateFor(user, 1000 ether, bytes32(0), ch, pp);
    }

    function test_PrivateFor_RevertWhen_ForwarderRemoved() public {
        address forwarder = makeAddr("forwarder");
        _setupForwarder(forwarder, 1000 ether);

        // Remove forwarder
        vm.prank(owner);
        portal.setTrustedForwarder(forwarder, false);

        (TokenPortal.CleanHandsData memory ch, TokenPortal.PassportData memory pp) = _makeCleanHands(1, user);

        vm.prank(forwarder);
        vm.expectRevert(NotTrustedForwarder.selector);
        portal.depositToAztecPrivateFor(user, 100 ether, bytes32(0), ch, pp);
    }

    function test_PrivateFor_RevertWhen_AttestationSignedForForwarderNotDepositor() public {
        address forwarder = makeAddr("forwarder");
        _setupForwarder(forwarder, 1000 ether);

        // Attestation signed for `forwarder` instead of `user` — should fail
        (TokenPortal.CleanHandsData memory ch, TokenPortal.PassportData memory pp) = _makeCleanHands(1, forwarder);

        vm.prank(forwarder);
        // Validation uses `_depositor` (user), but sig was for `forwarder` → mismatch → falls to passport → no passport → revert
        vm.expectRevert(InvalidVerification.selector);
        portal.depositToAztecPrivateFor(user, 100 ether, bytes32(0), ch, pp);
    }

    function test_PrivateFor_PassportSignedForForwarder_Reverts() public {
        address forwarder = makeAddr("forwarder");
        _setupForwarder(forwarder, 1000 ether);

        // Passport signed for forwarder, not user
        (TokenPortal.CleanHandsData memory ch, TokenPortal.PassportData memory pp) = _makePassport(forwarder, 1, 1000 ether);

        vm.prank(forwarder);
        vm.expectRevert(InvalidPassportSignature.selector);
        portal.depositToAztecPrivateFor(user, 100 ether, bytes32(0), ch, pp);
    }

    function test_PrivateFor_NonceTrackedOnDepositorNotForwarder() public {
        address forwarder = makeAddr("forwarder");
        _setupForwarder(forwarder, 2000 ether);

        (TokenPortal.CleanHandsData memory ch, TokenPortal.PassportData memory pp) = _makeCleanHands(42, user);

        vm.prank(forwarder);
        portal.depositToAztecPrivateFor(user, 100 ether, bytes32(0), ch, pp);

        // Nonce tracked on user, not forwarder
        assertTrue(portal.cleanHandsNonces(user, 42));
        assertFalse(portal.cleanHandsNonces(forwarder, 42));
    }

    function test_PrivateFor_RevertWhen_Paused() public {
        address forwarder = makeAddr("forwarder");
        _setupForwarder(forwarder, 1000 ether);

        vm.prank(owner);
        portal.pause();

        TokenPortal.CleanHandsData memory ch;
        TokenPortal.PassportData memory pp;

        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        portal.depositToAztecPrivateFor(user, 100 ether, bytes32(0), ch, pp);
    }

    function test_PrivateFor_RevertWhen_ZeroAmount() public {
        address forwarder = makeAddr("forwarder");
        _setupForwarder(forwarder, 1000 ether);

        TokenPortal.CleanHandsData memory ch;
        TokenPortal.PassportData memory pp;

        vm.prank(forwarder);
        vm.expectRevert("Amount must be greater than zero");
        portal.depositToAztecPrivateFor(user, 0, bytes32(0), ch, pp);
    }

    function test_PrivateFor_FeeDeducted() public {
        address forwarder = makeAddr("forwarder");
        _setupForwarder(forwarder, 1000 ether);

        (TokenPortal.CleanHandsData memory ch, TokenPortal.PassportData memory pp) = _makeCleanHands(1, user);

        uint256 feesBefore = portal.collectedFees();

        vm.prank(forwarder);
        portal.depositToAztecPrivateFor(user, 1000 ether, bytes32(0), ch, pp);

        assertEq(portal.collectedFees(), feesBefore + portal.calculateFee(1000 ether));
    }

    // =============================================================
    // TRUSTED FORWARDER — ADMIN
    // =============================================================

    function test_SetTrustedForwarder() public {
        address forwarder = makeAddr("forwarder");

        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit TrustedForwarderUpdated(forwarder, true);
        portal.setTrustedForwarder(forwarder, true);
        assertTrue(portal.trustedForwarders(forwarder));

        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit TrustedForwarderUpdated(forwarder, false);
        portal.setTrustedForwarder(forwarder, false);
        assertFalse(portal.trustedForwarders(forwarder));
    }

    function test_SetTrustedForwarder_RevertWhen_NotOwner() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", user));
        portal.setTrustedForwarder(makeAddr("forwarder"), true);
    }

    function test_SetTrustedForwarder_RevertWhen_ZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(InvalidAddress.selector);
        portal.setTrustedForwarder(address(0), true);
    }

    function test_MultipleForwarders() public {
        address fwd1 = makeAddr("fwd1");
        address fwd2 = makeAddr("fwd2");

        vm.startPrank(owner);
        portal.setTrustedForwarder(fwd1, true);
        portal.setTrustedForwarder(fwd2, true);
        vm.stopPrank();

        assertTrue(portal.trustedForwarders(fwd1));
        assertTrue(portal.trustedForwarders(fwd2));

        // Remove one
        vm.prank(owner);
        portal.setTrustedForwarder(fwd1, false);

        assertFalse(portal.trustedForwarders(fwd1));
        assertTrue(portal.trustedForwarders(fwd2));
    }

    // =============================================================
    // VERIFICATION — PUBLIC VIEW FUNCTIONS
    // =============================================================

    function test_VerifyCleanHandsSignature() public {
        uint256 nonce = 123;
        bytes memory sig = _signCleanHands(nonce, CLEAN_HANDS_ACTION_ID, user);

        // Public function uses _msgSender() so must call as user
        vm.prank(user);
        assertTrue(portal.verifyCleanHandsSignature(nonce, sig));
    }

    function test_VerifyCleanHandsSignature_WrongCaller() public {
        uint256 nonce = 123;
        // Sign for `user`
        bytes memory sig = _signCleanHands(nonce, CLEAN_HANDS_ACTION_ID, user);

        // Call from a different address — _msgSender() != user → signature won't match
        address other = makeAddr("other");
        vm.prank(other);
        assertFalse(portal.verifyCleanHandsSignature(nonce, sig));
    }

    function test_VerifyCleanHandsSignature_WrongKey() public {
        uint256 nonce = 123;
        bytes memory badSig = _signCleanHandsWithKey(nonce, CLEAN_HANDS_ACTION_ID, user, 0xBAD);

        vm.prank(user);
        assertFalse(portal.verifyCleanHandsSignature(nonce, badSig));
    }

    function test_VerifyPassportSignature() public {
        uint256 maxAmount = 1000 ether;
        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signPassport(user, maxAmount, nonce, deadline);

        vm.prank(user);
        assertTrue(portal.verifyPassportSignature(maxAmount, nonce, deadline, sig));
    }

    function test_VerifyPassportSignature_WrongCaller() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signPassport(user, 1000 ether, 1, deadline);

        address other = makeAddr("other");
        vm.prank(other);
        assertFalse(portal.verifyPassportSignature(1000 ether, 1, deadline, sig));
    }

    function test_VerifyPassportSignature_Expired() public {
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _signPassport(user, 1000 ether, 1, deadline);

        vm.prank(user);
        assertFalse(portal.verifyPassportSignature(1000 ether, 1, deadline, sig));
    }

    // =============================================================
    // WITHDRAW TESTS
    // =============================================================

    function test_Withdraw() public {
        vm.prank(user);
        portal.depositToAztecPublic(bytes32(0), 1000 ether, bytes32(0));

        address recipient = makeAddr("recipient");
        bytes32[] memory path = new bytes32[](0);

        vm.prank(user);
        portal.withdraw(recipient, 500 ether, false, 1, 0, path);

        uint256 expectedFee = portal.calculateFee(500 ether);
        assertEq(token.balanceOf(recipient), 500 ether - expectedFee);
    }

    function test_Withdraw_RevertWhen_Paused() public {
        vm.prank(owner);
        portal.pause();

        bytes32[] memory path = new bytes32[](0);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        portal.withdraw(user, 100 ether, false, 1, 0, path);
    }

    function test_Withdraw_RevertWhen_ZeroAmount() public {
        bytes32[] memory path = new bytes32[](0);
        vm.prank(user);
        vm.expectRevert("Amount must be greater than zero");
        portal.withdraw(user, 0, false, 1, 0, path);
    }

    // =============================================================
    // FEE MANAGEMENT
    // =============================================================

    function test_UpdateFee() public {
        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit FeeUpdated(200);
        portal.updateFee(200);
        assertEq(portal.feeBasisPoints(), 200);
    }

    function test_UpdateFee_RevertWhen_NotOwner() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", user));
        portal.updateFee(200);
    }

    function test_UpdateFee_RevertWhen_FeeTooHigh() public {
        vm.prank(owner);
        vm.expectRevert(FeeTooHigh.selector);
        portal.updateFee(1001);
    }

    function test_UpdateFeeRecipient() public {
        address newRecipient = makeAddr("newRecipient");
        vm.prank(owner);
        portal.updateFeeRecipient(newRecipient);
        assertEq(portal.feeRecipient(), newRecipient);
    }

    function test_UpdateFeeRecipient_RevertWhen_InvalidAddress() public {
        vm.prank(owner);
        vm.expectRevert(InvalidAddress.selector);
        portal.updateFeeRecipient(address(0));
    }

    function test_WithdrawFees() public {
        vm.prank(user);
        portal.depositToAztecPublic(bytes32(0), 1000 ether, bytes32(0));

        uint256 fees = portal.collectedFees();
        assertTrue(fees > 0);

        vm.prank(owner);
        portal.withdrawFees();

        assertEq(portal.collectedFees(), 0);
        assertEq(token.balanceOf(feeRecipient), fees);
    }

    function test_WithdrawFees_RevertWhen_NoFees() public {
        vm.prank(owner);
        vm.expectRevert(NoFeesToWithdraw.selector);
        portal.withdrawFees();
    }

    function test_RescueToken() public {
        ERC20Mock randomToken = new ERC20Mock();
        randomToken.mint(address(portal), 100 ether);

        vm.prank(owner);
        portal.rescueToken(address(randomToken), 100 ether);
        assertEq(randomToken.balanceOf(owner), 100 ether);
    }

    function test_RescueToken_RevertWhen_InvalidAddress() public {
        vm.prank(owner);
        vm.expectRevert(InvalidAddress.selector);
        portal.rescueToken(address(0), 100 ether);
    }

    function test_CalculateFee() public view {
        assertEq(portal.calculateFee(10000), (10000 * FEE_BASIS_POINTS) / 10000);
        assertEq(portal.calculateFee(0), 0);
    }

    // =============================================================
    // ATTESTATION CONFIG UPDATE
    // =============================================================

    function test_UpdateAttestationConfig() public {
        address newAttester = makeAddr("newAttester");
        address newSigner = makeAddr("newSigner");
        uint256 newCircuitId = 999;
        uint256 newActionId = 2;

        vm.prank(owner);
        portal.updateAttestationConfig(newAttester, newCircuitId, newActionId, newSigner);

        assertEq(portal.humanIdAttester(), newAttester);
        assertEq(portal.cleanHandsCircuitId(), newCircuitId);
        assertEq(portal.cleanHandsActionId(), newActionId);
        assertEq(portal.passportSigner(), newSigner);
    }

    function test_UpdateAttestationConfig_OldSignaturesInvalidatedNewWork() public {
        // Deposit with old attester works
        (TokenPortal.CleanHandsData memory ch1, TokenPortal.PassportData memory pp1) = _makeCleanHands(1, user);
        vm.prank(user);
        portal.depositToAztecPrivate(100 ether, bytes32(0), ch1, pp1);

        // Rotate attester
        uint256 newAttesterKey = 0xCAFE;
        address newAttester = vm.addr(newAttesterKey);
        vm.prank(owner);
        portal.updateAttestationConfig(newAttester, CLEAN_HANDS_CIRCUIT_ID, CLEAN_HANDS_ACTION_ID, passportSigner);

        // Old attester signature no longer valid
        (TokenPortal.CleanHandsData memory ch2, TokenPortal.PassportData memory pp2) = _makeCleanHands(2, user);
        vm.prank(user);
        vm.expectRevert(InvalidVerification.selector);
        portal.depositToAztecPrivate(100 ether, bytes32(0), ch2, pp2);

        // New attester signature works
        bytes32 digest = keccak256(abi.encodePacked(uint256(3), CLEAN_HANDS_CIRCUIT_ID, CLEAN_HANDS_ACTION_ID, user));
        bytes32 personalSig = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(newAttesterKey, personalSig);
        TokenPortal.CleanHandsData memory ch3 = TokenPortal.CleanHandsData({nonce: 3, signature: abi.encodePacked(r, s, v)});
        TokenPortal.PassportData memory pp3 = TokenPortal.PassportData({maxAmount: 0, nonce: 0, deadline: 0, signature: ""});

        vm.prank(user);
        portal.depositToAztecPrivate(100 ether, bytes32(0), ch3, pp3);
        assertTrue(portal.cleanHandsNonces(user, 3));
    }

    // =============================================================
    // PAUSE / UNPAUSE
    // =============================================================

    function test_PauseUnpause() public {
        vm.prank(owner);
        portal.pause();
        assertTrue(portal.paused());

        vm.prank(owner);
        portal.unpause();
        assertFalse(portal.paused());
    }

    // =============================================================
    // OWNERSHIP TESTS
    // =============================================================

    function test_ProposeAndAcceptOwnership() public {
        vm.prank(owner);
        portal.proposeOwnershipTransfer(newOwner);
        assertEq(portal.pendingOwner(), newOwner);

        vm.prank(newOwner);
        portal.acceptOwnership();
        assertEq(portal.owner(), newOwner);
        assertEq(portal.pendingOwner(), address(0));
    }

    function test_CancelOwnershipTransfer() public {
        vm.prank(owner);
        portal.proposeOwnershipTransfer(newOwner);

        vm.prank(owner);
        portal.cancelOwnershipTransfer();
        assertEq(portal.pendingOwner(), address(0));
    }

    function test_CancelOwnershipTransfer_RevertWhen_NoPendingOwner() public {
        vm.prank(owner);
        vm.expectRevert(NoPendingOwner.selector);
        portal.cancelOwnershipTransfer();
    }

    function test_ProposeOwnershipTransfer_RevertWhen_InvalidAddress() public {
        vm.prank(owner);
        vm.expectRevert(InvalidAddress.selector);
        portal.proposeOwnershipTransfer(address(0));
    }

    // =============================================================
    // FUZZ TESTS
    // =============================================================

    function testFuzz_CalculateFee(uint256 amount) public view {
        vm.assume(amount < type(uint256).max / 1000); // avoid overflow
        uint256 fee = portal.calculateFee(amount);
        assertEq(fee, (amount * FEE_BASIS_POINTS) / 10000);
    }

    function testFuzz_DepositPublic_FeeCorrect(uint256 amount) public {
        amount = bound(amount, 1, 100000 ether);
        token.mint(user, amount);
        vm.prank(user);
        token.approve(address(portal), amount);

        uint256 expectedFee = portal.calculateFee(amount);

        vm.prank(user);
        portal.depositToAztecPublic(bytes32(uint256(1)), amount, bytes32(0));

        assertEq(portal.collectedFees(), expectedFee);
    }

    function testFuzz_CleanHandsNonce(uint256 nonce) public {
        vm.assume(nonce > 0 && nonce < type(uint128).max);

        bytes memory sig = _signCleanHands(nonce, CLEAN_HANDS_ACTION_ID, user);
        TokenPortal.CleanHandsData memory ch = TokenPortal.CleanHandsData({nonce: nonce, signature: sig});
        TokenPortal.PassportData memory pp = TokenPortal.PassportData({maxAmount: 0, nonce: 0, deadline: 0, signature: ""});

        vm.prank(user);
        portal.depositToAztecPrivate(100 ether, bytes32(0), ch, pp);
        assertTrue(portal.cleanHandsNonces(user, nonce));
    }

    // =============================================================
    // MIGRATION PAUSE TESTS (depositsActive)
    // =============================================================

    function test_PauseDeposits_BlocksPublicDeposit() public {
        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit DepositsBlocked();
        portal.pauseDeposits();

        assertFalse(portal.depositsActive());

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSignature("DepositsPaused()"));
        portal.depositToAztecPublic(bytes32(uint256(1)), 100 ether, bytes32(0));
    }

    function test_PauseDeposits_BlocksPrivateDeposit() public {
        vm.prank(owner);
        portal.pauseDeposits();

        (TokenPortal.CleanHandsData memory ch, TokenPortal.PassportData memory pp) = _makeCleanHands(1, user);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSignature("DepositsPaused()"));
        portal.depositToAztecPrivate(100 ether, bytes32(0), ch, pp);
    }

    function test_PauseDeposits_BlocksForwarderDeposit() public {
        address forwarder = makeAddr("forwarder");
        vm.prank(owner);
        portal.setTrustedForwarder(forwarder, true);

        vm.prank(owner);
        portal.pauseDeposits();

        (TokenPortal.CleanHandsData memory ch, TokenPortal.PassportData memory pp) = _makeCleanHands(1, user);

        token.mint(forwarder, 1000 ether);
        vm.prank(forwarder);
        token.approve(address(portal), type(uint256).max);

        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSignature("DepositsPaused()"));
        portal.depositToAztecPrivateFor(user, 100 ether, bytes32(0), ch, pp);
    }

    function test_PauseDeposits_WithdrawStillWorks() public {
        // Fund the portal first (deposit while active)
        vm.prank(user);
        portal.depositToAztecPublic(bytes32(uint256(1)), 1000 ether, bytes32(0));

        // Pause deposits (migration mode)
        vm.prank(owner);
        portal.pauseDeposits();

        // Withdrawal must still succeed
        address recipient = makeAddr("recipient");
        bytes32[] memory path = new bytes32[](0);

        vm.prank(user);
        portal.withdraw(recipient, 500 ether, false, 1, 0, path);

        uint256 expectedFee = portal.calculateFee(500 ether);
        assertEq(token.balanceOf(recipient), 500 ether - expectedFee);
    }

    function test_UnpauseDeposits_RestoresDeposits() public {
        vm.prank(owner);
        portal.pauseDeposits();

        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit DepositsUnblocked();
        portal.unpauseDeposits();

        assertTrue(portal.depositsActive());

        // Deposit should work again
        vm.prank(user);
        (bytes32 key,,) = portal.depositToAztecPublic(bytes32(uint256(1)), 100 ether, bytes32(0));
        assertTrue(key != bytes32(0));
    }

    function test_EmergencyPause_BlocksWithdraw() public {
        // Fund portal
        vm.prank(user);
        portal.depositToAztecPublic(bytes32(uint256(1)), 1000 ether, bytes32(0));

        // Emergency full pause
        vm.prank(owner);
        portal.pause();

        bytes32[] memory path = new bytes32[](0);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        portal.withdraw(user, 500 ether, false, 1, 0, path);
    }

    function test_EmergencyPause_AlsoBlocksDeposits() public {
        vm.prank(owner);
        portal.pause();

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        portal.depositToAztecPublic(bytes32(uint256(1)), 100 ether, bytes32(0));
    }

    function test_OnlyOwner_CanPauseDeposits() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", user));
        portal.pauseDeposits();
    }

    function test_OnlyOwner_CanUnpauseDeposits() public {
        vm.prank(owner);
        portal.pauseDeposits();

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", user));
        portal.unpauseDeposits();
    }

    function test_DepositsActive_DefaultIsTrue() public view {
        assertTrue(portal.depositsActive());
    }
}
