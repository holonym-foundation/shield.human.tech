// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import "forge-std/Script.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

interface IFeeAssetHandler {
    function mint(address) external;
}

/**
 * @notice Helper to init + seed a native ETH/FEE pool at high price (10M FEE/ETH).
 */
contract HighPricePoolHelper is IUnlockCallback {
    using SafeERC20 for IERC20;

    IPoolManager public immutable pm;
    address public immutable feeAssetHandler;
    address public immutable feeJuice;
    address public immutable deployer;

    constructor(address _pm, address _feeAssetHandler, address _feeJuice) {
        pm = IPoolManager(_pm);
        feeAssetHandler = _feeAssetHandler;
        feeJuice = _feeJuice;
        deployer = msg.sender;
    }

    receive() external payable {}

    function setup(
        uint256 mintCount,
        PoolKey calldata key,
        uint160 sqrtPriceX96,
        int24 tickLower,
        int24 tickUpper,
        int256 liquidityDelta
    ) external payable {
        require(msg.sender == deployer, "not deployer");

        // Batch mint FEE
        for (uint256 i = 0; i < mintCount; i++) {
            IFeeAssetHandler(feeAssetHandler).mint(address(this));
        }

        // Initialize pool
        pm.initialize(key, sqrtPriceX96);

        // Seed liquidity
        pm.unlock(abi.encode(key, tickLower, tickUpper, liquidityDelta));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(pm), "only pm");

        (PoolKey memory key, int24 tickLower, int24 tickUpper, int256 liquidityDelta) =
            abi.decode(data, (PoolKey, int24, int24, int256));

        (BalanceDelta delta,) = pm.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: liquidityDelta,
                salt: bytes32(0)
            }),
            ""
        );

        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();

        if (d0 < 0) {
            uint256 owed = uint256(uint128(-d0));
            if (Currency.unwrap(key.currency0) == address(0)) {
                pm.settle{value: owed}();
            } else {
                pm.sync(key.currency0);
                IERC20(Currency.unwrap(key.currency0)).safeTransfer(address(pm), owed);
                pm.settle();
            }
        }
        if (d1 < 0) {
            uint256 owed = uint256(uint128(-d1));
            if (Currency.unwrap(key.currency1) == address(0)) {
                pm.settle{value: owed}();
            } else {
                pm.sync(key.currency1);
                IERC20(Currency.unwrap(key.currency1)).safeTransfer(address(pm), owed);
                pm.settle();
            }
        }

        if (d0 > 0) pm.take(key.currency0, address(this), uint256(uint128(d0)));
        if (d1 > 0) pm.take(key.currency1, address(this), uint256(uint128(d1)));

        return "";
    }

    function sweep(address token) external {
        require(msg.sender == deployer, "not deployer");
        if (token == address(0)) {
            uint256 bal = address(this).balance;
            if (bal > 0) payable(deployer).transfer(bal);
        } else {
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal > 0) IERC20(token).safeTransfer(deployer, bal);
        }
    }
}

contract DeployHighPricePool is Script {
    address constant POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address constant AZTEC = 0x35d0186d1FD53b72996475D965C5Ed171D52b986;
    address constant FEE_ASSET_HANDLER = 0xED9c5557d2E0abCc7c7FCA958eE4292199413494;

    // New pool parameters (different from the 3000/60 pool)
    uint24 constant POOL_FEE = 500;     // 0.05%
    int24 constant TICK_SPACING = 10;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);

        // Deploy helper
        HighPricePoolHelper helper = new HighPricePoolHelper(POOL_MANAGER, FEE_ASSET_HANDLER, AZTEC);
        console.log("Helper deployed at:", address(helper));

        // Pool key: ETH(address(0)) / AZTEC(0x35d...)
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(AZTEC),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });

        // Price: 1 ETH = 10,000,000 FEE
        // sqrtPriceX96 = sqrt(10_000_000) * 2^96
        // sqrt(10_000_000) = 3162.2776601683795
        // Computed: 31622776601683795 * 2^96 / 1e13
        uint256 Q96 = 79228162514264337593543950336; // 2^96
        uint160 sqrtPriceX96 = uint160(uint256(31622776601683795) * Q96 / 1e13);
        console.log("sqrtPriceX96:", uint256(sqrtPriceX96));

        // Tick at price 10M: ~161,197 → nearest 10 = 161,200
        // Range: ±23,000 ticks (~10x each direction)
        //   tickLower = 138,160 (price ~1M)
        //   tickUpper = 184,210 (price ~100M)
        // Mint 200 * 1000 = 200,000 FEE, send 1 ETH for pool
        helper.setup{value: 1 ether}(
            200,         // mintCount
            key,
            sqrtPriceX96,
            138160,      // tickLower
            184210,      // tickUpper
            1e18         // liquidityDelta
        );
        console.log("High-price pool initialized and seeded!");

        // Sweep leftovers
        helper.sweep(address(0));
        helper.sweep(AZTEC);
        console.log("Swept leftovers");

        vm.stopBroadcast();
    }
}
