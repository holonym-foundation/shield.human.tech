use aztec::protocol::{
    address::{AztecAddress, EthAddress},
    traits::{Deserialize, Packable, Serialize},
};
use std::meta::derive;

// PublicImmutable has constant read cost in private regardless of the size of what it stores, so we put all immutable
// values in a single struct
#[derive(Deserialize, Eq, Packable, Serialize)]
pub struct Config {
    pub token_minter_proxy: AztecAddress,
    pub portal: EthAddress,
}
