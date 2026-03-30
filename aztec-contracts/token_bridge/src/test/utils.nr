use crate::TokenBridge;

use aztec::{
authwit::auth::compute_inner_authwit_hash,
protocol::{
address::{AztecAddress, EthAddress},
traits::{FromField, ToField},
},
test::helpers::test_environment::TestEnvironment,
};

use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, multi_scalar_mul};

pub global DUMMY_PORTAL: EthAddress = EthAddress::from_field(0xdead);
pub global DUMMY_CIRCUIT_ID: Field = 42;

// ========================================================================
// Schnorr Signing Primitives (adapted from FPC test pattern)
// ========================================================================

/// Grumpkin generator point.
global G1: EmbeddedCurvePoint = EmbeddedCurvePoint {
x: 1,
y: 17631683881184975370165255887551781615748388533673675138860,
is_infinite: false,
};

/// Fixed test private key. Using 1 so that e*sk = e, avoiding the need
/// for big-integer multiplication (only subtraction mod Fq is required).
global TEST_SIGNING_KEY: Field = 1;

// Grumpkin group order (= BN254 base field Fq), split into u128 halves.
// Fq = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47
global FQ_HI: u128 = 0x30644e72e131a029b85045b68181585d;
global FQ_LO: u128 = 0x97816a916871ca8d3c208c16d87cfd47;

/// Derive the test Schnorr public key from TEST_SIGNING_KEY.
pub unconstrained fn test_operator_pubkey() -> EmbeddedCurvePoint {
multi_scalar_mul([G1], [EmbeddedCurveScalar::new(TEST_SIGNING_KEY, 0)])
}

/// Compute a valid Schnorr signature over `message` using TEST_SIGNING_KEY.
pub unconstrained fn test_schnorr_sign(message: [u8; 32]) -> [u8; 64] {
let pk = test_operator_pubkey();

let k: u128 = 0xdead_beef_1234;
let r = multi_scalar_mul([G1], [EmbeddedCurveScalar::new(k as Field, 0)]);

// e = blake2s(pedersen_hash(R.x, PK.x, PK.y) || message)
let ped = std::hash::pedersen_hash([r.x, pk.x, pk.y]);
let ped_bytes: [u8; 32] = ped.to_be_bytes();
let mut hash_input: [u8; 64] = [0; 64];
for i in 0..32 {
hash_input[i] = ped_bytes[i];
}
for i in 0..32 {
hash_input[32 + i] = message[i];
}
let e_bytes: [u8; 32] = std::hash::blake2s(hash_input);

// s = k - e (mod Fq), since sk = 1
let s_bytes = sub_mod_fq(k, e_bytes);

let mut sig: [u8; 64] = [0; 64];
for i in 0..32 {
sig[i] = s_bytes[i];
}
for i in 0..32 {
sig[32 + i] = e_bytes[i];
}
sig
}

// ========================================================================
// Contract-specific signing helpers
// ========================================================================

/// Sign a clean hands attestation message (same preimage as the contract).
pub unconstrained fn sign_clean_hands(
circuit_id: Field,
action_id: Field,
nonce: Field,
user_address: AztecAddress,
) -> [u8; 64] {
let hash = compute_inner_authwit_hash([circuit_id, action_id, nonce, user_address.to_field()]);
let message: [u8; 32] = hash.to_be_bytes();
test_schnorr_sign(message)
}

/// Sign a passport attestation message (same preimage as the contract).
pub unconstrained fn sign_passport(
bridge_address: AztecAddress,
user_address: AztecAddress,
max_amount: u128,
nonce: Field,
deadline: u64,
) -> [u8; 64] {
let hash = compute_inner_authwit_hash([
user_address.to_field(),
max_amount as Field,
nonce,
deadline as Field,
bridge_address.to_field(),
]);
let message: [u8; 32] = hash.to_be_bytes();
test_schnorr_sign(message)
}

// ========================================================================
// u128-pair arithmetic helpers for modular subtraction over Fq
// ========================================================================

