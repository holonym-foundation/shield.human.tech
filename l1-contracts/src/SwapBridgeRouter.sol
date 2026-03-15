// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@oz/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@oz/utils/ReentrancyGuard.sol";
import {IFeeJuicePortal} from "@aztec/core/interfaces/IFeeJuicePortal.sol";
import {ITokenPortal} from "./interfaces/ITokenPortal.sol";

// ─── TokenPortal Private Deposit Interface ───────────────────────────

/// @notice Attestation structs matching TokenPortal's private deposit requirements.
struct CleanHandsData {
    uint256 nonce;
    uint256 actionId;
    bytes signature;
}

struct PassportData {
    uint256 maxAmount;
    uint256 nonce;
    uint256 deadline;
    bytes signature;
}

interface ITokenPortalPrivate {
    function depositToAztecPrivate(
        uint256 _amount,
        bytes32 _secretHashForL2MessageConsumption,
        CleanHandsData calldata _cleanHands,
        PassportData calldata _passport
    ) external returns (bytes32, uint256);

    function depositToAztecPrivateFor(
        address _depositor,
        uint256 _amount,
        bytes32 _secretHashForL2MessageConsumption,
        CleanHandsData calldata _cleanHands,
        PassportData calldata _passport
    ) external returns (bytes32, uint256);
}

// ─── Minimal Permit2 Interface ───────────────────────────────────────

/// @notice Permit2 SignatureTransfer — one-time signed transfers.
/// @dev Canonical address: 0x000000000022D473030F116dDEE9F6B43aC78BA3
interface ISignatureTransfer {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    /// @notice Transfer tokens using a signed permit. Nonce is consumed on use.
    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;
}

// ─── Minimal UniswapFuelSwap Interface ───────────────────────────────

interface IUniswapFuelSwap {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    function swap(
        address inputToken,
        uint256 inputAmount,
        uint256 minOutput,
        PoolKey[] calldata path,
        bool[] calldata zeroForOnes
    ) external returns (uint256 output);
}

/**
 * @title SwapBridgeRouter
 * @notice Permit2-enabled periphery that atomically:
 *         1. Pulls tokens from user via Permit2 SignatureTransfer
 *         2. Swaps a portion for FeeJuice via UniswapFuelSwap
 *         3. Deposits FeeJuice to L2 via FeeJuicePortal
 *         4. Deposits remaining tokens to L2 via TokenPortal
 *
 *         All in one atomic L1 transaction, requiring only one signature + one tx.
 *
 * @dev    Unlike BridgeAndFuel (which uses arbitrary `.call(swapData)`), this contract
 *         hardcodes the swap target and calls it with typed parameters — eliminating
 *         the arbitrary external call attack surface.
 *
 *         The swap target can be updated by the owner (governance) to support
 *         future pool migrations.
 */
