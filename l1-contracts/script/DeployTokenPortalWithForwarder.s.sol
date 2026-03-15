// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import "forge-std/Script.sol";
import {TokenPortal} from "../src/TokenPortal.sol";
import {SwapBridgeRouter} from "../src/SwapBridgeRouter.sol";

/**
 * @notice Deploy TokenPortal + SwapBridgeRouter on Sepolia, then wire up the trusted forwarder.
 *
 *         Required env vars:
 *           PRIVATE_KEY          — deployer private key
 *           FEE_RECIPIENT        — address that collects portal fees
 *           FEE_BASIS_POINTS     — e.g. 100 (1%)
 *           HUMAN_ID_ATTESTER    — Holonym clean-hands attester address
 *           CLEAN_HANDS_CIRCUIT_ID — e.g. 1
 *           PASSPORT_SIGNER      — Holonym passport signer address
 *
 *         Usage:
 *           source .env
 *           forge script script/DeployTokenPortalWithForwarder.s.sol:DeployTokenPortalWithForwarder \
 *             --rpc-url $RPC_URL --broadcast --verify -vvv
 */
contract DeployTokenPortalWithForwarder is Script {
    // ── Sepolia addresses (hardcoded) ────────────────────────────────
    address constant PERMIT2           = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant FEE_JUICE_PORTAL  = 0x516E3f74FD1C19B24da0706d28B5a30578f054AB;
    address constant UNISWAP_FUEL_SWAP = 0x547BE2F85f371f85fFB7f5BA1a972EAd88D7dB42;

    // ── Initialize args (from deployments.json active deployment) ────
    address constant REGISTRY = 0x52945C29D2788cCb076E910509C0449BfCBe29e6;
    address constant USDC     = 0x47E16BD8702BCef388085c0371Ba0B87fA883f5e;
    bytes32 constant L2_BRIDGE = 0x2db8efe71b161f228b170346f0a6d6fbfb6810e62787950e522043e86a9279b3;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        uint256 feeBasisPoints = vm.envUint("FEE_BASIS_POINTS");
        address humanIdAttester = vm.envAddress("HUMAN_ID_ATTESTER");
        uint256 cleanHandsCircuitId = vm.envUint("CLEAN_HANDS_CIRCUIT_ID");
        address passportSigner = vm.envAddress("PASSPORT_SIGNER");

        vm.startBroadcast(pk);

        // 1. Deploy TokenPortal
        TokenPortal portal = new TokenPortal(
            deployer,
            feeRecipient,
            feeBasisPoints,
            humanIdAttester,
            cleanHandsCircuitId,
            passportSigner
        );
        console.log("TokenPortal deployed at:", address(portal));

        // 2. Initialize TokenPortal
        portal.initialize(REGISTRY, USDC, L2_BRIDGE);
        console.log("TokenPortal initialized");

        // 3. Deploy SwapBridgeRouter
        SwapBridgeRouter router = new SwapBridgeRouter(
            PERMIT2,
            FEE_JUICE_PORTAL,
            UNISWAP_FUEL_SWAP
        );
        console.log("SwapBridgeRouter deployed at:", address(router));

        // 4. Set router as trusted forwarder on portal
        portal.setTrustedForwarder(address(router), true);
        console.log("Router set as trusted forwarder on portal");

        vm.stopBroadcast();
    }
}
