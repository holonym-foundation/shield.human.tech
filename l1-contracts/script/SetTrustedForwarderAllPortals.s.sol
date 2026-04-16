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
        0xf962427701dc060b5998D92E381f7D96460DAA6c, // USDC
        0xdE49BDf98F4E14708b290CccCBCEeDBb78fb142d, // USDT
        0x495c925b4bD47A9443d2Faf03cf9FD7c2dB74A42, // DAI
        0xaF50C186E6FdE800C6Fb00adaD8D9926eBF77b78, // HUMN
        0x0f6E44De5Aa708A7D8BA324E8cfe1b46aDc0e4A1, // GOAT
        0x0c25a4412a657954155443588b851e98536978F1, // WBTC
        0x82a3A1966998550869a8A43A7a8107f59FE9c8E6  // WETH
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