/// Compute (k - e) mod Fq using u128-pair 256-bit arithmetic.
unconstrained fn sub_mod_fq(k: u128, e_bytes: [u8; 32]) -> [u8; 32] {
let (mut e_hi, mut e_lo) = be_bytes_to_u128_pair(e_bytes);

// Reduce e mod Fq.
for _ in 0..6 {
if gte_u256(e_hi, e_lo, FQ_HI, FQ_LO) {
let (h, l) = sub_u256(e_hi, e_lo, FQ_HI, FQ_LO);
e_hi = h;
e_lo = l;
}
}

// s = Fq + k - e_rem (since k << e_rem, we add Fq first to avoid underflow)
let (sum_hi, sum_lo) = add_u256(FQ_HI, FQ_LO, 0, k);
let (mut s_hi, mut s_lo) = sub_u256(sum_hi, sum_lo, e_hi, e_lo);

// Final reduction if s >= Fq
if gte_u256(s_hi, s_lo, FQ_HI, FQ_LO) {
let (h, l) = sub_u256(s_hi, s_lo, FQ_HI, FQ_LO);
s_hi = h;
s_lo = l;
}

u128_pair_to_be_bytes(s_hi, s_lo)
}

unconstrained fn be_bytes_to_u128_pair(bytes: [u8; 32]) -> (u128, u128) {
let mut hi: u128 = 0;
let mut lo: u128 = 0;
for i in 0..16 {
hi = hi * 256 + bytes[i] as u128;
}
for i in 16..32 {
lo = lo * 256 + bytes[i] as u128;
}
(hi, lo)
}

unconstrained fn u128_pair_to_be_bytes(hi: u128, lo: u128) -> [u8; 32] {
let mut bytes: [u8; 32] = [0; 32];
let mut h = hi;
let mut l = lo;
for i in 0..16 {
bytes[31 - i] = (l % 256) as u8;
l = l / 256;
}
for i in 0..16 {
bytes[15 - i] = (h % 256) as u8;
h = h / 256;
}
bytes
}

unconstrained fn gte_u256(a_hi: u128, a_lo: u128, b_hi: u128, b_lo: u128) -> bool {
if a_hi != b_hi {
a_hi > b_hi
} else {
a_lo >= b_lo
}
}

unconstrained fn sub_u256(a_hi: u128, a_lo: u128, b_hi: u128, b_lo: u128) -> (u128, u128) {
if a_lo >= b_lo {
(a_hi - b_hi, a_lo - b_lo)
} else {
let result_lo = 0xffffffffffffffffffffffffffffffff - (b_lo - a_lo - 1);
(a_hi - b_hi - 1, result_lo)
}
}

unconstrained fn add_u256(a_hi: u128, a_lo: u128, b_hi: u128, b_lo: u128) -> (u128, u128) {
if a_lo > 0xffffffffffffffffffffffffffffffff - b_lo {
let complement = 0xffffffffffffffffffffffffffffffff - (b_lo - 1);
(a_hi + b_hi + 1, a_lo - complement)
} else {
(a_hi + b_hi, a_lo + b_lo)
}
}

// ========================================================================
// Test setup
// ========================================================================

pub unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress) {
let mut env = TestEnvironment::new();

let owner = env.create_light_account();
let other = env.create_light_account();

// Use a dummy address for the token minter proxy
let dummy_proxy = AztecAddress::from_field(0xbeef);

// Derive pubkey from TEST_SIGNING_KEY (= G1 since key=1)
let pk = test_operator_pubkey();

let initializer = TokenBridge::interface().constructor(
dummy_proxy,
DUMMY_PORTAL,
pk.x,
pk.y,
DUMMY_CIRCUIT_ID,
pk.x,
pk.y,
);

let bridge_address =
env.deploy("TokenBridge").with_public_initializer(owner, initializer);

// Advance time past the DelayedPublicMutable delay (delay=600 seconds) so initial values become active.
let advance_timestamp = env.last_block_timestamp() + 601;
env.mine_block_at(advance_timestamp);

(env, bridge_address, owner, other, dummy_proxy)
}
