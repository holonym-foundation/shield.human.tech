// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import "forge-std/Script.sol";
import {SwapBridgeRouter} from "../src/SwapBridgeRouter.sol";

/**
 * @notice Deploy SwapBridgeRouter on Sepolia.
 *
 *         Usage:
 *           source .env
 *           forge script script/DeploySwapBridgeRouter.s.sol:DeploySwapBridgeRouter \
 *             --rpc-url $RPC_URL --broadcast --verify -vvv
 */
contract DeploySwapBridgeRouter is Script {
    // ── Sepolia addresses ────────────────────────────────────────────
    address constant PERMIT2          = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant FEE_JUICE_PORTAL = 0x516E3f74FD1C19B24da0706d28B5a30578f054AB;
    address constant UNISWAP_FUEL_SWAP = 0x547BE2F85f371f85fFB7f5BA1a972EAd88D7dB42;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);

        SwapBridgeRouter router = new SwapBridgeRouter(
            PERMIT2,
            FEE_JUICE_PORTAL,
            UNISWAP_FUEL_SWAP
        );
        console.log("SwapBridgeRouter deployed at:", address(router));

        vm.stopBroadcast();
    }
}
