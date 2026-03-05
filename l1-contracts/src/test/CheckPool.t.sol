// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;
import "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

contract CheckPoolTest is Test {
    using StateLibrary for IPoolManager;
    function test_checkPool() public {
        vm.createSelectFork(vm.envString("SEPOLIA_RPC_URL"));
        IPoolManager pm = IPoolManager(0xE03A1074c86CFeDd5C142C4F04F1a1536e203543);
        
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(0x543A5F9ae03F0551EE236eDF51987133FB3Da3E2),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        
        PoolId id = PoolIdLibrary.toId(key);
        console.log("Pool ID:");
        console.logBytes32(PoolId.unwrap(id));
        
        (uint160 sqrtPriceX96, int24 tick,,) = pm.getSlot0(id);
        console.log("sqrtPriceX96:", uint(sqrtPriceX96));
        console.log("tick:", uint(int(tick)));
        
        if (sqrtPriceX96 > 0) {
            console.log("==> POOL EXISTS");
            uint128 liq = pm.getLiquidity(id);
            console.log("liquidity:", uint(liq));
        } else {
            console.log("==> POOL NOT INITIALIZED");
        }
    }
}
