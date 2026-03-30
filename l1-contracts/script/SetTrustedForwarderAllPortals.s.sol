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
        0xEFd30BD613EFefd2Cea9D1A6D6Aa57D0d622E87A, // WBTC
        0x1fe1b5fD55689A656d4b16Ee8A4c6130D9f908ef  // WETH
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
