use crate::TokenMinterProxy;
use crate::test::utils;

use aztec::protocol::{address::AztecAddress, traits::FromField};

#[test]
unconstrained fn test_constructor_sets_owner() {
    let (env, proxy_address, owner, _) = utils::setup();
    let proxy = TokenMinterProxy::at(proxy_address);

    let stored = env.view_public(proxy.get_owner());
    assert(stored == owner, "owner not set by constructor");
}

#[test]
unconstrained fn test_transfer_ownership_sets_pending() {
    let (env, proxy_address, owner, other) = utils::setup();
    let proxy = TokenMinterProxy::at(proxy_address);

    env.call_public(owner, proxy.transfer_ownership(other));

    let pending = env.view_public(proxy.get_pending_owner());
    assert(pending == other, "pending_owner not set");

    let still_owner = env.view_public(proxy.get_owner());
    assert(still_owner == owner, "owner changed before claim");
}

#[test(should_fail_with = "Only owner")]
unconstrained fn test_transfer_ownership_rejects_non_owner() {
    let (env, proxy_address, _, other) = utils::setup();
    let proxy = TokenMinterProxy::at(proxy_address);

    env.call_public(other, proxy.transfer_ownership(other));
}

#[test(should_fail_with = "New owner cannot be zero address")]
unconstrained fn test_transfer_ownership_rejects_zero() {
    let (env, proxy_address, owner, _) = utils::setup();
    let proxy = TokenMinterProxy::at(proxy_address);

    env.call_public(owner, proxy.transfer_ownership(AztecAddress::zero()));
}

#[test]
unconstrained fn test_claim_ownership_succeeds() {
    let (env, proxy_address, owner, other) = utils::setup();
    let proxy = TokenMinterProxy::at(proxy_address);

    env.call_public(owner, proxy.transfer_ownership(other));
    env.call_public(other, proxy.claim_ownership());

    let new_owner = env.view_public(proxy.get_owner());
    assert(new_owner == other, "owner not rotated");

    let pending = env.view_public(proxy.get_pending_owner());
    assert(pending == AztecAddress::zero(), "pending not cleared");
}

#[test(should_fail_with = "Only pending owner can claim")]
unconstrained fn test_claim_ownership_rejects_non_pending() {
    let (env, proxy_address, owner, other) = utils::setup();
    let proxy = TokenMinterProxy::at(proxy_address);

    env.call_public(owner, proxy.transfer_ownership(other));
    env.call_public(owner, proxy.claim_ownership());
}

#[test]
unconstrained fn test_cancel_ownership_transfer() {
    let (env, proxy_address, owner, other) = utils::setup();
    let proxy = TokenMinterProxy::at(proxy_address);

    env.call_public(owner, proxy.transfer_ownership(other));
    env.call_public(owner, proxy.cancel_ownership_transfer());

    let pending = env.view_public(proxy.get_pending_owner());
    assert(pending == AztecAddress::zero(), "pending not cleared by cancel");

    let still_owner = env.view_public(proxy.get_owner());
    assert(still_owner == owner, "owner changed by cancel");
}

#[test(should_fail_with = "Only owner")]
unconstrained fn test_cancel_ownership_transfer_rejects_non_owner() {
    let (env, proxy_address, owner, other) = utils::setup();
    let proxy = TokenMinterProxy::at(proxy_address);

    env.call_public(owner, proxy.transfer_ownership(other));
    env.call_public(other, proxy.cancel_ownership_transfer());
}

#[test(should_fail_with = "No pending owner")]
unconstrained fn test_cancel_ownership_transfer_rejects_when_no_pending() {
    let (env, proxy_address, owner, _) = utils::setup();
    let proxy = TokenMinterProxy::at(proxy_address);

    env.call_public(owner, proxy.cancel_ownership_transfer());
}

#[test]
unconstrained fn test_new_owner_can_set_minter_after_claim() {
    let (env, proxy_address, owner, other) = utils::setup();
    let proxy = TokenMinterProxy::at(proxy_address);

    env.call_public(owner, proxy.transfer_ownership(other));
    env.call_public(other, proxy.claim_ownership());

    let new_minter = AztecAddress::from_field(0xabcd);
    env.call_public(other, proxy.set_minter(new_minter, true));

    let is_minter = env.view_public(proxy.is_minter(new_minter));
    assert(is_minter, "new owner could not set minter");
}

#[test(should_fail_with = "not owner")]
unconstrained fn test_old_owner_cannot_set_minter_after_transfer() {
    let (env, proxy_address, owner, other) = utils::setup();
    let proxy = TokenMinterProxy::at(proxy_address);

    env.call_public(owner, proxy.transfer_ownership(other));
    env.call_public(other, proxy.claim_ownership());

    let new_minter = AztecAddress::from_field(0xabcd);
    env.call_public(owner, proxy.set_minter(new_minter, true));
}
