// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@oz/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";

interface IFeeAssetHandler {
    function mint(address _recipient) external;
}

/**
 * @title MockFuelSwap
 * @notice Devnet mock: takes an input token and provides FeeJuice at a configurable rate.
 *         Uses the Aztec FeeAssetHandler (public mint) to acquire FeeJuice, then transfers
 *         the exact output amount to the caller. Works without needing direct minter role.
 */
contract MockFuelSwap {
    using SafeERC20 for IERC20;

    IERC20 public immutable feeJuice;
    IFeeAssetHandler public immutable feeAssetHandler;
    uint256 public immutable rate; // scaled to 1e18; output = inputAmount * rate / 1e18

    constructor(address _feeJuice, address _feeAssetHandler, uint256 _rate) {
        require(_feeJuice != address(0), "MockFuelSwap: zero feeJuice");
        require(_feeAssetHandler != address(0), "MockFuelSwap: zero handler");
        require(_rate > 0, "MockFuelSwap: zero rate");
        feeJuice = IERC20(_feeJuice);
        feeAssetHandler = IFeeAssetHandler(_feeAssetHandler);
        rate = _rate;
    }

    /**
     * @notice Swap inputToken for FeeJuice.
     * @param inputToken  ERC20 token to take from caller.
     * @param inputAmount Amount of inputToken to pull.
     * @param minOutput   Minimum FeeJuice output (slippage protection).
     * @return output     FeeJuice amount transferred to caller.
     */
    function swap(address inputToken, uint256 inputAmount, uint256 minOutput) external returns (uint256 output) {
        uint8 tokenDecimals = IERC20Metadata(inputToken).decimals();
        uint256 normalized = inputAmount * (10 ** (18 - tokenDecimals));
        output = (normalized * rate) / 1e18;
        require(output >= minOutput, "MockFuelSwap: insufficient output");

        IERC20(inputToken).safeTransferFrom(msg.sender, address(this), inputAmount);

        // Mint FeeJuice via handler if balance is insufficient
        while (feeJuice.balanceOf(address(this)) < output) {
            feeAssetHandler.mint(address(this));
        }

        feeJuice.transfer(msg.sender, output);
    }
}
