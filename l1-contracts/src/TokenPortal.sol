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
        bytes32 secretHash,
        bytes32 key,
        uint256 index
    );

    event DepositToAztecPrivate(
        uint256 amount,
        bytes32 secretHashForL2MessageConsumption,
        bytes32 key,
        uint256 index
    );

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
    address public passportSigner = 0xEa7D467E12B199E7D94EE7bda32335a0f9248315; // ADDRESS MUST BE SET PRIOR TO DEPLOYMENT
    mapping(address => mapping(uint256 => bool)) public passportNonces;

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
        registry = IRegistry(_registry);
        underlying = IERC20(_underlying);
        l2Bridge = _l2Bridge;

        rollup = IRollup(address(registry.getCanonicalRollup()));
        outbox = rollup.getOutbox();
        inbox = rollup.getInbox();
        rollupVersion = rollup.getVersion();
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

        // Reconstruct hash: User + MaxAmount + Nonce + Deadline + Chain/Contract scope
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
    // docs:start:deposit_public
    /**
     * @notice Deposit funds into the portal and adds an L2 message which can only be consumed publicly on Aztec
     * @param _to - The aztec address of the recipient
     * @param _amount - The amount to deposit
     * @param _secretHash - The hash of the secret consumable message. The hash should be 254 bits (so it can fit in a
     * Field element)
     * @param _cleanHands - The clean hands attestation data
     * @param _passport - The passport attestation data
     * @return The key of the entry in the Inbox and its leaf index
     */
    function depositToAztecPublic(
        bytes32 _to,
        uint256 _amount,
        bytes32 _secretHash,
        CleanHandsData calldata _cleanHands,
        PassportData calldata _passport
    )
        external
        returns (bytes32, uint256) // docs:end:deposit_public
    {
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

            // Consume Nonce only if we relied on Passport logic
            passportNonces[msg.sender][_passport.nonce] = true;
        }

        // Preamble
        DataStructures.L2Actor memory actor = DataStructures.L2Actor(
            l2Bridge,
            rollupVersion
        );

        // Hash the message content to be reconstructed in the receiving contract
        // The purpose of including the function selector is to make the message unique to that specific call. Note that
        // it has nothing to do with calling the function.
        bytes32 contentHash = Hash.sha256ToField(
            abi.encodeWithSignature(
                "mint_to_public(bytes32,uint256)",
                _to,
                _amount
            )
        );

        // Hold the tokens in the portal
        underlying.safeTransferFrom(msg.sender, address(this), _amount);

        // Send message to rollup
        (bytes32 key, uint256 index) = inbox.sendL2Message(
            actor,
            contentHash,
            _secretHash
        );

        // Emit event
        emit DepositToAztecPublic(_to, _amount, _secretHash, key, index);

        return (key, index);
    }

    // docs:start:deposit_private
    /**
     * @notice Deposit funds into the portal and adds an L2 message which can only be consumed privately on Aztec
     * @param _amount - The amount to deposit
     * @param _secretHashForL2MessageConsumption - The hash of the secret consumable L1 to L2 message. The hash should be
     * 254 bits (so it can fit in a Field element)
     * @param _cleanHands - The clean hands attestation data
     * @param _passport - The passport attestation data
     * @return The key of the entry in the Inbox and its leaf index
     */
    function depositToAztecPrivate(
        uint256 _amount,
        bytes32 _secretHashForL2MessageConsumption,
        CleanHandsData calldata _cleanHands,
        PassportData calldata _passport
    )
        external
        returns (bytes32, uint256) // docs:end:deposit_private
    {
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

            // Consume Nonce only if we relied on Passport logic
            passportNonces[msg.sender][_passport.nonce] = true;
        }
        // Preamble
        DataStructures.L2Actor memory actor = DataStructures.L2Actor(
            l2Bridge,
            rollupVersion
        );

        // Hash the message content to be reconstructed in the receiving contract - the signature below does not correspond
        // to a real function. It's just an identifier of an action.
        bytes32 contentHash = Hash.sha256ToField(
            abi.encodeWithSignature("mint_to_private(uint256)", _amount)
        );

        // Hold the tokens in the portal
        underlying.safeTransferFrom(msg.sender, address(this), _amount);

        // Send message to rollup
        (bytes32 key, uint256 index) = inbox.sendL2Message(
            actor,
            contentHash,
            _secretHashForL2MessageConsumption
        );

        // Emit event
        emit DepositToAztecPrivate(
            _amount,
            _secretHashForL2MessageConsumption,
            key,
            index
        );

        return (key, index);
    }

    // docs:start:token_portal_withdraw
    /**
     * @notice Withdraw funds from the portal
     * @dev Second part of withdraw, must be initiated from L2 first as it will consume a message from outbox
     * @param _recipient - The address to send the funds to
     * @param _amount - The amount to withdraw
     * @param _withCaller - Flag to use `msg.sender` as caller, otherwise address(0)
     * @param _l2BlockNumber - The address to send the funds to
     * @param _leafIndex - The amount to withdraw
     * @param _path - Flag to use `msg.sender` as caller, otherwise address(0)
     * Must match the caller of the message (specified from L2) to consume it.
     */
    function withdraw(
        address _recipient,
        uint256 _amount,
        bool _withCaller,
        uint256 _l2BlockNumber,
        uint256 _leafIndex,
        bytes32[] calldata _path
    ) external {
        // The purpose of including the function selector is to make the message unique to that specific call. Note that
        // it has nothing to do with calling the function.
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

        underlying.safeTransfer(_recipient, _amount);
    }
    // docs:end:token_portal_withdraw
}
