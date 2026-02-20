mod config;
mod test;

// Minimal implementation of the token bridge that can move funds between L1 <> L2.
// The bridge has a corresponding Portal contract on L1 that it is attached to
// And corresponds to a Token on L2 that uses the `AuthWit` accounts pattern.
// Bridge has to be set as a minter on the token before it can be used

use aztec::macros::aztec;

#[aztec]
pub contract TokenBridge {
    use crate::config::{Config, eth_personal_sign_hash};

    use aztec::{
        macros::{functions::{external, initializer, internal, only_self, view}, storage::storage},
        protocol::{
            address::{AztecAddress, EthAddress},
            traits::{Deserialize, Packable, Serialize, ToField},
        },
        state_vars::{
            DelayedPublicMutable, Map, PublicMutable,
            PublicImmutable,
        },
    };

    use token_portal_content_hash_lib::{
        get_mint_to_private_content_hash, get_mint_to_public_content_hash,
        get_withdraw_content_hash,
    };

    use keccak256::keccak256;
    use std::ecdsa_secp256k1::verify_signature;
    use token_minter_proxy::TokenMinterProxy;

    #[derive(Deserialize, Serialize)]
    pub struct CleanHandsData {
        pub nonce: Field,
        pub action_id: Field,
        pub signature: [u8; 64],
    }

    #[derive(Deserialize, Serialize)]
    pub struct PassportData {
        pub max_amount: u128,
        pub nonce: Field,
        pub deadline: u64,
        pub signature: [u8; 64],
    }

    #[derive(Deserialize, Eq, Serialize)]
    struct PubKey {
        x: [u8; 32],
        y: [u8; 32],
    }

    // We need to implement custom packing and unpacking since the pubkey doesn't fit into a single field.
    // We split it into 4 fields, where the first 3 fields contain 31 bytes of data and the last field contains the remaining byte.
    // as present here: https://github.com/AztecProtocol/aztec-packages/blob/24f9e0e85aa7574125ff009d075b71a2e28f9450/noir-projects/noir-contracts/contracts/libs/ecdsa_public_key_note/src/lib.nr#L25-L41
    impl Packable for PubKey {
        let N: u32 = 4;

        // Cannot use the automatic packing since x and y don't fit. Pack the note as 5 fields where:
        // [0] = x[0..31] (upper bound excluded)
        // [1] = x[31]
        // [2] = y[0..31]
        // [3] = y[31]
        fn pack(self) -> [Field; Self::N] {
            let mut x: Field = 0;
            let mut y: Field = 0;
            let mut mul: Field = 1;

            for i in 1..32 {
                let byte_x: Field = self.x[31 - i] as Field;
                x = x + (byte_x * mul);
                let byte_y: Field = self.y[31 - i] as Field;
                y = y + (byte_y * mul);
                mul *= 256;
            }

            let last_x = self.x[31] as Field;
            let last_y = self.y[31] as Field;

            [x, last_x, y, last_y]
        }

        // Cannot use the automatic unpacking for the aforementioned reasons
        fn unpack(packed_note: [Field; Self::N]) -> Self {
            let mut x: [u8; 32] = [0; 32];
            let mut y: [u8; 32] = [0; 32];

            let part_x: [u8; 32] = packed_note[0].to_be_bytes();
            for i in 0..31 {
                x[i] = part_x[i + 1];
            }
            x[31] = packed_note[1].to_be_bytes::<32>()[31];

            let part_y: [u8; 32] = packed_note[2].to_be_bytes();
            for i in 0..31 {
                y[i] = part_y[i + 1];
            }
            y[31] = packed_note[3].to_be_bytes::<32>()[31];

            PubKey { x, y }
        }
    }

    // Storage structure, containing all storage, and specifying what slots they use.
    #[storage]
    struct Storage<Context> {
        owner: PublicMutable<AztecAddress, Context>,
        pending_owner: PublicMutable<AztecAddress, Context>,
        config: PublicImmutable<Config, Context>,
        // clean hands and passport verification vars
        human_id_attester_pubkey: DelayedPublicMutable<PubKey, 1, Context>,
        clean_hands_circuit_id: DelayedPublicMutable<Field, 1, Context>,
        passport_signer_pubkey: DelayedPublicMutable<PubKey, 1, Context>,
        // Mapping: user address => nonce => consumed status
        clean_hands_nonces: Map<AztecAddress, Map<Field, PublicMutable<bool, Context>, Context>, Context>,
        passport_nonces: Map<AztecAddress, Map<Field, PublicMutable<bool, Context>, Context>, Context>,
        is_paused: DelayedPublicMutable<bool, 1, Context>,
    }

    // Constructs the contract.
    #[external("public")]
    #[initializer]
    fn constructor(
        token_minter_proxy: AztecAddress,
        portal: EthAddress,
        human_id_attester_x: [u8; 32],
        human_id_attester_y: [u8; 32],
        circuit_id: Field,
        passport_signer_x: [u8; 32],
        passport_signer_y: [u8; 32],
    ) {
        let sender = self.msg_sender();
        self.storage.owner.write(sender);
        self.storage.config.initialize(Config { token_minter_proxy, portal });
        self.storage.human_id_attester_pubkey.schedule_value_change(
            PubKey { x: human_id_attester_x, y: human_id_attester_y },
        );
        self.storage.clean_hands_circuit_id.schedule_value_change(circuit_id);
        // ADDRESS MUST BE SET PRIOR TO DEPLOYMENT
        self.storage.passport_signer_pubkey.schedule_value_change(
            PubKey { x: passport_signer_x, y: passport_signer_y },
        );
        self.storage.is_paused.schedule_value_change(false);
    }

    #[external("public")]
    fn update_attestation_config(
        attester_x: [u8; 32],
        attester_y: [u8; 32],
        circuit_id: Field,
        passport_x: [u8; 32],
        passport_y: [u8; 32],
    ) {
        assert(self.storage.owner.read() == self.msg_sender(), "Only owner");

        self.storage.human_id_attester_pubkey.schedule_value_change(
            PubKey { x: attester_x, y: attester_y },
        );
        self.storage.clean_hands_circuit_id.schedule_value_change(circuit_id);
        self.storage.passport_signer_pubkey.schedule_value_change(
            PubKey { x: passport_x, y: passport_y },
        );
    }
    #[external("public")]
    fn transfer_ownership(new_owner: AztecAddress) {
        assert(self.storage.owner.read() == self.msg_sender(), "Only owner");
        assert(!new_owner.is_zero(), "New owner cannot be zero address");

        self.storage.pending_owner.write(new_owner);
    }
    #[external("public")]
    fn cancel_ownership_transfer() {
        assert(self.storage.owner.read() == self.msg_sender(), "Only owner");
        assert(!self.storage.pending_owner.read().is_zero(), "No pending owner");
        self.storage.pending_owner.write(AztecAddress::zero());
    }
    #[external("public")]
    fn claim_ownership() {
        let sender = self.msg_sender();
        assert(self.storage.pending_owner.read() == sender, "Only pending owner can claim");

        // Perform the transfer
        self.storage.owner.write(sender);

        // Clear the pending slot
        self.storage.pending_owner.write(AztecAddress::zero());
    }

    #[external("public")]
    fn set_paused(paused: bool) {
        assert(self.storage.owner.read() == self.msg_sender(), "Only owner");
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

    // Consumes a L1->L2 message and calls the token contract to mint the appropriate amount publicly
    #[external("public")]
    fn claim_public(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: Field) {
        assert(self.storage.is_paused.get_current_value() == false, "Bridge is paused");
        assert(amount > 0, "Amount must be greater than zero");
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
        assert(amount > 0, "Amount must be greater than zero");
        let config = self.storage.config.read();

        // Send an L2 to L1 message
        let content = get_withdraw_content_hash(recipient, amount, caller_on_l1);
        self.context.message_portal(config.portal, content);

        // Burn tokens
        self.call(TokenMinterProxy::at(config.token_minter_proxy).burn_public(
            self.msg_sender(),
            amount,
            authwit_nonce,
        ));
    }

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
        assert(amount > 0, "Amount must be greater than zero");
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
        nonce: Field,
        user_address: AztecAddress,
        signature: [u8; 64],
    ) -> bool {
        let mut message_bytes: [u8; 116] = [0; 116];

        // Add circuit_id (32 bytes)
        let circuit_id_bytes =
            self.storage.clean_hands_circuit_id.get_current_value().to_be_bytes::<32>();
        for i in 0..32 {
            message_bytes[i] = circuit_id_bytes[i];
        }

        // Add action_id (32 bytes)
        let action_id_bytes = action_id.to_be_bytes::<32>();
        for i in 0..32 {
            message_bytes[32 + i] = action_id_bytes[i];
        }

        // Add nonce (32 bytes)
        let nonce_bytes = nonce.to_be_bytes::<32>();
        for i in 0..32 {
            message_bytes[64 + i] = nonce_bytes[i];
        }

        // Add user_address (20 bytes from the 32-byte Field)
        let user_address_bytes = user_address.to_field().to_be_bytes::<32>();
        for i in 0..20 {
            message_bytes[96 + i] = user_address_bytes[12 + i];
        }

        let digest = keccak256(message_bytes, 116);
        let personal_sign_hash = eth_personal_sign_hash(digest);

        let attestor_pubkey = self.storage.human_id_attester_pubkey.get_current_value();

        verify_signature(
            attestor_pubkey.x,
            attestor_pubkey.y,
            signature,
            personal_sign_hash,
        )
    }

    // Public function to verify the deadline
    #[external("public")]
    #[only_self]
    fn _verify_deadline(deadline: u64) {
        let current_timestamp = self.context.timestamp();
        assert(current_timestamp <= deadline, "Passport deadline passed");
    }

    // Verify passport signaturetoken
    #[internal("private")]
    fn verify_passport_signature(
        user_address: AztecAddress,
        max_amount: u128,
        nonce: Field,
        deadline: u64,
        signature: [u8; 64],
    ) -> bool {
        self.enqueue_self._verify_deadline(deadline);
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
        let deadline_bytes = (Field::from(deadline)).to_be_bytes::<32>();
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
        let personal_sign_hash = eth_personal_sign_hash(digest);

        let signer_pubkey = self.storage.passport_signer_pubkey.get_current_value();

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
        // nonce verification is done in the public function here, cause the public fn is executed after the private fn
        // so in case the nonce is used, the entire call is reverted
        assert(!self.storage.passport_nonces.at(user).at(nonce).read(), "Passport nonce used");
        self.storage.passport_nonces.at(user).at(nonce).write(true);
    }

    // Public function to consume clean hands nonce (called from private context)
    #[external("public")]
    #[only_self]
    fn _consume_clean_hands_nonce_public(user: AztecAddress, nonce: Field) {
        // nonce verification is done in the public function here, cause the public fn is executed after the private fn
        // so in case the nonce is used, the entire call is reverted
        assert(
            !self.storage.clean_hands_nonces.at(user).at(nonce).read(),
            "Clean hands nonce used",
        );
        self.storage.clean_hands_nonces.at(user).at(nonce).write(true);
    }

    #[external("public")]
    #[view]
    fn is_clean_hands_nonce_used(user: AztecAddress, nonce: Field) -> bool {
        self.storage.clean_hands_nonces.at(user).at(nonce).read()
    }

    #[external("public")]
    #[view]
    fn is_passport_nonce_used(user: AztecAddress, nonce: Field) -> bool {
        self.storage.passport_nonces.at(user).at(nonce).read()
    }

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
        assert(amount > 0, "Amount must be greater than zero");
        let config = self.storage.config.read();
        let sender = self.msg_sender();

        let mut is_clean_hands = false;

        // Check if clean hands signature is provided (non-zero signature)
        let has_clean_hands_sig =
            (clean_hands.signature[0] != 0u8) | (clean_hands.signature[1] != 0u8);

        if has_clean_hands_sig {
            is_clean_hands = self.internal.verify_clean_hands_signature(
                clean_hands.action_id,
                clean_hands.nonce,
                sender,
                clean_hands.signature,
            );

            self.enqueue_self._consume_clean_hands_nonce_public(sender, clean_hands.nonce);
        }

        if !is_clean_hands {
            let has_passport_sig = (passport.signature[0] != 0u8) | (passport.signature[1] != 0u8);
            assert(has_passport_sig, "No Valid passport verification provided");

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
            self.msg_sender(),
            amount,
            authwit_nonce,
        ));
    }
}
