mod config;

// Minimal implementation of the token bridge that can move funds between L1 <> L2.
// The bridge has a corresponding Portal contract on L1 that it is attached to
// And corresponds to a Token on L2 that uses the `AuthWit` accounts pattern.
// Bridge has to be set as a minter on the token before it can be used

use aztec::macros::aztec;

#[aztec]
pub contract TokenBridge {
    use crate::config::Config;

    use dep::aztec::{
        macros::{functions::{external, initializer, internal, only_self, view}, storage::storage},
        protocol_types::{
            address::{AztecAddress, EthAddress},
            traits::{Deserialize, Packable, Serialize, ToField},
        },
        state_vars::{
            delayed_public_mutable::DelayedPublicMutable, map::Map, public_mutable::PublicMutable,
            PublicImmutable,
        },
    };

    use dep::token_portal_content_hash_lib::{
        get_mint_to_private_content_hash, get_mint_to_public_content_hash,
        get_withdraw_content_hash,
    };

    use keccak256::keccak256;
    use std::ecdsa_secp256k1::verify_signature;
    use token_minter_proxy::TokenMinterProxy;

    #[derive(Deserialize, Serialize)]
    pub struct CleanHandsData {
        pub action_id: Field,
        pub signature: [u8; 64],
    }

    #[derive(Deserialize, Serialize)]
    pub struct PassportData {
        pub max_amount: u128,
        pub nonce: Field,
        pub deadline: Field,
        pub signature: [u8; 64],
    }

    #[derive(Deserialize, Eq, Packable, Serialize)]
    struct PubKey {
        x: [u8; 32],
        y: [u8; 32],
    }

    // Storage structure, containing all storage, and specifying what slots they use.
    #[storage]
    struct Storage<Context> {
        owner: PublicMutable<AztecAddress, Context>,
        pending_owner: PublicMutable<AztecAddress, Context>,
        config: PublicImmutable<Config, Context>,
        // clean hands and passport verification vars
        human_id_attester_pubkey: PublicImmutable<PubKey, Context>,
        clean_hands_circuit_id: PublicImmutable<Field, Context>,
        passport_signer_pubkey: PublicImmutable<PubKey, Context>,
        // Mapping: user address => nonce => consumed status
        passport_nonces: Map<AztecAddress, Map<Field, DelayedPublicMutable<bool, 2, Context>, Context>, Context>,
        is_paused: DelayedPublicMutable<bool, 2, Context>,
    }

    // Constructs the contract.
    #[external("public")]
    #[initializer]
    fn constructor(token_minter_proxy: AztecAddress, portal: EthAddress) {
        let sender = self.context.msg_sender().unwrap();
        self.storage.owner.write(sender);
        self.storage.config.initialize(Config { token_minter_proxy, portal });
        self.storage.human_id_attester_pubkey.initialize(
            PubKey {
                x: [
                    0xf5, 0x28, 0x5c, 0x98, 0xd2, 0x41, 0xf5, 0x97, 0x0a, 0xb6, 0x0f, 0x33, 0xe1,
                    0x69, 0xff, 0x07, 0x8a, 0x37, 0x77, 0x62, 0x82, 0x51, 0x3f, 0x9c, 0x3c, 0x0c,
                    0x07, 0xd1, 0x29, 0x32, 0x10, 0x4a,
                ],
                y: [
                    0x4f, 0x14, 0xb8, 0x29, 0x78, 0x32, 0x38, 0x55, 0x84, 0xe8, 0xb3, 0xbb, 0xca,
                    0x67, 0x55, 0xc3, 0xcb, 0x49, 0xf7, 0x97, 0xaa, 0x07, 0x7e, 0x76, 0x74, 0x83,
                    0xdc, 0x79, 0xac, 0xf7, 0xbd, 0x1d,
                ],
            },
        );
        self.storage.clean_hands_circuit_id.initialize(
            0x1c98fc4f7f1ad3805aefa81ad25fa466f8342292accf69566b43691d12742a19,
        );
        // ADDRESS MUST BE SET PRIOR TO DEPLOYMENT
        self.storage.passport_signer_pubkey.initialize(
            PubKey {
                x: [
                    0xc5, 0x5a, 0x7d, 0x84, 0x6b, 0x74, 0x63, 0xf1, 0x22, 0x6c, 0x3b, 0x77, 0xe7,
                    0x44, 0x60, 0xbb, 0x05, 0x93, 0x79, 0xca, 0xf5, 0x1f, 0xa1, 0xa0, 0xe2, 0x75,
                    0x34, 0x3b, 0xd3, 0xa1, 0x25, 0x6e,
                ],
                y: [
                    0x01, 0x47, 0x2a, 0x2b, 0xa7, 0xc0, 0xad, 0x2a, 0x30, 0xfb, 0x84, 0x16, 0x92,
                    0x9a, 0xcc, 0xd4, 0xbe, 0x04, 0xf6, 0x07, 0x55, 0x3f, 0x26, 0xfd, 0x7c, 0x03,
                    0x67, 0x9a, 0x32, 0xc8, 0x1a, 0xa3,
                ],
            },
        );
        self.storage.is_paused.schedule_value_change(false);
    }

    #[external("public")]
    fn transfer_ownership(new_owner: AztecAddress) {
        assert(self.storage.owner.read() == self.context.msg_sender().unwrap(), "Only owner");
        assert(!new_owner.is_zero(), "New owner cannot be zero address");

        self.storage.pending_owner.write(new_owner);
    }

    #[external("public")]
    fn claim_ownership() {
        let sender = self.context.msg_sender().unwrap();
        assert(self.storage.pending_owner.read() == sender, "Only pending owner can claim");

        // Perform the transfer
        self.storage.owner.write(sender);

        // Clear the pending slot
        self.storage.pending_owner.write(AztecAddress::zero());
    }

    #[external("public")]
    fn set_paused(paused: bool) {
        assert(self.storage.owner.read() == self.context.msg_sender().unwrap(), "Only owner");
        self.storage.is_paused.schedule_value_change(paused);
    }

    #[external("private")]
    #[view]
    fn get_config() -> Config {
        self.storage.config.read()
    }

    #[external("public")]
    #[view]
    fn get_config_public() -> Config {
        self.storage.config.read()
    }

    // docs:start:claim_public
    // Consumes a L1->L2 message and calls the token contract to mint the appropriate amount publicly
    #[external("public")]
    fn claim_public(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: Field) {
        assert(self.storage.is_paused.get_current_value() == false, "Bridge is paused");
        let content_hash = get_mint_to_public_content_hash(to, amount);

        let config = self.storage.config.read();

        // Consume message and emit nullifier
        self.context.consume_l1_to_l2_message(
            content_hash,
            secret,
            config.portal,
            message_leaf_index,
        );

        // Mint tokens
        self.call(TokenMinterProxy::at(config.token_minter_proxy).mint_to_public(to, amount));
    }
    // docs:end:claim_public

    // docs:start:exit_to_l1_public
    // Burns the appropriate amount of tokens and creates a L2 to L1 withdraw message publicly
    // Requires `msg.sender` to give approval to the bridge to burn tokens on their behalf using witness signatures
    #[external("public")]
    fn exit_to_l1_public(
        recipient: EthAddress, // ethereum address to withdraw to
        amount: u128,
        caller_on_l1: EthAddress, // ethereum address that can call this function on the L1 portal (0x0 if anyone can call)
        authwit_nonce: Field, // nonce used in the approval message by `msg.sender` to let bridge burn their tokens on L2
    ) {
        assert(self.storage.is_paused.get_current_value() == false, "Bridge is paused");
        let config = self.storage.config.read();

        // Send an L2 to L1 message
        let content = get_withdraw_content_hash(recipient, amount, caller_on_l1);
        self.context.message_portal(config.portal, content);

        // Burn tokens
        self.call(TokenMinterProxy::at(config.token_minter_proxy).burn_public(
            self.context.msg_sender().unwrap(),
            amount,
            authwit_nonce,
        ));
    }
    // docs:end:exit_to_l1_public

    /// Claims the bridged tokens and makes them accessible in private. Note that recipient's address is not revealed
    /// but the amount is. Hence it's most likely possible to determine to which L1 deposit this claim corresponds to
    /// (unless there are multiple pending deposits of the same amount).
    #[external("private")]
    fn claim_private(
        recipient: AztecAddress, // recipient of the bridged tokens
        amount: u128,
        secret_for_L1_to_L2_message_consumption: Field, // secret used to consume the L1 to L2 message
        message_leaf_index: Field,
    ) {
        assert(self.storage.is_paused.get_current_value() == false, "Bridge is paused");
        let config = self.storage.config.read();

        // Consume L1 to L2 message and emit nullifier
        let content_hash = get_mint_to_private_content_hash(amount);
        self.context.consume_l1_to_l2_message(
            content_hash,
            secret_for_L1_to_L2_message_consumption,
            config.portal,
            message_leaf_index,
        );
        // At last we mint the tokens
        self.call(TokenMinterProxy::at(config.token_minter_proxy).mint_to_private(recipient, amount));
    }

    // Verify clean hands signature using ECDSA recovery
    #[internal("private")]
    fn verify_clean_hands_signature(
        action_id: Field,
        user_address: AztecAddress,
        signature: [u8; 64],
    ) -> bool {
        let mut message_bytes: [u8; 84] = [0; 84];

        // Add circuit_id (32 bytes)
        let circuit_id_bytes = self.storage.clean_hands_circuit_id.read().to_be_bytes::<32>();
        for i in 0..32 {
            message_bytes[i] = circuit_id_bytes[i];
        }

        // Add action_id (32 bytes)
        let action_id_bytes = action_id.to_be_bytes::<32>();
        for i in 0..32 {
            message_bytes[32 + i] = action_id_bytes[i];
        }

        // Add user_address (20 bytes from the 32-byte Field)
        let user_address_bytes = user_address.to_field().to_be_bytes::<32>();
        for i in 0..20 {
            message_bytes[64 + i] = user_address_bytes[12 + i];
        }

        let digest = keccak256(message_bytes, 84);

        // Create Ethereum signed message hash
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

        let personal_sign_hash = keccak256(eth_message, 60);

        let attestor_pubkey = self.storage.human_id_attester_pubkey.read();

        verify_signature(
            attestor_pubkey.x,
            attestor_pubkey.y,
            signature,
            personal_sign_hash,
        )
    }

    // Verify passport signature
    #[internal("private")]
    fn verify_passport_signature(
        user_address: AztecAddress,
        max_amount: u128,
        nonce: Field,
        deadline: Field,
        signature: [u8; 64],
    ) -> bool {
        // TODO: Check deadline (this would need block timestamp from context which is not possible in private fn)

        let mut message_bytes: [u8; 160] = [0; 160];

        // Convert user_address to bytes (32 bytes)
        let user_bytes = user_address.to_field().to_be_bytes::<32>();
        for i in 0..32 {
            message_bytes[i] = user_bytes[i];
        }

        // Convert max_amount to bytes (32 bytes)
        let amount_bytes = (max_amount as Field).to_be_bytes::<32>();
        for i in 0..32 {
            message_bytes[32 + i] = amount_bytes[i];
        }

        // Convert nonce to bytes (32 bytes)
        let nonce_bytes = nonce.to_be_bytes::<32>();
        for i in 0..32 {
            message_bytes[64 + i] = nonce_bytes[i];
        }

        // Convert deadline to bytes (32 bytes)
        let deadline_bytes = deadline.to_be_bytes::<32>();
        for i in 0..32 {
            message_bytes[96 + i] = deadline_bytes[i];
        }

        // Convert bridge_address to bytes (32 bytes)
        let contract_address = self.address;
        let contract_bytes = contract_address.to_field().to_be_bytes::<32>();
        for i in 0..32 {
            message_bytes[128 + i] = contract_bytes[i];
        }

        let digest = keccak256(message_bytes, 160);

        // Create Ethereum signed message hash
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

        let personal_sign_hash = keccak256(eth_message, 60);

        let signer_pubkey = self.storage.passport_signer_pubkey.read();

        verify_signature(
            signer_pubkey.x,
            signer_pubkey.y,
            signature,
            personal_sign_hash,
        )
    }

    // Public function to consume passport nonce (called from private context)
    #[external("public")]
    #[only_self]
    fn _consume_passport_nonce_public(user: AztecAddress, nonce: Field) {
        // This should ideally verify the caller, but for simplicity we'll just mark it used
        self.storage.passport_nonces.at(user).at(nonce).schedule_value_change(true);
    }

    // docs:start:exit_to_l1_private
    // Burns the appropriate amount of tokens and creates a L2 to L1 withdraw message privately
    // Requires `msg.sender` (caller of the method) to give approval to the bridge to burn tokens on their behalf using witness signatures
    #[external("private")]
    fn exit_to_l1_private(
        recipient: EthAddress, // ethereum address to withdraw to
        amount: u128,
        caller_on_l1: EthAddress, // ethereum address that can call this function on the L1 portal (0x0 if anyone can call)
        authwit_nonce: Field, // nonce used in the approval message by `msg.sender` to let bridge burn their tokens on L2
        clean_hands: CleanHandsData,
        passport: PassportData,
    ) {
        assert(self.storage.is_paused.get_current_value() == false, "Bridge is paused");
        let config = self.storage.config.read();
        let sender = self.context.msg_sender().unwrap();

        let mut is_clean_hands = false;

        // Check if clean hands signature is provided (non-zero signature)
        let has_clean_hands_sig =
            (clean_hands.signature[0] != 0u8) | (clean_hands.signature[1] != 0u8);

        if has_clean_hands_sig {
            is_clean_hands = self.internal.verify_clean_hands_signature(
                clean_hands.action_id,
                sender,
                clean_hands.signature,
            )
        }

        if !is_clean_hands {
            let has_passport_sig = (passport.signature[0] != 0u8) | (passport.signature[1] != 0u8);
            assert(has_passport_sig, "No Valid passport verification provided");

            let nonce_used =
                self.storage.passport_nonces.at(sender).at(passport.nonce).get_current_value();

            assert(!nonce_used, "Passport nonce used");

            let is_passport_valid = self.internal.verify_passport_signature(
                sender,
                passport.max_amount,
                passport.nonce,
                passport.deadline,
                passport.signature,
            );
            assert(is_passport_valid, "Passport signature invalid");
            assert(amount <= passport.max_amount, "Amount exceeds Passport limit");

            self.enqueue_self._consume_passport_nonce_public(sender, passport.nonce);
        }

        // Send an L2 to L1 message
        let content = get_withdraw_content_hash(recipient, amount, caller_on_l1);
        self.context.message_portal(config.portal, content);

        // Burn tokens
        self.call(TokenMinterProxy::at(config.token_minter_proxy).burn_private(
            self.context.msg_sender().unwrap(),
            amount,
            authwit_nonce,
        ));
    }
    // docs:end:exit_to_l1_private
}
