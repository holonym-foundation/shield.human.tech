// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@oz/utils/cryptography/ECDSA.sol";
import {Pausable} from "@oz/utils/Pausable.sol";
import {ReentrancyGuard} from "@oz/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@oz/access/Ownable2Step.sol";

// Aztec Messaging Interfaces
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";

// =============================================================
// CUSTOM ERRORS
// =============================================================

error AlreadyInitialized();
error InvalidAddress();
error FeeTooHigh();
error NoFeesToWithdraw();
error InvalidVerification();
error PassportNonceUsed();
error InvalidPassportSignature();
error AmountExceedsLimit();
error Unauthorized();

/**
 * @title TokenPortal
 * @dev Manages L1/L2 token transfers between Ethereum and Aztec with fee logic and attestation checks.
 */
contract TokenPortal is Pausable, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    // =============================================================
    // DATA STRUCTURES
    // =============================================================

    struct PassportData {
        uint256 maxAmount;
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    struct CleanHandsData {
        uint256 actionId;
        bytes signature;
    }

    // =============================================================
    // STATE VARIABLES
    // =============================================================

    address private immutable DEPLOYER;

    // Aztec Infrastructure
    IRegistry public registry;
    IERC20 public underlying;
    IRollup public rollup;
    IOutbox public outbox;
    IInbox public inbox;
    bytes32 public l2Bridge;
    uint256 public rollupVersion;
    // Attestation Config
    address public humanIdAttester = 0xa74772264f896843c6346ceA9B13e0128A1d3b5D;
    uint256 public cleanHandsCircuitId =
        0x1c98fc4f7f1ad3805aefa81ad25fa466f8342292accf69566b43691d12742a19;
    address public passportSigner = 0xEa7D467E12B199E7D94EE7bda32335a0f9248315;

    mapping(address => mapping(uint256 => bool)) public passportNonces;

    // Fee Management
    uint256 public feeBasisPoints;
    uint256 public constant MAX_FEE_BASIS_POINTS = 1000; // 10%
    address public feeRecipient;
    uint256 public collectedFees;

    // =============================================================
    // EVENTS
    // =============================================================

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

    // =============================================================
    // CONSTRUCTOR / INITIALIZER
    // =============================================================

    constructor() Ownable(msg.sender) {
        DEPLOYER = msg.sender;
    }

    function initialize(
        address _registry,
        address _underlying,
        bytes32 _l2Bridge
    ) external {
        if (msg.sender != DEPLOYER) revert Unauthorized();
        if (address(registry) != address(0)) revert AlreadyInitialized();
        if (_registry == address(0) || _underlying == address(0))
            revert InvalidAddress();

        registry = IRegistry(_registry);
        underlying = IERC20(_underlying);
        l2Bridge = _l2Bridge;

        rollup = IRollup(address(registry.getCanonicalRollup()));
        outbox = rollup.getOutbox();
        inbox = rollup.getInbox();
        rollupVersion = rollup.getVersion();

        feeRecipient = owner();
        feeBasisPoints = 10; // 0.1%

        emit Initialized(_registry, _underlying, _l2Bridge);
    }

    // =============================================================
    // EXTERNAL FUNCTIONS: USER ACTIONS
    // =============================================================

    function depositToAztecPublic(
        bytes32 _to,
        uint256 _amount,
        bytes32 _secretHash
    ) external whenNotPaused nonReentrant returns (bytes32, uint256) {
        uint256 fee = calculateFee(_amount);
        uint256 amountAfterFee = _amount - fee;

        DataStructures.L2Actor memory actor = DataStructures.L2Actor(
            l2Bridge,
            rollupVersion
        );
        bytes32 contentHash = Hash.sha256ToField(
            abi.encodeWithSignature(
                "mint_to_public(bytes32,uint256)",
                _to,
                amountAfterFee
            )
        );

        underlying.safeTransferFrom(msg.sender, address(this), _amount);
        collectedFees += fee;

        (bytes32 key, uint256 index) = inbox.sendL2Message(
            actor,
            contentHash,
            _secretHash
        );

        emit DepositToAztecPublic(
            _to,
            amountAfterFee,
            fee,
            _secretHash,
            key,
            index
        );
        return (key, index);
    }

    function depositToAztecPrivate(
        uint256 _amount,
        bytes32 _secretHashForL2MessageConsumption,
        CleanHandsData calldata _cleanHands,
        PassportData calldata _passport
    ) external whenNotPaused nonReentrant returns (bytes32, uint256) {
        _validatePrivateAttestations(_amount, _cleanHands, _passport);

        uint256 fee = calculateFee(_amount);
        uint256 amountAfterFee = _amount - fee;

        DataStructures.L2Actor memory actor = DataStructures.L2Actor(
            l2Bridge,
            rollupVersion
        );
        bytes32 contentHash = Hash.sha256ToField(
            abi.encodeWithSignature("mint_to_private(uint256)", amountAfterFee)
        );

        underlying.safeTransferFrom(msg.sender, address(this), _amount);
        collectedFees += fee;

        (bytes32 key, uint256 index) = inbox.sendL2Message(
            actor,
            contentHash,
            _secretHashForL2MessageConsumption
        );

        emit DepositToAztecPrivate(
            amountAfterFee,
            fee,
            _secretHashForL2MessageConsumption,
            key,
            index
        );
        return (key, index);
    }

    function withdraw(
        address _recipient,
        uint256 _amount,
        bool _withCaller,
        uint256 _l2BlockNumber,
        uint256 _leafIndex,
        bytes32[] calldata _path
    ) external whenNotPaused nonReentrant {
        DataStructures.L2ToL1Msg memory message = DataStructures.L2ToL1Msg({
            sender: DataStructures.L2Actor(l2Bridge, rollupVersion),
            recipient: DataStructures.L1Actor(address(this), block.chainid),
            content: Hash.sha256ToField(
                abi.encodeWithSignature(
                    "withdraw(address,uint256,address)",
                    _recipient,
                    _amount,
                    _withCaller ? msg.sender : address(0)
                )
            )
        });

        outbox.consume(message, _l2BlockNumber, _leafIndex, _path);

        uint256 fee = calculateFee(_amount);
        uint256 amountAfterFee = _amount - fee;
        collectedFees += fee;

        underlying.safeTransfer(_recipient, amountAfterFee);
    }

    // =============================================================
    // EXTERNAL FUNCTIONS: ADMIN
    // =============================================================

    function pause() external onlyOwner {
        _pause();
    }
    function unpause() external onlyOwner {
        _unpause();
    }

    function updateFee(uint256 _newFeeBasisPoints) external onlyOwner {
        if (_newFeeBasisPoints > MAX_FEE_BASIS_POINTS) revert FeeTooHigh();
        feeBasisPoints = _newFeeBasisPoints;
        emit FeeUpdated(_newFeeBasisPoints);
    }

    function updateFeeRecipient(address _newFeeRecipient) external onlyOwner {
        if (_newFeeRecipient == address(0)) revert InvalidAddress();
        feeRecipient = _newFeeRecipient;
        emit FeeRecipientUpdated(_newFeeRecipient);
    }

    function withdrawFees() external onlyOwner nonReentrant {
        uint256 amount = collectedFees;
        if (amount == 0) revert NoFeesToWithdraw();

        collectedFees = 0;
        underlying.safeTransfer(feeRecipient, amount);
        emit FeesWithdrawn(feeRecipient, amount);
    }

    function rescueToken(address _token, uint256 _amount) external onlyOwner {
        if (_token == address(0)) revert InvalidAddress();
        IERC20(_token).safeTransfer(owner(), _amount);
        emit TokensRescued(_token, owner(), _amount);
    }

    // =============================================================
    // INTERNAL HELPERS
    // =============================================================

    function _validatePrivateAttestations(
        uint256 _amount,
        CleanHandsData calldata _cleanHands,
        PassportData calldata _passport
    ) internal {
        bool verified = false;

        // 1. Try Clean Hands Verification
        if (_cleanHands.signature.length > 0) {
            verified = verifyCleanHandsSignature(
                cleanHandsCircuitId,
                _cleanHands.actionId,
                msg.sender,
                _cleanHands.signature
            );
        }

        // 2. Fallback to Passport Verification
        if (!verified) {
            if (_passport.signature.length == 0) revert InvalidVerification();
            if (passportNonces[msg.sender][_passport.nonce])
                revert PassportNonceUsed();
            if (
                !verifyPassportSignature(
                    _passport.maxAmount,
                    _passport.nonce,
                    _passport.deadline,
                    _passport.signature
                )
            ) {
                revert InvalidPassportSignature();
            }
            if (_amount > _passport.maxAmount) revert AmountExceedsLimit();

            passportNonces[msg.sender][_passport.nonce] = true;
        }
    }

    function verifyCleanHandsSignature(
        uint256 circuitId,
        uint256 actionId,
        address userAddress,
        bytes memory signature
    ) public view returns (bool) {
        bytes32 digest = keccak256(
            abi.encodePacked(circuitId, actionId, userAddress)
        );
        bytes32 personalSignPreimage = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)
        );
        (address recovered, , ) = ECDSA.tryRecover(
            personalSignPreimage,
            signature
        );

        return recovered == humanIdAttester;
    }

    function verifyPassportSignature(
        uint256 maxAmount,
        uint256 nonce,
        uint256 deadline,
        bytes memory signature
    ) public view returns (bool) {
        if (block.timestamp > deadline) return false;
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                msg.sender,
                maxAmount,
                nonce,
                deadline,
                address(this)
            )
        );
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );

        (address recovered, , ) = ECDSA.tryRecover(
            ethSignedMessageHash,
            signature
        );

        return recovered == passportSigner;
    }

    function calculateFee(uint256 _amount) public view returns (uint256) {
        return (_amount * feeBasisPoints) / 10000;
    }

    function getCollectedFees() external view returns (uint256) {
        return collectedFees;
    }

    function getFeeRecipient() external view returns (address) {
        return feeRecipient;
    }
}
