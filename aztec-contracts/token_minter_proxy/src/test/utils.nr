use crate::TokenMinterProxy;

use aztec::{
    protocol::address::AztecAddress,
    test::helpers::test_environment::TestEnvironment,
};

pub unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();

    let owner = env.create_light_account();
    let other = env.create_light_account();

    let initializer = TokenMinterProxy::interface().constructor();

    let proxy_address = env.deploy("TokenMinterProxy").with_public_initializer(owner, initializer);

    (env, proxy_address, owner, other)
}
