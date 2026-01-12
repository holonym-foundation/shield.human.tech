pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@oz/utils/cryptography/ECDSA.sol";

// Messaging
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";

contract TokenPortal {
    using SafeERC20 for IERC20;

    event DepositToAztecPublic(
        bytes32 to,
        uint256 amount,
        uint256 fee,
        bytes32 secretHash,
        bytes32 key,
        uint256 index
    );

    event DepositToAztecPrivate(
        uint256 amount,
        uint256 fee,
        bytes32 secretHashForL2MessageConsumption,
        bytes32 key,
        uint256 index
    );

    event FeeUpdated(uint256 newFeeBasisPoints);
    event FeeRecipientUpdated(address newFeeRecipient);
    event FeesWithdrawn(address recipient, uint256 amount);

    IRegistry public registry;
    IERC20 public underlying;
    bytes32 public l2Bridge;

    IRollup public rollup;
    IOutbox public outbox;
    IInbox public inbox;
    uint256 public rollupVersion;

    address public humanIdAttester = 0xa74772264f896843c6346ceA9B13e0128A1d3b5D;
    uint256 public cleanHandsCircuitId =
        0x1c98fc4f7f1ad3805aefa81ad25fa466f8342292accf69566b43691d12742a19;
    // ADDRESS MUST BE SET PRIOR TO DEPLOYMENT
    address public passportSigner = 0xEa7D467E12B199E7D94EE7bda32335a0f9248315;
    mapping(address => mapping(uint256 => bool)) public passportNonces;

    // Fee management
    uint256 public feeBasisPoints; // Fee in basis points (1 bp = 0.01%, 100 bp = 1%)
    uint256 public constant MAX_FEE_BASIS_POINTS = 1000; // Max 10% fee
    address public feeRecipient;
    uint256 public collectedFees;
    address public owner;

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

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    /**
     * @notice Initialize the portal
     * @param _registry - The registry address
     * @param _underlying - The underlying token address
     * @param _l2Bridge - The L2 bridge address
     */
    function initialize(
        address _registry,
        address _underlying,
        bytes32 _l2Bridge
    ) external {
        require(owner == address(0), "Already initialized");

        registry = IRegistry(_registry);
        underlying = IERC20(_underlying);
        l2Bridge = _l2Bridge;

        rollup = IRollup(address(registry.getCanonicalRollup()));
        outbox = rollup.getOutbox();
        inbox = rollup.getInbox();
        rollupVersion = rollup.getVersion();

        owner = msg.sender;
        feeRecipient = msg.sender;
        feeBasisPoints = 10; // Default 0.1% fee
    }

    /**
     * @notice Update the fee percentage
     * @param _newFeeBasisPoints - New fee in basis points (100 = 1%)
     */
    function updateFee(uint256 _newFeeBasisPoints) external onlyOwner {
        require(_newFeeBasisPoints <= MAX_FEE_BASIS_POINTS, "Fee too high");
        feeBasisPoints = _newFeeBasisPoints;
        emit FeeUpdated(_newFeeBasisPoints);
    }

    /**
     * @notice Update the fee recipient address
     * @param _newFeeRecipient - New fee recipient address
     */
    function updateFeeRecipient(address _newFeeRecipient) external onlyOwner {
        require(_newFeeRecipient != address(0), "Invalid address");
        feeRecipient = _newFeeRecipient;
        emit FeeRecipientUpdated(_newFeeRecipient);
    }

    /**
     * @notice Withdraw collected fees
     */
    function withdrawFees() external onlyOwner {
        uint256 amount = collectedFees;
        require(amount > 0, "No fees to withdraw");

        collectedFees = 0;
        underlying.safeTransfer(feeRecipient, amount);

        emit FeesWithdrawn(feeRecipient, amount);
    }

    /**
     * @notice Calculate fee for a given amount
     * @param _amount - The amount to calculate fee for
     * @return fee - The calculated fee
     */
    function calculateFee(uint256 _amount) public view returns (uint256) {
        return (_amount * feeBasisPoints) / 10000;
    }

    /**
     * @notice Get the fee percentage as a decimal (e.g., 1.5 for 1.5%)
     * @return The fee percentage with 2 decimal precision
     */
    function getFeePercentage() external view returns (uint256) {
        return feeBasisPoints / 100;
    }

    /**
     * @notice Get total collected fees available for withdrawal
     * @return The total collected fees
     */
    function getCollectedFees() external view returns (uint256) {
        return collectedFees;
    }

    /**
     * @notice Get the current fee recipient address
     * @return The fee recipient address
     */
    function getFeeRecipient() external view returns (address) {
        return feeRecipient;
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
    ) internal view returns (bool) {
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

    /**
     * @notice Deposit funds into the portal and adds an L2 message which can only be consumed publicly on Aztec
     * @param _to - The aztec address of the recipient
     * @param _amount - The amount to deposit (BEFORE fees)
     * @param _secretHash - The hash of the secret consumable message
     * @return The key of the entry in the Inbox and its leaf index
     */
    function depositToAztecPublic(
        bytes32 _to,
        uint256 _amount,
        bytes32 _secretHash
    ) external returns (bytes32, uint256) {
        // Calculate fee
        uint256 fee = calculateFee(_amount);
        uint256 amountAfterFee = _amount - fee;

        // Preamble
        DataStructures.L2Actor memory actor = DataStructures.L2Actor(
            l2Bridge,
            rollupVersion
        );

        // Hash with amount AFTER fee (this is what gets minted on L2)
        bytes32 contentHash = Hash.sha256ToField(
            abi.encodeWithSignature(
                "mint_to_public(bytes32,uint256)",
                _to,
                amountAfterFee
            )
        );

        // Transfer full amount from user (including fee)
        underlying.safeTransferFrom(msg.sender, address(this), _amount);

        // Track collected fees
        collectedFees += fee;

        // Send message to rollup
        (bytes32 key, uint256 index) = inbox.sendL2Message(
            actor,
            contentHash,
            _secretHash
        );

        // Emit event
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

    /**
     * @notice Deposit funds into the portal and adds an L2 message which can only be consumed privately on Aztec
     * @param _amount - The amount to deposit (BEFORE fees)
     * @param _secretHashForL2MessageConsumption - The hash of the secret consumable L1 to L2 message
     * @param _cleanHands - The clean hands attestation data
     * @param _passport - The passport attestation data
     * @return The key of the entry in the Inbox and its leaf index
     */
    function depositToAztecPrivate(
        uint256 _amount,
        bytes32 _secretHashForL2MessageConsumption,
        CleanHandsData calldata _cleanHands,
        PassportData calldata _passport
    ) external returns (bytes32, uint256) {
        bool isCleanHands = false;
        if (_cleanHands.signature.length > 0) {
            if (
                verifyCleanHandsSignature(
                    cleanHandsCircuitId,
                    _cleanHands.actionId,
                    msg.sender,
                    _cleanHands.signature
                )
            ) {
                isCleanHands = true;
            }
        }
        if (!isCleanHands) {
            require(
                _passport.signature.length > 0,
                "No valid verification provided"
            );
            require(
                !passportNonces[msg.sender][_passport.nonce],
                "Passport nonce used"
            );
            bool isPassportValid = verifyPassportSignature(
                _passport.maxAmount,
                _passport.nonce,
                _passport.deadline,
                _passport.signature
            );

            require(isPassportValid, "Passport signature invalid");
            require(
                _amount <= _passport.maxAmount,
                "Amount exceeds Passport limit"
            );

            passportNonces[msg.sender][_passport.nonce] = true;
        }

        // Calculate fee
        uint256 fee = calculateFee(_amount);
        uint256 amountAfterFee = _amount - fee;

        // Preamble
        DataStructures.L2Actor memory actor = DataStructures.L2Actor(
            l2Bridge,
            rollupVersion
        );

        // Hash with amount AFTER fee (this is what gets minted on L2)
        bytes32 contentHash = Hash.sha256ToField(
            abi.encodeWithSignature("mint_to_private(uint256)", amountAfterFee)
        );

        // Transfer full amount from user (including fee)
        underlying.safeTransferFrom(msg.sender, address(this), _amount);

        // Track collected fees
        collectedFees += fee;

        // Send message to rollup
        (bytes32 key, uint256 index) = inbox.sendL2Message(
            actor,
            contentHash,
            _secretHashForL2MessageConsumption
        );

        // Emit event
        emit DepositToAztecPrivate(
            amountAfterFee,
            fee,
            _secretHashForL2MessageConsumption,
            key,
            index
        );

        return (key, index);
    }

    /**
     * @notice Withdraw funds from the portal
     * @dev Second part of withdraw, must be initiated from L2 first as it will consume a message from outbox
     * @param _recipient - The address to send the funds to
     * @param _amount - The amount to withdraw from L2 (the amount burned on L2)
     * @param _withCaller - Flag to use `msg.sender` as caller, otherwise address(0)
     * @param _l2BlockNumber - The L2 block number
     * @param _leafIndex - The leaf index
     * @param _path - The merkle path
     */
    function withdraw(
        address _recipient,
        uint256 _amount,
        bool _withCaller,
        uint256 _l2BlockNumber,
        uint256 _leafIndex,
        bytes32[] calldata _path
    ) external {
        // Message validation - must match what was sent from L2
        // L2 sends the amount it burned (gross amount)
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

        // Calculate fee on L1 from the bridged amount
        uint256 fee = calculateFee(_amount);
        uint256 amountAfterFee = _amount - fee;

        // Track collected fees
        collectedFees += fee;

        // Transfer amount after fee to recipient
        underlying.safeTransfer(_recipient, amountAfterFee);
    }
}
