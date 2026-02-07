use crate::TokenBridge;

use aztec::{
    protocol_types::{
        address::{AztecAddress, EthAddress},
        traits::FromField,
    },
    test::helpers::test_environment::TestEnvironment,
};

pub global DUMMY_PORTAL: EthAddress = EthAddress::from_field(0xdead);

pub global DUMMY_ATTESTER_X: [u8; 32] = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
    26, 27, 28, 29, 30, 31, 32,
];
pub global DUMMY_ATTESTER_Y: [u8; 32] = [
    33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55,
    56, 57, 58, 59, 60, 61, 62, 63, 64,
];
pub global DUMMY_PASSPORT_X: [u8; 32] = [
    65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87,
    88, 89, 90, 91, 92, 93, 94, 95, 96,
];
pub global DUMMY_PASSPORT_Y: [u8; 32] = [
    97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115,
    116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128,
];
pub global DUMMY_CIRCUIT_ID: Field = 42;

pub unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();

    let owner = env.create_light_account();
    let other = env.create_light_account();

    // Use a dummy address for the token minter proxy
    let dummy_proxy = AztecAddress::from_field(0xbeef);

    let initializer = TokenBridge::interface().constructor(
        dummy_proxy,
        DUMMY_PORTAL,
        DUMMY_ATTESTER_X,
        DUMMY_ATTESTER_Y,
        DUMMY_CIRCUIT_ID,
        DUMMY_PASSPORT_X,
        DUMMY_PASSPORT_Y,
    );

    let bridge_address =
        env.deploy("TokenBridge").with_public_initializer(owner, initializer);

    // Advance time past the DelayedPublicMutable delay (delay=1 second) so initial values become active.
    // The constructor schedules values; we need to mine a block at a timestamp past the change point.
    let advance_timestamp = env.last_block_timestamp() + 2;
    env.mine_block_at(advance_timestamp);

    (env, bridge_address, owner, other, dummy_proxy)
}