contract SwapBridgeRouter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── State ───────────────────────────────────────────────────────
    ISignatureTransfer public immutable permit2;
    IFeeJuicePortal public immutable feeJuicePortal;
    IUniswapFuelSwap public swapTarget;

    // ─── Events ──────────────────────────────────────────────────────
    event BridgeWithFuel(
        bytes32 indexed aztecRecipient,
        bytes32 tokenKey,
        uint256 tokenIndex,
        uint256 tokenAmount,
        bytes32 tokenSecretHash,
        bytes32 fuelKey,
        uint256 fuelIndex,
        uint256 fuelAmount,
        bytes32 fuelSecretHash
    );

    event Bridge(
        bytes32 indexed aztecRecipient,
        bytes32 key,
        uint256 index,
        uint256 amount,
        bytes32 secretHash
    );

    event SwapTargetUpdated(address indexed oldTarget, address indexed newTarget);

    // ─── Structs ─────────────────────────────────────────────────────

    struct BridgeParams {
        address tokenPortal;
        address bridgeToken;
        uint256 totalAmount;
        uint256 fuelAmount;
        bytes32 aztecRecipient;
        bytes32 tokenSecretHash;
        bytes32 fuelSecretHash;
        uint256 minFuelOutput;
        IUniswapFuelSwap.PoolKey[] path;
        bool[] zeroForOnes;
        bool isPrivate;
        CleanHandsData cleanHands;
        PassportData passport;
    }

    struct SimpleBridgeParams {
        address tokenPortal;
        address bridgeToken;
        uint256 amount;
        bytes32 aztecRecipient;
        bytes32 secretHash;
        bool isPrivate;
        CleanHandsData cleanHands;
        PassportData passport;
    }

    struct PermitParams {
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    // ─── Constructor ─────────────────────────────────────────────────

    constructor(
        address _permit2,
        address _feeJuicePortal,
        address _swapTarget
    ) Ownable(msg.sender) {
        require(_permit2 != address(0), "SwapBridgeRouter: zero permit2");
        require(_feeJuicePortal != address(0), "SwapBridgeRouter: zero feeJuicePortal");
        require(_swapTarget != address(0), "SwapBridgeRouter: zero swapTarget");

        permit2 = ISignatureTransfer(_permit2);
        feeJuicePortal = IFeeJuicePortal(_feeJuicePortal);
        swapTarget = IUniswapFuelSwap(_swapTarget);
    }

    // ─── Governance ──────────────────────────────────────────────────

    /**
     * @notice Update the swap target contract (e.g., after pool migration).
     * @param _newSwapTarget New UniswapFuelSwap contract address.
     */
    function setSwapTarget(address _newSwapTarget) external onlyOwner {
        require(_newSwapTarget != address(0), "SwapBridgeRouter: zero swapTarget");
        address old = address(swapTarget);
        swapTarget = IUniswapFuelSwap(_newSwapTarget);
        emit SwapTargetUpdated(old, _newSwapTarget);
    }

    // ─── Core Logic ──────────────────────────────────────────────────

    /**
     * @notice Bridge tokens to Aztec L2, swapping a portion for Fee Juice gas.
     *         Pulls tokens from user via Permit2, executes swap, deposits both.
     *
     * @param p      Bridge parameters (portal, amounts, L2 recipient, swap route).
     * @param permit Permit2 signature parameters (nonce, deadline, signature).
     */
    function bridgeWithFuel(
        BridgeParams calldata p,
        PermitParams calldata permit
    ) external nonReentrant {
        require(p.totalAmount > 0, "SwapBridgeRouter: zero amount");
        require(p.fuelAmount > 0 && p.fuelAmount < p.totalAmount, "SwapBridgeRouter: invalid fuelAmount");
        require(p.path.length > 0, "SwapBridgeRouter: empty path");
        require(p.path.length == p.zeroForOnes.length, "SwapBridgeRouter: path/direction mismatch");
        require(p.tokenPortal != address(0), "SwapBridgeRouter: zero tokenPortal");

        uint256 bridgeAmount = p.totalAmount - p.fuelAmount;

        // 1. Pull tokens from user via Permit2 SignatureTransfer
        permit2.permitTransferFrom(
            ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({
                    token: p.bridgeToken,
                    amount: p.totalAmount
                }),
                nonce: permit.nonce,
                deadline: permit.deadline
            }),
            ISignatureTransfer.SignatureTransferDetails({
                to: address(this),
                requestedAmount: p.totalAmount
            }),
            msg.sender,
            permit.signature
        );

        // 2. Swap fuel portion for FeeJuice via UniswapFuelSwap
        IERC20 token = IERC20(p.bridgeToken);
        IERC20 feeJuiceToken = feeJuicePortal.UNDERLYING();
        uint256 fjBalBefore = feeJuiceToken.balanceOf(address(this));

        token.forceApprove(address(swapTarget), p.fuelAmount);
        uint256 fuelReceived = swapTarget.swap(
            p.bridgeToken,
            p.fuelAmount,
            p.minFuelOutput,
            p.path,
            p.zeroForOnes
        );
        token.forceApprove(address(swapTarget), 0);

        // Verify actual balance change (defense-in-depth against swap bugs)
        uint256 fjBalAfter = feeJuiceToken.balanceOf(address(this));
        require(fjBalAfter - fjBalBefore >= fuelReceived, "SwapBridgeRouter: balance mismatch");

        // 3. Deposit FeeJuice to L2 via FeeJuicePortal
        bytes32 fuelKey;
        uint256 fuelIndex;
        {
            feeJuiceToken.forceApprove(address(feeJuicePortal), fuelReceived);
            (fuelKey, fuelIndex) = feeJuicePortal.depositToAztecPublic(
                p.aztecRecipient,
                fuelReceived,
                p.fuelSecretHash
            );
            feeJuiceToken.forceApprove(address(feeJuicePortal), 0);
        }

        // 4. Deposit remaining tokens to L2 via TokenPortal
        bytes32 tokenKey;
        uint256 tokenIndex;
        token.forceApprove(p.tokenPortal, bridgeAmount);
        if (p.isPrivate) {
            (tokenKey, tokenIndex) = ITokenPortalPrivate(p.tokenPortal).depositToAztecPrivateFor(
                msg.sender,
                bridgeAmount,
                p.tokenSecretHash,
                p.cleanHands,
                p.passport
            );
        } else {
            (tokenKey, tokenIndex) = ITokenPortal(p.tokenPortal).depositToAztecPublic(
                p.aztecRecipient,
                bridgeAmount,
                p.tokenSecretHash
            );
        }
        token.forceApprove(p.tokenPortal, 0);

        // 5. Emit composite event (same shape as BridgeAndFuel for frontend compatibility)
        emit BridgeWithFuel(
            p.aztecRecipient,
            tokenKey,
            tokenIndex,
            bridgeAmount,
            p.tokenSecretHash,
            fuelKey,
            fuelIndex,
            fuelReceived,
            p.fuelSecretHash
        );
    }

    /**
     * @notice Bridge tokens to Aztec L2 without fuel swap (public or private deposit).
     *         Pulls tokens from user via Permit2, deposits via TokenPortal.
     *
     * @param p      Simple bridge parameters (portal, amount, L2 recipient, attestations).
     * @param permit Permit2 signature parameters (nonce, deadline, signature).
     */
    function bridge(
        SimpleBridgeParams calldata p,
        PermitParams calldata permit
    ) external nonReentrant {
        require(p.amount > 0, "SwapBridgeRouter: zero amount");
        require(p.tokenPortal != address(0), "SwapBridgeRouter: zero tokenPortal");

        // 1. Pull tokens from user via Permit2 SignatureTransfer
        permit2.permitTransferFrom(
            ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({
                    token: p.bridgeToken,
                    amount: p.amount
                }),
                nonce: permit.nonce,
                deadline: permit.deadline
            }),
            ISignatureTransfer.SignatureTransferDetails({
                to: address(this),
                requestedAmount: p.amount
            }),
            msg.sender,
            permit.signature
        );

        // 2. Approve TokenPortal and deposit
        IERC20(p.bridgeToken).forceApprove(p.tokenPortal, p.amount);

        bytes32 key;
        uint256 index;
        if (p.isPrivate) {
            (key, index) = ITokenPortalPrivate(p.tokenPortal).depositToAztecPrivateFor(
                msg.sender,
                p.amount,
                p.secretHash,
                p.cleanHands,
                p.passport
            );
        } else {
            (key, index) = ITokenPortal(p.tokenPortal).depositToAztecPublic(
                p.aztecRecipient,
                p.amount,
                p.secretHash
            );
        }

        // 3. Clear approval
        IERC20(p.bridgeToken).forceApprove(p.tokenPortal, 0);

        // 4. Emit event
        emit Bridge(p.aztecRecipient, key, index, p.amount, p.secretHash);
    }

    // ─── Emergency Sweep ─────────────────────────────────────────────

    /**
     * @notice Sweep stuck tokens or ETH. Owner-only safety valve.
     */
    function sweep(address token, address to) external onlyOwner nonReentrant {
        require(to != address(0), "SwapBridgeRouter: zero recipient");

        if (token == address(0)) {
            uint256 bal = address(this).balance;
            if (bal > 0) {
                (bool ok,) = payable(to).call{value: bal}("");
                require(ok, "SwapBridgeRouter: ETH transfer failed");
            }
        } else {
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal > 0) IERC20(token).safeTransfer(to, bal);
        }
    }
}
