use dep::aztec::protocol_types::{
    address::{AztecAddress, EthAddress},
    traits::{Deserialize, Packable, Serialize},
};
use keccak256::keccak256;
use std::meta::derive;

// PublicImmutable has constant read cost in private regardless of the size of what it stores, so we put all immutable
// values in a single struct
#[derive(Deserialize, Eq, Packable, Serialize)]
pub struct Config {
    pub token_minter_proxy: AztecAddress,
    pub portal: EthAddress,
}

pub fn eth_personal_sign_hash(digest: [u8; 32]) -> [u8; 32] {
    let mut eth_message: [u8; 60] = [0; 60];
    // prefix is \x19Ethereum Signed Message:\n32
    let prefix = [
        0x19, 0x45, 0x74, 0x68, 0x65, 0x72, 0x65, 0x75, 0x6d, 0x20, 0x53, 0x69, 0x67, 0x6e,
        0x65, 0x64, 0x20, 0x4d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x3a, 0x0a, 0x33, 0x32,
    ];
    for i in 0..28 {
        eth_message[i] = prefix[i];
    }
    for i in 0..32 {
        eth_message[28 + i] = digest[i];
    }
    keccak256(eth_message, 60)
}