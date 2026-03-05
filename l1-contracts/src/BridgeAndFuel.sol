// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {IFeeJuicePortal} from "@aztec/core/interfaces/IFeeJuicePortal.sol";
import {ITokenPortal} from "./interfaces/ITokenPortal.sol";

/**
 * @title BridgeAndFuel
 * @notice Stateless orchestrator: swaps a portion of bridged tokens for Fee Juice,
 *         deposits Fee Juice via FeeJuicePortal, and deposits the remainder via TokenPortal —
 *         all in one atomic L1 transaction.
 */
contract BridgeAndFuel {
    using SafeERC20 for IERC20;

    struct BridgeParams {
        address tokenPortal;
        address bridgeToken;
        uint256 totalAmount;
        uint256 fuelAmount;
        bytes32 aztecRecipient;
        bytes32 tokenSecretHash;
        bytes32 fuelSecretHash;
        address feeJuicePortal;
        address swapTarget;
        address swapAllowanceTarget;
        uint256 minFuelOutput;
    }

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

    /**
     * @notice Bridge tokens to Aztec L2, swapping a portion for Fee Juice gas.
     */
    function bridgeWithFuel(BridgeParams calldata p, bytes calldata swapData) external {
        require(p.totalAmount > 0, "BridgeAndFuel: zero amount");
        require(p.fuelAmount > 0 && p.fuelAmount < p.totalAmount, "BridgeAndFuel: invalid fuelAmount");

        IERC20 token = IERC20(p.bridgeToken);
        uint256 bridgeAmount = p.totalAmount - p.fuelAmount;

        // 1. Pull total tokens from user
        token.safeTransferFrom(msg.sender, address(this), p.totalAmount);

        // 2. Swap fuelAmount for Fee Juice
        token.forceApprove(p.swapAllowanceTarget, p.fuelAmount);
        (bool swapOk,) = p.swapTarget.call(swapData);
        require(swapOk, "BridgeAndFuel: swap failed");
        token.forceApprove(p.swapAllowanceTarget, 0);

        // 3. Check we received enough Fee Juice & deposit via FeeJuicePortal
        bytes32 fuelKey;
        uint256 fuelIndex;
        uint256 fuelReceived;
        {
            IERC20 feeJuiceToken = IFeeJuicePortal(p.feeJuicePortal).UNDERLYING();
            fuelReceived = feeJuiceToken.balanceOf(address(this));
            require(fuelReceived >= p.minFuelOutput, "BridgeAndFuel: insufficient fuel output");

            feeJuiceToken.forceApprove(p.feeJuicePortal, fuelReceived);
            (fuelKey, fuelIndex) =
                IFeeJuicePortal(p.feeJuicePortal).depositToAztecPublic(p.aztecRecipient, fuelReceived, p.fuelSecretHash);
        }

        // 4. Deposit remaining tokens via TokenPortal
        token.forceApprove(p.tokenPortal, bridgeAmount);
        (bytes32 tokenKey, uint256 tokenIndex) =
            ITokenPortal(p.tokenPortal).depositToAztecPublic(p.aztecRecipient, bridgeAmount, p.tokenSecretHash);

        // 5. Emit composite event
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
}
