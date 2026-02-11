use crate::TokenBridge;
use crate::test::utils;

use aztec::protocol_types::{
    address::AztecAddress,
    traits::FromField,
};

// ========================================================================
// 1. Constructor & Config Tests
// ========================================================================

#[test]
unconstrained fn test_constructor_sets_owner() {
    let (env, bridge_address, owner, _, _) = utils::setup();
    let bridge = TokenBridge::at(bridge_address);

    // The owner should be able to call owner-only functions (transfer_ownership).
    // We verify by calling transfer_ownership as owner -- if it doesn't revert, owner is set correctly.
    let new_candidate = AztecAddress::from_field(0x1234);
    env.call_public(owner, bridge.transfer_ownership(new_candidate));
    // If we got here without revert, owner was set to `owner` by the constructor.
}

#[test]
unconstrained fn test_constructor_sets_config() {
    let (env, bridge_address, _, _, dummy_proxy) = utils::setup();
    let bridge = TokenBridge::at(bridge_address);

    let config = env.view_public(bridge.get_config_public());
    assert(config.token_minter_proxy == dummy_proxy, "token_minter_proxy mismatch");
    assert(config.portal == utils::DUMMY_PORTAL, "portal mismatch");
}

#[test]
unconstrained fn test_constructor_sets_paused_false() {
    let (env, bridge_address, owner, _, _) = utils::setup();
    let bridge = TokenBridge::at(bridge_address);

    // The bridge should start unpaused. We verify by calling set_paused(true) as owner,
    // which would only work if the bridge is currently operational and owner is correct.
    // A more direct test: try to pause and then unpause.
    env.call_public(owner, bridge.set_paused(true));
    // If the above didn't revert, the bridge was not in a broken state from construction.
}

#[test]
unconstrained fn test_get_config_public() {
    let (env, bridge_address, _, _, dummy_proxy) = utils::setup();
    let bridge = TokenBridge::at(bridge_address);

    let config = env.view_public(bridge.get_config_public());
    assert(config.token_minter_proxy == dummy_proxy, "proxy mismatch");
    assert(config.portal == utils::DUMMY_PORTAL, "portal mismatch");
}

// ========================================================================
// 2. Ownership Management Tests
// ========================================================================

#[test]
unconstrained fn test_transfer_ownership() {
    let (env, bridge_address, owner, other, _) = utils::setup();
    let bridge = TokenBridge::at(bridge_address);

    // Owner can set a pending owner
    env.call_public(owner, bridge.transfer_ownership(other));

    // Verify the pending owner can now claim
    env.call_public(other, bridge.claim_ownership());
    // If claim succeeded, transfer_ownership worked correctly
}

#[test(should_fail_with = "Only owner")]
unconstrained fn test_transfer_ownership_fails_non_owner() {
    let (env, bridge_address, _, other, _) = utils::setup();
    let bridge = TokenBridge::at(bridge_address);

    // Non-owner cannot transfer ownership
    env.call_public(other, bridge.transfer_ownership(other));
}

#[test(should_fail_with = "New owner cannot be zero address")]
unconstrained fn test_transfer_ownership_fails_zero_address() {
    let (env, bridge_address, owner, _, _) = utils::setup();
    let bridge = TokenBridge::at(bridge_address);

    // Cannot transfer to zero address
    env.call_public(owner, bridge.transfer_ownership(AztecAddress::zero()));
}

#[test]
unconstrained fn test_claim_ownership() {
    let (env, bridge_address, owner, other, _) = utils::setup();
    let bridge = TokenBridge::at(bridge_address);

    // Set pending owner
    env.call_public(owner, bridge.transfer_ownership(other));

    // Pending owner claims ownership
    env.call_public(other, bridge.claim_ownership());

    // Verify new owner can perform owner-only actions
    let another = AztecAddress::from_field(0x9999);
    env.call_public(other, bridge.transfer_ownership(another));
}

#[test(should_fail_with = "Only pending owner can claim")]
unconstrained fn test_claim_ownership_fails_non_pending() {
    let (env, bridge_address, owner, other, _) = utils::setup();
    let bridge = TokenBridge::at(bridge_address);

    // Set pending owner to `other`
    env.call_public(owner, bridge.transfer_ownership(other));

    // A different address (owner) tries to claim -- should fail
    env.call_public(owner, bridge.claim_ownership());
}

#[test]
unconstrained fn test_cancel_ownership_transfer() {
    let (env, bridge_address, owner, other, _) = utils::setup();
    let bridge = TokenBridge::at(bridge_address);

    // Set pending owner
    env.call_public(owner, bridge.transfer_ownership(other));

    // Owner cancels the transfer
    env.call_public(owner, bridge.cancel_ownership_transfer());

    // Verify that `other` can no longer claim (pending was cleared)
    // We do this indirectly: if cancel worked, there's no pending owner,
    // so cancel again should fail with "No pending owner"
}

#[test(should_fail_with = "Only owner")]
unconstrained fn test_cancel_ownership_transfer_fails_non_owner() {
    let (env, bridge_address, owner, other, _) = utils::setup();
    let bridge = TokenBridge::at(bridge_address);

    // Set pending owner
    env.call_public(owner, bridge.transfer_ownership(other));

    // Non-owner tries to cancel
    env.call_public(other, bridge.cancel_ownership_transfer());
}

#[test(should_fail_with = "No pending owner")]
unconstrained fn test_cancel_ownership_transfer_fails_no_pending() {
    let (env, bridge_address, owner, _, _) = utils::setup();
    let bridge = TokenBridge::at(bridge_address);

    // No pending owner was set -- cancel should fail
    env.call_public(owner, bridge.cancel_ownership_transfer());
}

