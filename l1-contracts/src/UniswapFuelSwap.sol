// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
}

/**
 * @title UniswapFuelSwap
 * @notice Swaps ERC-20 tokens for FeeJuice (AZTEC) via Uniswap V4 PoolManager.
 *         Designed to be called by BridgeAndFuel via `swapTarget.call(swapData)`.
 *         Supports single-hop (e.g. WETH→AZTEC) and multi-hop (e.g. USDC→WETH→AZTEC).
 *         Supports pools keyed to native ETH (address(0)) by unwrapping WETH internally.
 */
contract UniswapFuelSwap is IUnlockCallback {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;
    address public immutable feeJuice;
    address public immutable weth;
    address public owner;

    bool private _locked;

    modifier nonReentrant() {
        require(!_locked, "UniswapFuelSwap: reentrant");
        _locked = true;
        _;
        _locked = false;
    }

    constructor(address _poolManager, address _feeJuice, address _weth) {
        poolManager = IPoolManager(_poolManager);
        feeJuice = _feeJuice;
        weth = _weth;
        owner = msg.sender;
    }

    /// @dev Accept ETH from WETH.withdraw() and PoolManager.take() for native ETH routes.
    receive() external payable {}

    /**
     * @notice Swap inputToken for FeeJuice via Uniswap V4.
     * @param inputToken  The ERC-20 token to sell (pulled via transferFrom).
     * @param inputAmount Exact amount of inputToken to swap.
     * @param minOutput   Minimum FeeJuice output (slippage protection).
     * @param path        Ordered PoolKey array describing the swap route.
     * @param zeroForOnes Swap direction per hop (true = sell currency0 for currency1).
     * @return output     Amount of FeeJuice received.
     */
    function swap(
        address inputToken,
        uint256 inputAmount,
        uint256 minOutput,
        PoolKey[] calldata path,
        bool[] calldata zeroForOnes
    ) external nonReentrant returns (uint256 output) {
        require(path.length > 0, "UniswapFuelSwap: empty path");
        require(path.length == zeroForOnes.length, "UniswapFuelSwap: path/direction mismatch");

        // Pull input tokens from caller (BridgeAndFuel approved us)
        IERC20(inputToken).safeTransferFrom(msg.sender, address(this), inputAmount);

        // Encode callback context
        bytes memory data = abi.encode(inputToken, inputAmount, path, zeroForOnes);

        // Initiate V4 unlock — PoolManager calls unlockCallback
        bytes memory result = poolManager.unlock(data);
        output = abi.decode(result, (uint256));

        require(output >= minOutput, "UniswapFuelSwap: insufficient output");

        // Transfer FeeJuice to caller (BridgeAndFuel)
        IERC20(feeJuice).safeTransfer(msg.sender, output);
    }

    /**
     * @notice PoolManager callback — executes swaps inside the unlock context.
     * @dev Only callable by the PoolManager.
     */
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "UniswapFuelSwap: unauthorized callback");

        (
            address inputToken,
            uint256 inputAmount,
            PoolKey[] memory path,
            bool[] memory zeroForOnes
        ) = abi.decode(data, (address, uint256, PoolKey[], bool[]));

        bool lastPoolNative = _hasNativeEth(path[path.length - 1]);
        uint256 currentAmount = inputAmount;
        uint256 ethBridgeAmount;

        for (uint256 i = 0; i < path.length; i++) {
            // Save the intermediate amount before the last (native ETH) hop
            if (lastPoolNative && i == path.length - 1) {
                ethBridgeAmount = currentAmount;
            }

            // Exact input swap: negative amountSpecified = exact input
            BalanceDelta delta = poolManager.swap(
                path[i],
                IPoolManager.SwapParams({
                    zeroForOne: zeroForOnes[i],
                    amountSpecified: -int256(currentAmount),
                    sqrtPriceLimitX96: zeroForOnes[i]
                        ? TickMath.MIN_SQRT_PRICE + 1
                        : TickMath.MAX_SQRT_PRICE - 1
                }),
                ""
            );

            // Output is the positive delta (token we receive)
            int128 outputDelta = zeroForOnes[i] ? delta.amount1() : delta.amount0();
            require(outputDelta > 0, "UniswapFuelSwap: non-positive output");
            currentAmount = uint256(int256(outputDelta));
        }

        // Settlement based on route type
        if (lastPoolNative) {
            if (path.length == 1) {
                // Case B: Single hop native — contract holds WETH from swap(), unwrap and settle
                IWETH(weth).withdraw(inputAmount);
                poolManager.settle{value: inputAmount}();
            } else {
                // Case C: Multi-hop, last pool native — settle input ERC-20, bridge WETH→ETH
                poolManager.sync(Currency.wrap(inputToken));
                IERC20(inputToken).safeTransfer(address(poolManager), inputAmount);
                poolManager.settle();

                poolManager.take(Currency.wrap(weth), address(this), ethBridgeAmount);
                IWETH(weth).withdraw(ethBridgeAmount);
                poolManager.settle{value: ethBridgeAmount}();
            }
        } else {
            // Case A: All ERC-20 (unchanged)
            poolManager.sync(Currency.wrap(inputToken));
            IERC20(inputToken).safeTransfer(address(poolManager), inputAmount);
            poolManager.settle();
        }

        // Take output FeeJuice (always ERC-20)
        poolManager.take(Currency.wrap(feeJuice), address(this), currentAmount);

        return abi.encode(currentAmount);
    }

    function _hasNativeEth(PoolKey memory key) internal pure returns (bool) {
        return Currency.unwrap(key.currency0) == address(0)
            || Currency.unwrap(key.currency1) == address(0);
    }

    /// @notice Emergency sweep for stuck tokens or ETH (owner only).
    function sweep(address token, address to) external {
        require(msg.sender == owner, "UniswapFuelSwap: not owner");
        if (token == address(0)) {
            uint256 bal = address(this).balance;
            if (bal > 0) payable(to).transfer(bal);
        } else {
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal > 0) IERC20(token).safeTransfer(to, bal);
        }
    }
}
