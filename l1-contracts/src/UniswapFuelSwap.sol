// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@oz/access/Ownable2Step.sol";
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
 *         Designed to be called by SwapBridgeRouter via a typed interface.
 *
 *         Supported routes:
 *           - Single-hop ERC-20:  WETH → AZTEC  (WETH/AZTEC pool)
 *           - Single-hop native:  WETH → ETH → AZTEC  (native ETH/AZTEC pool, auto-unwrap)
 *           - Multi-hop ERC-20:   USDC → WETH → AZTEC
 *           - Multi-hop native:   USDC → WETH → ETH → AZTEC  (last pool uses native ETH)
 *
 * @dev    Implements IUnlockCallback for V4's flash-accounting pattern.
 *         Only the PoolManager may call unlockCallback.
 */
contract UniswapFuelSwap is IUnlockCallback, Ownable2Step {
    using SafeERC20 for IERC20;

    // ─── Immutables ──────────────────────────────────────────────────
    IPoolManager public immutable poolManager;
    address public immutable feeJuice;
    address public immutable weth;

    // ─── Reentrancy guard ────────────────────────────────────────────
    bool private _locked;

    modifier nonReentrant() {
        require(!_locked, "UniswapFuelSwap: reentrant");
        _locked = true;
        _;
        _locked = false;
    }

    // ─── Events ──────────────────────────────────────────────────────
    event SwapExecuted(
        address indexed caller,
        address indexed inputToken,
        uint256 inputAmount,
        uint256 outputAmount
    );

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(
        address _poolManager,
        address _feeJuice,
        address _weth
    ) Ownable(msg.sender) {
        require(_poolManager != address(0), "UniswapFuelSwap: zero poolManager");
        require(_feeJuice != address(0), "UniswapFuelSwap: zero feeJuice");
        require(_weth != address(0), "UniswapFuelSwap: zero weth");

        poolManager = IPoolManager(_poolManager);
        feeJuice = _feeJuice;
        weth = _weth;
    }

    /// @dev Accept ETH from WETH.withdraw() and PoolManager.take() for native ETH routes.
    receive() external payable {}

    // ─── External API ────────────────────────────────────────────────

    /**
     * @notice Swap inputToken for FeeJuice via one or more Uniswap V4 pools.
     * @param inputToken  The ERC-20 token to sell (caller must have approved this contract).
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
        require(inputAmount > 0, "UniswapFuelSwap: zero input");
        require(inputAmount <= uint256(type(int256).max), "UniswapFuelSwap: input overflow");
        _validateRoute(inputToken, path, zeroForOnes);

        // Pull input tokens from caller (SwapBridgeRouter approved this contract)
        IERC20(inputToken).safeTransferFrom(msg.sender, address(this), inputAmount);

        // Encode callback context and initiate V4 unlock
        bytes memory data = abi.encode(inputToken, inputAmount, path, zeroForOnes);
        bytes memory result = poolManager.unlock(data);
        output = abi.decode(result, (uint256));

        require(output >= minOutput, "UniswapFuelSwap: insufficient output");

        // Transfer FeeJuice to caller (SwapBridgeRouter)
        IERC20(feeJuice).safeTransfer(msg.sender, output);

        emit SwapExecuted(msg.sender, inputToken, inputAmount, output);
    }

    // ─── V4 Callback ─────────────────────────────────────────────────

    /**
     * @notice PoolManager callback — executes swaps inside the unlock context.
     * @dev Only callable by the PoolManager. Performs multi-hop swaps using
     *      flash accounting (deltas settled at the end, no intermediate transfers).
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
        uint256 actualInputConsumed;

        // ── Execute each hop ─────────────────────────────────────────
        for (uint256 i = 0; i < path.length; i++) {
            // Track amount entering last (native ETH) hop for WETH→ETH bridging
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

            // Track actual input consumed from the first hop (V4 may partial-fill)
            if (i == 0) {
                int128 inputDelta = zeroForOnes[i] ? delta.amount0() : delta.amount1();
                require(inputDelta < 0, "UniswapFuelSwap: non-negative input delta");
                actualInputConsumed = uint256(uint128(-inputDelta));
                require(actualInputConsumed == inputAmount, "UniswapFuelSwap: partial fill (insufficient liquidity)");
            }

            // Output is the positive delta (token we receive from the pool)
            int128 outputDelta = zeroForOnes[i] ? delta.amount1() : delta.amount0();
            require(outputDelta > 0, "UniswapFuelSwap: non-positive output");
            currentAmount = uint256(int256(outputDelta));
        }

        // ── Settlement ───────────────────────────────────────────────
        _settle(inputToken, inputAmount, lastPoolNative, ethBridgeAmount, path);

        // Take output FeeJuice (always ERC-20)
        poolManager.take(Currency.wrap(feeJuice), address(this), currentAmount);

        return abi.encode(currentAmount);
    }

    // ─── Settlement Logic ────────────────────────────────────────────

    /**
     * @dev Settle all input-side deltas depending on route type.
     *
     *   Case A — All ERC-20 route (no native ETH):
     *     Transfer input token to PoolManager, settle.
     *
     *   Case B — Single-hop native (WETH → ETH/AZTEC pool):
     *     Unwrap WETH to ETH, settle with msg.value.
     *
     *   Case C — Multi-hop, last pool native (e.g. USDC → WETH, then ETH/AZTEC):
     *     Settle input ERC-20 for first hop(s), take intermediate WETH,
     *     unwrap WETH to ETH, settle ETH for last hop.
     */
    function _settle(
        address inputToken,
        uint256 inputAmount,
        bool lastPoolNative,
        uint256 ethBridgeAmount,
        PoolKey[] memory path
    ) internal {
        if (!lastPoolNative) {
            // Case A: All ERC-20 — settle input token directly
            poolManager.sync(Currency.wrap(inputToken));
            IERC20(inputToken).safeTransfer(address(poolManager), inputAmount);
            poolManager.settle();
        } else if (path.length == 1) {
            // Case B: Single-hop native — contract holds WETH from swap(), unwrap and settle
            IWETH(weth).withdraw(inputAmount);
            poolManager.settle{value: inputAmount}();
        } else {
            // Case C: Multi-hop, last pool native
            // 1. Settle the input ERC-20 for the first hop(s)
            poolManager.sync(Currency.wrap(inputToken));
            IERC20(inputToken).safeTransfer(address(poolManager), inputAmount);
            poolManager.settle();

            // 2. Take intermediate WETH from PoolManager, unwrap, settle ETH
            poolManager.take(Currency.wrap(weth), address(this), ethBridgeAmount);
            IWETH(weth).withdraw(ethBridgeAmount);
            poolManager.settle{value: ethBridgeAmount}();
        }
    }

    // ─── Route Validation ──────────────────────────────────────────

    /**
     * @dev Validate that the swap route is well-formed:
     *      1. First hop sells inputToken (or WETH for native-ETH single-hop).
     *      2. Last hop outputs feeJuice.
     *      3. Native ETH single-hop requires inputToken == weth.
     */
    function _validateRoute(
        address inputToken,
        PoolKey[] calldata path,
        bool[] calldata zeroForOnes
    ) internal view {
        // First hop must sell inputToken
        PoolKey calldata first = path[0];
        address firstInput = zeroForOnes[0]
            ? Currency.unwrap(first.currency0)
            : Currency.unwrap(first.currency1);

        // For native ETH pools, the input side is address(0) which maps to WETH
        if (firstInput == address(0)) {
            require(inputToken == weth, "UniswapFuelSwap: native route requires WETH input");
        } else {
            require(firstInput == inputToken, "UniswapFuelSwap: first hop input mismatch");
        }

        // Last hop must output feeJuice
        PoolKey calldata last = path[path.length - 1];
        address lastOutput = zeroForOnes[path.length - 1]
            ? Currency.unwrap(last.currency1)
            : Currency.unwrap(last.currency0);
        require(lastOutput == feeJuice, "UniswapFuelSwap: last hop must output feeJuice");
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    function _hasNativeEth(PoolKey memory key) internal pure returns (bool) {
        return Currency.unwrap(key.currency0) == address(0)
            || Currency.unwrap(key.currency1) == address(0);
    }

    // ─── Emergency Sweep ─────────────────────────────────────────────

    /**
     * @notice Sweep stuck tokens or ETH to a recipient. Owner-only safety valve.
     * @param token Address of token to sweep (address(0) for ETH).
     * @param to    Recipient address.
     */
    function sweep(address token, address to) external onlyOwner {
        require(to != address(0), "UniswapFuelSwap: zero recipient");

        if (token == address(0)) {
            uint256 bal = address(this).balance;
            if (bal > 0) {
                (bool ok,) = payable(to).call{value: bal}("");
                require(ok, "UniswapFuelSwap: ETH transfer failed");
            }
        } else {
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal > 0) IERC20(token).safeTransfer(to, bal);
        }
    }
}