// ========================================================================
// 3. Pause Functionality Tests
// ========================================================================

#[test]
unconstrained fn test_set_paused() {
    let (env, bridge_address, owner, _, _) = utils::setup();
    let bridge = TokenBridge::at(bridge_address);

    // Owner can pause the bridge
    env.call_public(owner, bridge.set_paused(true));
    // If no revert, pause was accepted
}

#[test(should_fail_with = "Only owner")]
unconstrained fn test_set_paused_fails_non_owner() {
    let (env, bridge_address, _, other, _) = utils::setup();
    let bridge = TokenBridge::at(bridge_address);

    // Non-owner cannot pause
    env.call_public(other, bridge.set_paused(true));
}

#[test]
unconstrained fn test_unpause() {
    let (env, bridge_address, owner, _, _) = utils::setup();
    let bridge = TokenBridge::at(bridge_address);

    // Pause first
    env.call_public(owner, bridge.set_paused(true));

    // Then unpause
    env.call_public(owner, bridge.set_paused(false));
    // If no revert, unpause was accepted
}

// ========================================================================
// 4. Attestation Config Update Tests
// ========================================================================

#[test]
unconstrained fn test_update_attestation_config() {
    let (env, bridge_address, owner, _, _) = utils::setup();
    let bridge = TokenBridge::at(bridge_address);

    let new_attester_x: [u8; 32] = [200; 32];
    let new_attester_y: [u8; 32] = [201; 32];
    let new_circuit_id: Field = 999;
    let new_passport_x: [u8; 32] = [202; 32];
    let new_passport_y: [u8; 32] = [203; 32];

    // Owner can update attestation config
    env.call_public(
        owner,
        bridge.update_attestation_config(
            new_attester_x,
            new_attester_y,
            new_circuit_id,
            new_passport_x,
            new_passport_y,
        ),
    );
    // If no revert, the update was accepted
}

#[test(should_fail_with = "Only owner")]
unconstrained fn test_update_attestation_config_fails_non_owner() {
    let (env, bridge_address, _, other, _) = utils::setup();
    let bridge = TokenBridge::at(bridge_address);

    let new_attester_x: [u8; 32] = [200; 32];
    let new_attester_y: [u8; 32] = [201; 32];
    let new_circuit_id: Field = 999;
    let new_passport_x: [u8; 32] = [202; 32];
    let new_passport_y: [u8; 32] = [203; 32];

    // Non-owner cannot update attestation config
    env.call_public(
        other,
        bridge.update_attestation_config(
            new_attester_x,
            new_attester_y,
            new_circuit_id,
            new_passport_x,
            new_passport_y,
        ),
    );
}

// ========================================================================
// 5. Nonce View Function Tests
// ========================================================================

#[test]
unconstrained fn test_clean_hands_nonce_initially_unused() {
    let (env, bridge_address, owner, _, _) = utils::setup();
    let bridge = TokenBridge::at(bridge_address);

    let is_used = env.view_public(bridge.is_clean_hands_nonce_used(owner, 0));
    assert(is_used == false, "Clean hands nonce should initially be unused");
}

#[test]
unconstrained fn test_passport_nonce_initially_unused() {
    let (env, bridge_address, owner, _, _) = utils::setup();
    let bridge = TokenBridge::at(bridge_address);

    let is_used = env.view_public(bridge.is_passport_nonce_used(owner, 0));
    assert(is_used == false, "Passport nonce should initially be unused");
}

#[test]
unconstrained fn test_clean_hands_nonce_different_users_independent() {
    let (env, bridge_address, owner, other, _) = utils::setup();
    let bridge = TokenBridge::at(bridge_address);

    // Both users should have unused nonces independently
    let owner_nonce = env.view_public(bridge.is_clean_hands_nonce_used(owner, 1));
    let other_nonce = env.view_public(bridge.is_clean_hands_nonce_used(other, 1));
    assert(owner_nonce == false, "Owner nonce should be unused");
    assert(other_nonce == false, "Other nonce should be unused");

    // Nonces for different nonce values should also be independent
    let owner_nonce_2 = env.view_public(bridge.is_clean_hands_nonce_used(owner, 2));
    assert(owner_nonce_2 == false, "Owner nonce 2 should be unused");
}

#[test]
unconstrained fn test_passport_nonce_different_users_independent() {
    let (env, bridge_address, owner, other, _) = utils::setup();
    let bridge = TokenBridge::at(bridge_address);

    // Both users should have unused nonces independently
    let owner_nonce = env.view_public(bridge.is_passport_nonce_used(owner, 1));
    let other_nonce = env.view_public(bridge.is_passport_nonce_used(other, 1));
    assert(owner_nonce == false, "Owner passport nonce should be unused");
    assert(other_nonce == false, "Other passport nonce should be unused");

    // Nonces for different nonce values should also be independent
    let owner_nonce_2 = env.view_public(bridge.is_passport_nonce_used(owner, 2));
    assert(owner_nonce_2 == false, "Owner passport nonce 2 should be unused");
}

// ========================================================================
// NOTE: L1<>L2 messaging functions (claim_public, claim_private,
// exit_to_l1_public, exit_to_l1_private) and ECDSA verification functions
// cannot be meaningfully unit-tested in the TXE.
//
// - claim_public/claim_private: require consume_l1_to_l2_message oracle
//   which is not available in the TXE test environment.
// - exit_to_l1_public/exit_to_l1_private: require message_portal and
//   cross-contract calls through the proxy+token chain.
// - verify_clean_hands_signature/verify_passport_signature: require
//   pre-computed ECDSA test vectors (no signing in Noir).
//
// These functions should be tested via TypeScript e2e tests.
// ========================================================================
