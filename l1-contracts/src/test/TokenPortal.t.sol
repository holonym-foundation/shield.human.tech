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

    function sendL2Message(
        DataStructures.L2Actor memory,
        bytes32,
        bytes32
    ) external returns (bytes32, uint256) {
        messageCount++;
        return (keccak256(abi.encodePacked(messageCount)), messageCount);
    }
}

contract MockOutbox {
    mapping(bytes32 => bool) public consumed;

    function consume(
        DataStructures.L2ToL1Msg memory message,
        uint256,
        uint256,
        bytes32[] calldata
    ) external {
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
    uint256 public constant CLEAN_HANDS_CIRCUIT_ID = 1;
    bytes32 public constant L2_BRIDGE = bytes32(uint256(0x123));
    uint256 public constant ROLLUP_VERSION = 1;

    event Initialized(address registry, address underlying, bytes32 l2Bridge);
    event DepositToAztecPublic(
        bytes32 indexed to,
        uint256 amount,
        uint256 fee,
        bytes32 secretHash,
        bytes32 key,
        uint256 index
    );
    event DepositToAztecPrivate(
        uint256 amount,
        uint256 fee,
        bytes32 secretHash,
        bytes32 key,
        uint256 index
    );
    event FeeUpdated(uint256 newFeeBasisPoints);
    event FeeRecipientUpdated(address indexed newFeeRecipient);
    event FeesWithdrawn(address indexed recipient, uint256 amount);
    event TokensRescued(
        address indexed token,
        address indexed to,
        uint256 amount
    );
    event AttestationConfigUpdated(
        address attester,
        uint256 circuitId,
        address signer
    );
    event OwnershipTransferProposed(
        address indexed previousOwner,
        address indexed newOwner
    );
    event OwnershipTransferCancelled(address indexed currentOwner);

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
            owner,
            feeRecipient,
            FEE_BASIS_POINTS,
            humanIdAttester,
            CLEAN_HANDS_CIRCUIT_ID,
            passportSigner
        );

        // Initialize portal
        portal.initialize(address(registry), address(token), L2_BRIDGE);

        // Setup token balances
        token.mint(user, 1000000 ether);
        vm.prank(user);
        token.approve(address(portal), type(uint256).max);
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
        new TokenPortal(
            owner,
            address(0),
            FEE_BASIS_POINTS,
            humanIdAttester,
            CLEAN_HANDS_CIRCUIT_ID,
            passportSigner
        );
    }

    function test_Constructor_RevertWhen_FeeTooHigh() public {
        vm.expectRevert(FeeTooHigh.selector);
        new TokenPortal(
            owner,
            feeRecipient,
            1001, // > MAX_FEE_BASIS_POINTS
            humanIdAttester,
            CLEAN_HANDS_CIRCUIT_ID,
            passportSigner
        );
    }

    // =============================================================
    // INITIALIZATION TESTS
    // =============================================================

    function test_Initialize() public {
        TokenPortal newPortal = new TokenPortal(
            owner,
            feeRecipient,
            FEE_BASIS_POINTS,
            humanIdAttester,
            CLEAN_HANDS_CIRCUIT_ID,
            passportSigner
        );

        vm.expectEmit(true, true, true, true);
        emit Initialized(address(registry), address(token), L2_BRIDGE);

        newPortal.initialize(address(registry), address(token), L2_BRIDGE);

        assertEq(address(newPortal.registry()), address(registry));
        assertEq(address(newPortal.underlying()), address(token));
        assertEq(newPortal.l2Bridge(), L2_BRIDGE);
        assertEq(address(newPortal.rollup()), address(rollup));
        assertEq(address(newPortal.outbox()), address(outbox));
        assertEq(address(newPortal.inbox()), address(inbox));
        assertEq(newPortal.rollupVersion(), ROLLUP_VERSION);
    }

    function test_Initialize_RevertWhen_NotDeployer() public {
        TokenPortal newPortal = new TokenPortal(
            owner,
            feeRecipient,
            FEE_BASIS_POINTS,
            humanIdAttester,
            CLEAN_HANDS_CIRCUIT_ID,
            passportSigner
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
        TokenPortal newPortal = new TokenPortal(
            owner,
            feeRecipient,
            FEE_BASIS_POINTS,
            humanIdAttester,
            CLEAN_HANDS_CIRCUIT_ID,
            passportSigner
        );

        vm.expectRevert(InvalidAddress.selector);
        newPortal.initialize(address(0), address(token), L2_BRIDGE);
    }

    function test_Initialize_RevertWhen_InvalidUnderlyingAddress() public {
        TokenPortal newPortal = new TokenPortal(
            owner,
            feeRecipient,
            FEE_BASIS_POINTS,
            humanIdAttester,
            CLEAN_HANDS_CIRCUIT_ID,
            passportSigner
        );

        vm.expectRevert(InvalidAddress.selector);
        newPortal.initialize(address(registry), address(0), L2_BRIDGE);
    }

    // =============================================================
    // DEPOSIT TO AZTEC PUBLIC TESTS
    // =============================================================

    function test_DepositToAztecPublic() public {
        uint256 amount = 1000 ether;
        bytes32 to = bytes32(uint256(0x456));
        bytes32 secretHash = bytes32(uint256(0x789));

        uint256 expectedFee = portal.calculateFee(amount);
        uint256 expectedAmountAfterFee = amount - expectedFee;

        vm.prank(user);
        vm.expectEmit(true, true, true, true);
        emit DepositToAztecPublic(
            to,
            expectedAmountAfterFee,
            expectedFee,
            secretHash,
            keccak256(abi.encodePacked(uint256(1))),
            1
        );

        (bytes32 key, uint256 index) = portal.depositToAztecPublic(
            to,
            amount,
            secretHash
        );

        assertEq(portal.collectedFees(), expectedFee);
        assertEq(token.balanceOf(address(portal)), amount);
        assertEq(key, keccak256(abi.encodePacked(uint256(1))));
        assertEq(index, 1);
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
    // DEPOSIT TO AZTEC PRIVATE TESTS
    // =============================================================

    function test_DepositToAztecPrivate_WithCleanHands() public {
        uint256 amount = 1000 ether;
        bytes32 secretHash = bytes32(uint256(0x789));
        
        (TokenPortal.CleanHandsData memory cleanHands, TokenPortal.PassportData memory passport) = 
            _createCleanHandsData(1, 100);

        uint256 expectedFee = portal.calculateFee(amount);

        vm.prank(user);
        (bytes32 key, uint256 index) = portal.depositToAztecPrivate(
            amount,
            secretHash,
            cleanHands,
            passport
        );

        assertEq(portal.collectedFees(), expectedFee);
        assertTrue(portal.cleanHandsNonces(user, 1));
        assertEq(key, keccak256(abi.encodePacked(uint256(1))));
        assertEq(index, 1);
    }

    function _createCleanHandsData(uint256 nonce, uint256 actionId) internal view returns (
        TokenPortal.CleanHandsData memory cleanHands,
        TokenPortal.PassportData memory passport
    ) {
        bytes32 digest = keccak256(
            abi.encodePacked(nonce, CLEAN_HANDS_CIRCUIT_ID, actionId, user)
        );
        bytes32 personalSignPreimage = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            attesterPrivateKey,
            personalSignPreimage
        );
        
        cleanHands = TokenPortal.CleanHandsData({
            nonce: nonce,
            actionId: actionId,
            signature: abi.encodePacked(r, s, v)
        });

        passport = TokenPortal.PassportData({
            maxAmount: 0,
            nonce: 0,
            deadline: 0,
            signature: ""
        });
    }

    function test_DepositToAztecPrivate_WithPassport() public {
        uint256 amount = 500 ether;
        bytes32 secretHash = bytes32(uint256(0x789));
        
        (TokenPortal.CleanHandsData memory cleanHands, TokenPortal.PassportData memory passport) = 
            _createPassportData(1, 1000 ether);

        vm.prank(user);
        portal.depositToAztecPrivate(amount, secretHash, cleanHands, passport);

        assertTrue(portal.passportNonces(user, 1));
    }

    function _createPassportData(uint256 nonce, uint256 maxAmount) internal view returns (
        TokenPortal.CleanHandsData memory cleanHands,
        TokenPortal.PassportData memory passport
    ) {
        uint256 deadline = block.timestamp + 1 hours;
        
        bytes32 messageHash = keccak256(
            abi.encodePacked(user, maxAmount, nonce, deadline, address(portal))
        );
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            passportSignerPrivateKey,
            ethSignedMessageHash
        );

        cleanHands = TokenPortal.CleanHandsData({
            nonce: 0,
            actionId: 0,
            signature: ""
        });

        passport = TokenPortal.PassportData({
            maxAmount: maxAmount,
            nonce: nonce,
            deadline: deadline,
            signature: abi.encodePacked(r, s, v)
        });
    }

    function test_DepositToAztecPrivate_RevertWhen_Paused() public {
        vm.prank(owner);
        portal.pause();

        TokenPortal.CleanHandsData memory cleanHands;
        TokenPortal.PassportData memory passport;

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        portal.depositToAztecPrivate(100 ether, bytes32(0), cleanHands, passport);
    }

    function test_DepositToAztecPrivate_RevertWhen_ZeroAmount() public {
        TokenPortal.CleanHandsData memory cleanHands;
        TokenPortal.PassportData memory passport;

        vm.prank(user);
        vm.expectRevert("Amount must be greater than zero");
        portal.depositToAztecPrivate(0, bytes32(0), cleanHands, passport);
    }

    function test_DepositToAztecPrivate_RevertWhen_CleanHandsNonceUsed() public {
        uint256 amount = 1000 ether;
        bytes32 secretHash = bytes32(uint256(0x789));
        
        (TokenPortal.CleanHandsData memory cleanHands, TokenPortal.PassportData memory passport) = 
            _createCleanHandsData(1, 100);

        vm.prank(user);
        portal.depositToAztecPrivate(amount, secretHash, cleanHands, passport);

        // Try to reuse the same nonce
        vm.prank(user);
        vm.expectRevert(CleanHandsNonceUsed.selector);
        portal.depositToAztecPrivate(amount, secretHash, cleanHands, passport);
    }

    function test_DepositToAztecPrivate_RevertWhen_PassportNonceUsed() public {
        uint256 amount = 500 ether;
        bytes32 secretHash = bytes32(uint256(0x789));
        
        (TokenPortal.CleanHandsData memory cleanHands, TokenPortal.PassportData memory passport) = 
            _createPassportData(1, 1000 ether);

        vm.prank(user);
        portal.depositToAztecPrivate(amount, secretHash, cleanHands, passport);

        // Try to reuse the same nonce
        vm.prank(user);
        vm.expectRevert(PassportNonceUsed.selector);
        portal.depositToAztecPrivate(amount, secretHash, cleanHands, passport);
    }

    function test_DepositToAztecPrivate_RevertWhen_InvalidVerification() public {
        uint256 amount = 500 ether;
        bytes32 secretHash = bytes32(uint256(0x789));

        TokenPortal.CleanHandsData memory cleanHands = TokenPortal
            .CleanHandsData({nonce: 0, actionId: 0, signature: ""});

        TokenPortal.PassportData memory passport = TokenPortal.PassportData({
            maxAmount: 0,
            nonce: 0,
            deadline: 0,
            signature: ""
        });

        vm.prank(user);
        vm.expectRevert(InvalidVerification.selector);
        portal.depositToAztecPrivate(amount, secretHash, cleanHands, passport);
    }

    function test_DepositToAztecPrivate_InvalidCleanHandsWithValidPassport() public {
        uint256 amount = 500 ether;
        bytes32 secretHash = bytes32(uint256(0x789));
        uint256 cleanHandsNonce = 1;
        uint256 passportNonce = 2;
        
        // Create CleanHands with invalid signature (wrong signer)
        bytes32 digest = keccak256(
            abi.encodePacked(cleanHandsNonce, CLEAN_HANDS_CIRCUIT_ID, uint256(100), user)
        );
        bytes32 personalSignPreimage = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, personalSignPreimage); // Wrong key
        
        TokenPortal.CleanHandsData memory cleanHands = TokenPortal.CleanHandsData({
            nonce: cleanHandsNonce,
            actionId: 100,
            signature: abi.encodePacked(r, s, v)
        });

        // Create valid passport to fallback to
        (,TokenPortal.PassportData memory passport) = _createPassportData(passportNonce, 1000 ether);

        vm.prank(user);
        portal.depositToAztecPrivate(amount, secretHash, cleanHands, passport);

        // CleanHands nonce should be marked as used (even though verification failed)
        assertTrue(portal.cleanHandsNonces(user, cleanHandsNonce));
        // Passport should have been used for actual verification
        assertTrue(portal.passportNonces(user, passportNonce));
    }

    function test_DepositToAztecPrivate_RevertWhen_InvalidPassportSignature()
        public
    {
        uint256 amount = 500 ether;
        bytes32 secretHash = bytes32(uint256(0x789));
        
        (TokenPortal.CleanHandsData memory cleanHands, TokenPortal.PassportData memory passport) = 
            _createInvalidPassportData(1, 1000 ether);

        vm.prank(user);
        vm.expectRevert(InvalidPassportSignature.selector);
        portal.depositToAztecPrivate(amount, secretHash, cleanHands, passport);
    }

    function _createInvalidPassportData(uint256 nonce, uint256 maxAmount) internal view returns (
        TokenPortal.CleanHandsData memory cleanHands,
        TokenPortal.PassportData memory passport
    ) {
        uint256 deadline = block.timestamp + 1 hours;
        
        bytes32 messageHash = keccak256(
            abi.encodePacked(user, maxAmount, nonce, deadline, address(portal))
        );
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            0xBAD, // Wrong private key
            ethSignedMessageHash
        );

        cleanHands = TokenPortal.CleanHandsData({
            nonce: 0,
            actionId: 0,
            signature: ""
        });

        passport = TokenPortal.PassportData({
            maxAmount: maxAmount,
            nonce: nonce,
            deadline: deadline,
            signature: abi.encodePacked(r, s, v)
        });
    }

    function test_DepositToAztecPrivate_RevertWhen_AmountExceedsLimit() public {
        uint256 amount = 2000 ether; // Exceeds maxAmount
        bytes32 secretHash = bytes32(uint256(0x789));
        
        (TokenPortal.CleanHandsData memory cleanHands, TokenPortal.PassportData memory passport) = 
            _createPassportData(1, 1000 ether);

        vm.prank(user);
        vm.expectRevert(AmountExceedsLimit.selector);
        portal.depositToAztecPrivate(amount, secretHash, cleanHands, passport);
    }

    // =============================================================
    // WITHDRAW TESTS
    // =============================================================

    function test_Withdraw() public {
        // First deposit to have tokens in portal
        uint256 depositAmount = 1000 ether;
        vm.prank(user);
        portal.depositToAztecPublic(bytes32(0), depositAmount, bytes32(0));

        uint256 withdrawAmount = 500 ether;
        address recipient = makeAddr("recipient");

        DataStructures.L2ToL1Msg memory message = DataStructures.L2ToL1Msg({
            sender: DataStructures.L2Actor(L2_BRIDGE, ROLLUP_VERSION),
            recipient: DataStructures.L1Actor(address(portal), block.chainid),
            content: keccak256(
                abi.encodePacked(
                    "\x19Ethereum Signed Message:\n32",
                    keccak256(
                        abi.encodeWithSignature(
                            "withdraw(address,uint256,address)",
                            recipient,
                            withdrawAmount,
                            address(0)
                        )
                    )
                )
            )
        });

        bytes32[] memory path = new bytes32[](0);

        uint256 expectedFee = portal.calculateFee(withdrawAmount);
        uint256 expectedAmountAfterFee = withdrawAmount - expectedFee;

        vm.prank(user);
        portal.withdraw(recipient, withdrawAmount, false, 1, 0, path);

        assertEq(token.balanceOf(recipient), expectedAmountAfterFee);
    }

    function test_Withdraw_WithCaller() public {
        // First deposit
        uint256 depositAmount = 1000 ether;
        vm.prank(user);
        portal.depositToAztecPublic(bytes32(0), depositAmount, bytes32(0));

        uint256 withdrawAmount = 500 ether;
        address recipient = makeAddr("recipient");

        DataStructures.L2ToL1Msg memory message = DataStructures.L2ToL1Msg({
            sender: DataStructures.L2Actor(L2_BRIDGE, ROLLUP_VERSION),
            recipient: DataStructures.L1Actor(address(portal), block.chainid),
            content: keccak256(
                abi.encodePacked(
                    "\x19Ethereum Signed Message:\n32",
                    keccak256(
                        abi.encodeWithSignature(
                            "withdraw(address,uint256,address)",
                            recipient,
                            withdrawAmount,
                            user // With caller
                        )
                    )
                )
            )
        });

        bytes32[] memory path = new bytes32[](0);

        vm.prank(user);
        portal.withdraw(recipient, withdrawAmount, true, 1, 0, path);

        uint256 expectedFee = portal.calculateFee(withdrawAmount);
        uint256 expectedAmountAfterFee = withdrawAmount - expectedFee;
        assertEq(token.balanceOf(recipient), expectedAmountAfterFee);
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
    // ADMIN FUNCTION TESTS
    // =============================================================

    function test_Pause() public {
        vm.prank(owner);
        portal.pause();

        assertTrue(portal.paused());
    }

    function test_Pause_RevertWhen_NotOwner() public {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", user)
        );
        portal.pause();
    }

    function test_Unpause() public {
        vm.prank(owner);
        portal.pause();

        vm.prank(owner);
        portal.unpause();

        assertFalse(portal.paused());
    }

    function test_Unpause_RevertWhen_NotOwner() public {
        vm.prank(owner);
        portal.pause();

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", user)
        );
        portal.unpause();
    }

    function test_UpdateAttestationConfig() public {
        address newAttester = makeAddr("newAttester");
        uint256 newCircuitId = 999;
        address newSigner = makeAddr("newSigner");

        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit AttestationConfigUpdated(newAttester, newCircuitId, newSigner);

        portal.updateAttestationConfig(newAttester, newCircuitId, newSigner);

        assertEq(portal.humanIdAttester(), newAttester);
        assertEq(portal.cleanHandsCircuitId(), newCircuitId);
        assertEq(portal.passportSigner(), newSigner);
    }

    function test_UpdateAttestationConfig_RevertWhen_NotOwner() public {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", user)
        );
        portal.updateAttestationConfig(address(0), 0, address(0));
    }

    function test_UpdateFee() public {
        uint256 newFee = 200;

        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit FeeUpdated(newFee);

        portal.updateFee(newFee);

        assertEq(portal.feeBasisPoints(), newFee);
    }

    function test_UpdateFee_RevertWhen_NotOwner() public {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", user)
        );
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
        vm.expectEmit(true, true, true, true);
        emit FeeRecipientUpdated(newRecipient);

        portal.updateFeeRecipient(newRecipient);

        assertEq(portal.feeRecipient(), newRecipient);
    }

    function test_UpdateFeeRecipient_RevertWhen_NotOwner() public {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", user)
        );
        portal.updateFeeRecipient(makeAddr("someone"));
    }

    function test_UpdateFeeRecipient_RevertWhen_InvalidAddress() public {
        vm.prank(owner);
        vm.expectRevert(InvalidAddress.selector);
        portal.updateFeeRecipient(address(0));
    }

    function test_WithdrawFees() public {
        // First generate some fees
        uint256 depositAmount = 1000 ether;
        vm.prank(user);
        portal.depositToAztecPublic(bytes32(0), depositAmount, bytes32(0));

        uint256 expectedFees = portal.collectedFees();
        uint256 balanceBefore = token.balanceOf(feeRecipient);

        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit FeesWithdrawn(feeRecipient, expectedFees);

        portal.withdrawFees();

        assertEq(portal.collectedFees(), 0);
        assertEq(token.balanceOf(feeRecipient), balanceBefore + expectedFees);
    }

    function test_WithdrawFees_RevertWhen_NotOwner() public {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", user)
        );
        portal.withdrawFees();
    }

    function test_WithdrawFees_RevertWhen_NoFees() public {
        vm.prank(owner);
        vm.expectRevert(NoFeesToWithdraw.selector);
        portal.withdrawFees();
    }

    function test_RescueToken() public {
        ERC20Mock randomToken = new ERC20Mock();
        uint256 rescueAmount = 100 ether;
        randomToken.mint(address(portal), rescueAmount);

        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit TokensRescued(address(randomToken), owner, rescueAmount);

        portal.rescueToken(address(randomToken), rescueAmount);

        assertEq(randomToken.balanceOf(owner), rescueAmount);
    }

    function test_RescueToken_RevertWhen_NotOwner() public {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", user)
        );
        portal.rescueToken(address(token), 100 ether);
    }

    function test_RescueToken_RevertWhen_InvalidAddress() public {
        vm.prank(owner);
        vm.expectRevert(InvalidAddress.selector);
        portal.rescueToken(address(0), 100 ether);
    }

    // =============================================================
    // OWNERSHIP TESTS
    // =============================================================

    function test_ProposeOwnershipTransfer() public {
        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit OwnershipTransferProposed(owner, newOwner);

        portal.proposeOwnershipTransfer(newOwner);

        assertEq(portal.pendingOwner(), newOwner);
        assertEq(portal.owner(), owner); // Not changed yet
    }

    function test_ProposeOwnershipTransfer_RevertWhen_NotOwner() public {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", user)
        );
        portal.proposeOwnershipTransfer(newOwner);
    }

    function test_ProposeOwnershipTransfer_RevertWhen_InvalidAddress() public {
        vm.prank(owner);
        vm.expectRevert(InvalidAddress.selector);
        portal.proposeOwnershipTransfer(address(0));
    }

    function test_AcceptOwnership() public {
        vm.prank(owner);
        portal.proposeOwnershipTransfer(newOwner);

        vm.prank(newOwner);
        portal.acceptOwnership();

        assertEq(portal.owner(), newOwner);
        assertEq(portal.pendingOwner(), address(0));
    }

    function test_CancelOwnershipTransfer() public {
        vm.prank(owner);
        portal.proposeOwnershipTransfer(newOwner);

        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit OwnershipTransferCancelled(owner);

        portal.cancelOwnershipTransfer();

        assertEq(portal.pendingOwner(), address(0));
        assertEq(portal.owner(), owner);
    }

    function test_CancelOwnershipTransfer_RevertWhen_NotOwner() public {
        vm.prank(owner);
        portal.proposeOwnershipTransfer(newOwner);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", user)
        );
        portal.cancelOwnershipTransfer();
    }

    function test_CancelOwnershipTransfer_RevertWhen_NoPendingOwner() public {
        vm.prank(owner);
        vm.expectRevert(NoPendingOwner.selector);
        portal.cancelOwnershipTransfer();
    }

    // =============================================================
    // VERIFICATION TESTS
    // =============================================================

    function test_VerifyCleanHandsSignature() public view {
        uint256 nonce = 123;
        uint256 actionId = 456;

        bytes32 digest = keccak256(
            abi.encodePacked(nonce, CLEAN_HANDS_CIRCUIT_ID, actionId, user)
        );
        bytes32 personalSignPreimage = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            attesterPrivateKey,
            personalSignPreimage
        );
        bytes memory signature = abi.encodePacked(r, s, v);

        bool result = portal.verifyCleanHandsSignature(
            nonce,
            CLEAN_HANDS_CIRCUIT_ID,
            actionId,
            user,
            signature
        );

        assertTrue(result);
    }

    function test_VerifyCleanHandsSignature_InvalidSignature() public view {
        uint256 nonce = 123;
        uint256 actionId = 456;

        bytes32 digest = keccak256(
            abi.encodePacked(nonce, CLEAN_HANDS_CIRCUIT_ID, actionId, user)
        );
        bytes32 personalSignPreimage = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            0xBAD, // Wrong key
            personalSignPreimage
        );
        bytes memory signature = abi.encodePacked(r, s, v);

        bool result = portal.verifyCleanHandsSignature(
            nonce,
            CLEAN_HANDS_CIRCUIT_ID,
            actionId,
            user,
            signature
        );

        assertFalse(result);
    }

    function test_VerifyPassportSignature() public {
        uint256 maxAmount = 1000 ether;
        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory signature = _signPassport(maxAmount, nonce, deadline);

        vm.prank(user);
        bool result = portal.verifyPassportSignature(
            maxAmount,
            nonce,
            deadline,
            signature
        );

        assertTrue(result);
    }

    function _signPassport(uint256 maxAmount, uint256 nonce, uint256 deadline) internal view returns (bytes memory) {
        bytes32 messageHash = keccak256(
            abi.encodePacked(user, maxAmount, nonce, deadline, address(portal))
        );
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            passportSignerPrivateKey,
            ethSignedMessageHash
        );
        return abi.encodePacked(r, s, v);
    }

    function test_VerifyPassportSignature_ExpiredDeadline() public {
        uint256 maxAmount = 1000 ether;
        uint256 nonce = 1;
        uint256 deadline = block.timestamp - 1; // Expired

        bytes memory signature = _signPassport(maxAmount, nonce, deadline);

        vm.prank(user);
        bool result = portal.verifyPassportSignature(
            maxAmount,
            nonce,
            deadline,
            signature
        );

        assertFalse(result);
    }

    function test_VerifyPassportSignature_InvalidSignature() public {
        uint256 maxAmount = 1000 ether;
        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory signature = _signPassportInvalid(maxAmount, nonce, deadline);

        vm.prank(user);
        bool result = portal.verifyPassportSignature(
            maxAmount,
            nonce,
            deadline,
            signature
        );

        assertFalse(result);
    }

    function _signPassportInvalid(uint256 maxAmount, uint256 nonce, uint256 deadline) internal view returns (bytes memory) {
        bytes32 messageHash = keccak256(
            abi.encodePacked(user, maxAmount, nonce, deadline, address(portal))
        );
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            0xBAD, // Wrong key
            ethSignedMessageHash
        );
        return abi.encodePacked(r, s, v);
    }

    // =============================================================
    // VIEW FUNCTION TESTS
    // =============================================================

    function test_CalculateFee() public view {
        uint256 amount = 1000 ether;
        uint256 expectedFee = (amount * FEE_BASIS_POINTS) / 10000;

        assertEq(portal.calculateFee(amount), expectedFee);
    }

    function test_GetCollectedFees() public {
        vm.prank(user);
        portal.depositToAztecPublic(bytes32(0), 1000 ether, bytes32(0));

        uint256 fees = portal.getCollectedFees();
        assertEq(fees, portal.collectedFees());
    }

    function test_GetFeeRecipient() public view {
        assertEq(portal.getFeeRecipient(), feeRecipient);
    }

    // =============================================================
    // EDGE CASES & REENTRANCY TESTS
    // =============================================================

    function test_DepositToAztecPublic_MultipleDeposits() public {
        vm.startPrank(user);

        portal.depositToAztecPublic(bytes32(uint256(1)), 100 ether, bytes32(0));
        portal.depositToAztecPublic(bytes32(uint256(2)), 200 ether, bytes32(0));
        portal.depositToAztecPublic(bytes32(uint256(3)), 300 ether, bytes32(0));

        vm.stopPrank();

        uint256 expectedFees = portal.calculateFee(100 ether) +
            portal.calculateFee(200 ether) +
            portal.calculateFee(300 ether);

        assertEq(portal.collectedFees(), expectedFees);
    }

    function test_MaxFeeBasisPoints() public view {
        assertEq(portal.MAX_FEE_BASIS_POINTS(), 1000);
    }
}
