// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import "forge-std/Script.sol";
import {TokenPortal} from "../src/TokenPortal.sol";

/**
 * @notice Set the same trusted forwarder on all active Sepolia token portals.
 *
 * Required env vars:
 *   PRIVATE_KEY       - owner key for the portals
 *   TRUSTED_FORWARDER - deployed SwapBridgeRouter address
 *
 * Usage:
 *   source .env
 *   TRUSTED_FORWARDER=0x... forge script script/SetTrustedForwarderAllPortals.s.sol:SetTrustedForwarderAllPortals \
 *     --rpc-url $RPC_URL --broadcast -vvv
 */
contract SetTrustedForwarderAllPortals is Script {
    address[] internal portals = [
        0x3c7C041498582E0dfEc6F0Bc82bBf2978707250C, // USDC
        0x47EE3f0A93A2E05a4Be48aBe56A2dc87452E654a, // USDT
        0x85A7CD19918788fa943261282CE88C770e3Be4D4, // DAI
        0xC6130C77B8E78B13dac0D51d160de36D94Bc6bE6, // HUMN
        0x995D4BA9B1b91721aF409ee8109ED5770D181B47, // GOAT
        0x314D6ecC33b1519b1D24e70ffdc82e5fDf202796, // WBTC
        0xb2700bf867558D8c8d52BAd2616b952F0332682b  // WETH
    ];

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address trustedForwarder = vm.envAddress("TRUSTED_FORWARDER");

        vm.startBroadcast(pk);
        for (uint256 i = 0; i < portals.length; i++) {
            TokenPortal(portals[i]).setTrustedForwarder(trustedForwarder, true);
            console.log("Trusted forwarder set", trustedForwarder, "on portal", portals[i]);
        }
        vm.stopBroadcast();
    }
}
