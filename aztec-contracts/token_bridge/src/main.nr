mod config;
mod test;

// Minimal implementation of the token bridge that can move funds between L1 <> L2.
// The bridge has a corresponding Portal contract on L1 that it is attached to
// And corresponds to a Token on L2 that uses the `AuthWit` accounts pattern.
// Bridge has to be set as a minter on the token before it can be used

use aztec::macros::aztec;

#[aztec]
pub contract TokenBridge {
    use crate::config::Config;

    use aztec::{
        macros::{functions::{external, initializer, internal, only_self, view}, storage::storage},
        protocol::{
            abis::function_selector::FunctionSelector,
            address::{AztecAddress, EthAddress},
            traits::{Deserialize, Packable, Serialize, ToField},
        },
        state_vars::{
            DelayedPublicMutable, Map, PublicMutable,
            PublicImmutable,
        },
        authwit::auth::{
            assert_current_call_valid_authwit_public,
            compute_authwit_message_hash_from_call,
            compute_inner_authwit_hash,
            set_authorized,
        },
    };

    use token_portal_content_hash_lib::{
        get_mint_to_private_content_hash, get_mint_to_public_content_hash,
        get_withdraw_content_hash,
    };

    use std::embedded_curve_ops::EmbeddedCurvePoint;
    use schnorr::verify_signature;
    use token_minter_proxy::TokenMinterProxy;

    #[derive(Deserialize, Serialize)]
    pub struct CleanHandsData {
        pub nonce: Field,
        pub signature: [u8; 64],
    }

    #[derive(Deserialize, Serialize)]
    pub struct PassportData {
        pub max_amount: u128,
        pub nonce: Field,
        pub deadline: u64,
        pub signature: [u8; 64],
    }

    #[derive(Deserialize, Eq, Packable, Serialize)]
    struct GrumpkinPubKey {
        x: Field,
        y: Field,
    }

    // Storage structure, containing all storage, and specifying what slots they use.
    #[storage]
    struct Storage<Context> {
        owner: PublicMutable<AztecAddress, Context>,
        pending_owner: PublicMutable<AztecAddress, Context>,
        config: PublicImmutable<Config, Context>,
        // clean hands and passport verification vars
        human_id_attester_pubkey: DelayedPublicMutable<GrumpkinPubKey, 600, Context>,
        clean_hands_circuit_id: DelayedPublicMutable<Field, 600, Context>,
        clean_hands_action_id: DelayedPublicMutable<Field, 600, Context>,
        passport_signer_pubkey: DelayedPublicMutable<GrumpkinPubKey, 600, Context>,
        // Mapping: user address => nonce => consumed status
        clean_hands_nonces: Map<AztecAddress, Map<Field, PublicMutable<bool, Context>, Context>, Context>,
        passport_nonces: Map<AztecAddress, Map<Field, PublicMutable<bool, Context>, Context>, Context>,
        is_paused: PublicMutable<bool, Context>,
    }

    // Constructs the contract.
    #[external("public")]
    #[initializer]
    fn constructor(
        token_minter_proxy: AztecAddress,
        portal: EthAddress,
        human_id_attester_x: Field,
        human_id_attester_y: Field,
        circuit_id: Field,
        action_id: Field,
        passport_signer_x: Field,
        passport_signer_y: Field,
    ) {
        let sender = self.msg_sender();
        self.storage.owner.write(sender);
        self.storage.config.initialize(Config { token_minter_proxy, portal });
        // Basic on-curve check: y^2 = x^3 - 17 (Grumpkin)
        assert(human_id_attester_y * human_id_attester_y == human_id_attester_x * human_id_attester_x * human_id_attester_x - 17, "attester pubkey not on Grumpkin curve");
        self.storage.human_id_attester_pubkey.schedule_value_change(
            GrumpkinPubKey { x: human_id_attester_x, y: human_id_attester_y },
        );
        self.storage.clean_hands_circuit_id.schedule_value_change(circuit_id);
        self.storage.clean_hands_action_id.schedule_value_change(action_id);
        // Basic on-curve check: y^2 = x^3 - 17 (Grumpkin)
        assert(passport_signer_y * passport_signer_y == passport_signer_x * passport_signer_x * passport_signer_x - 17, "passport pubkey not on Grumpkin curve");
        self.storage.passport_signer_pubkey.schedule_value_change(
            GrumpkinPubKey { x: passport_signer_x, y: passport_signer_y },
        );
        self.storage.is_paused.write(false);
    }

    #[external("public")]
    fn update_attestation_config(
        attester_x: Field,
        attester_y: Field,
        circuit_id: Field,
        action_id: Field,
        passport_x: Field,
        passport_y: Field,
    ) {
        assert(self.storage.owner.read() == self.msg_sender(), "Only owner");
        // Basic on-curve check: y^2 = x^3 - 17 (Grumpkin)
        assert(attester_y * attester_y == attester_x * attester_x * attester_x - 17, "attester pubkey not on Grumpkin curve");
        self.storage.human_id_attester_pubkey.schedule_value_change(
            GrumpkinPubKey { x: attester_x, y: attester_y },
        );
        self.storage.clean_hands_circuit_id.schedule_value_change(circuit_id);
        self.storage.clean_hands_action_id.schedule_value_change(action_id);
        // Basic on-curve check: y^2 = x^3 - 17 (Grumpkin)
        assert(passport_y * passport_y == passport_x * passport_x * passport_x - 17, "passport pubkey not on Grumpkin curve");
        self.storage.passport_signer_pubkey.schedule_value_change(
            GrumpkinPubKey { x: passport_x, y: passport_y },
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
        self.storage.is_paused.write(paused);
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
        assert(self.storage.is_paused.read() == false, "Bridge is paused");
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

    // Verifies the compliance attestation in private (Schnorr uses Blake2s, unavailable in the
    // AVM), writes a one-shot approval into the canonical AuthRegistry, and enqueues the public
    // `exit_to_l1_public` which consumes that approval atomically. The Schnorr preimage is the
    // same as the private-exit path: cross-mode replay is not a concern because the
    // clean_hands/passport nonce map is shared, so any sig can only be consumed once across
    // both modes, and the public-exit params (recipient/amount/...) are bound through the
    // AuthRegistry inner_hash, not the Schnorr preimage.
    //
    // Requires `msg.sender` to give approval to the proxy to burn public tokens on their behalf
    // via an authwit signature (same as the current public-burn flow).
    #[external("private")]
    fn authorize_exit_to_l1_public(
        recipient: EthAddress, // ethereum address to withdraw to
        amount: u128,
        caller_on_l1: EthAddress, // ethereum address that can call this function on the L1 portal (0x0 if anyone can call)
        authwit_nonce: Field, // nonce used in the approval message by `msg.sender` to let bridge burn their tokens on L2
        clean_hands: CleanHandsData,
        passport: PassportData,
    ) {
        assert(amount > 0, "Amount must be greater than zero");
        let sender = self.msg_sender();

        let mut is_clean_hands = false;

        let has_clean_hands_sig =
            (clean_hands.signature[0] != 0u8) | (clean_hands.signature[1] != 0u8);

        if has_clean_hands_sig {
            let attester_pubkey = self.storage.human_id_attester_pubkey.get_current_value();
            let circuit_id = self.storage.clean_hands_circuit_id.get_current_value();
            let action_id = self.storage.clean_hands_action_id.get_current_value();

            is_clean_hands = verify_clean_hands_signature(
                attester_pubkey,
                circuit_id,
                action_id,
                clean_hands.nonce,
                sender,
                clean_hands.signature,
            );

            self.enqueue_self._consume_clean_hands_nonce_public(sender, clean_hands.nonce);
        }

        if !is_clean_hands {
            let has_passport_sig = (passport.signature[0] != 0u8) | (passport.signature[1] != 0u8);
            assert(has_passport_sig, "No Valid passport verification provided");

            let passport_pubkey = self.storage.passport_signer_pubkey.get_current_value();

            // Deadline is enforced in public (msg.sender-independent, cheap, avoids trusting the
            // private timestamp).
            self.enqueue_self._verify_deadline(passport.deadline);

            let is_passport_valid = verify_passport_signature(
                self.address,
                passport_pubkey,
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

        // Bind the approval to the upcoming public `exit_to_l1_public(user, recipient, amount,
        // caller_on_l1, authwit_nonce)` call. caller==consumer==self.address because the public
        // fn is called via enqueue_self (msg.sender at both set_authorized and consume is the
        // bridge) and is defined on this contract.
        let message_hash = compute_authwit_message_hash_from_call(
            self.address,
            self.address,
            self.context.chain_id(),
            self.context.version(),
            comptime {
                FunctionSelector::from_signature(
                    "exit_to_l1_public((Field),(Field),u128,(Field),Field)",
                )
            },
            [
                sender.to_field(),
                recipient.to_field(),
                amount as Field,
                caller_on_l1.to_field(),
                authwit_nonce,
            ],
        );

        // Register the approval from a public self-call (so msg.sender at the registry is the
        // bridge; `assert_current_call_valid_authwit_public` below re-derives the same inner
        // hash from the public-phase call and consumes the approval).
        self.enqueue_self._register_public_exit_approval(message_hash);

        // Hand off to the public exit path, which atomically consumes the approval above,
        // sends the L2->L1 message, and burns the user's public balance via the proxy.
        self.enqueue_self.exit_to_l1_public(sender, recipient, amount, caller_on_l1, authwit_nonce);
    }

    // Public execution of the L1 withdraw + burn. Gated by an approval in the canonical
    // AuthRegistry written by `authorize_exit_to_l1_public` in the same transaction.
    // `#[only_self]` means the only reachable caller is the bridge itself, enforced at the AVM
    // msg.sender level.
    #[external("public")]
    #[only_self]
    fn exit_to_l1_public(
        user: AztecAddress,
        recipient: EthAddress,
        amount: u128,
        caller_on_l1: EthAddress,
        authwit_nonce: Field,
    ) {
        assert(self.storage.is_paused.read() == false, "Bridge is paused");
        assert(amount > 0, "Amount must be greater than zero");
        let config = self.storage.config.read();

        // Atomically verifies approved_actions[self.address][message_hash]==true and clears it.
        // The registry derives inner_hash from [msg.sender, selector, args_hash] of this call,
        // matching what `compute_authwit_message_hash_from_call` produced on the private side.
        // Reverts if missing, so a second call with the same params cannot re-exit.
        assert_current_call_valid_authwit_public(self.context, self.address);

        let content = get_withdraw_content_hash(recipient, amount, caller_on_l1);
        self.context.message_portal(config.portal, content);

        self.call(
            TokenMinterProxy::at(config.token_minter_proxy).burn_public(user, amount, authwit_nonce),
        );
    }

    // Public wrapper around the canonical AuthRegistry `set_authorized(message_hash, true)` call.
    // Needed because the registry key is keyed by `msg.sender` at the registry call: we want the
    // bridge itself as the approver, so we enqueue this #[only_self] wrapper from the private
    // authorize path rather than calling the registry directly from the user's context.
    #[external("public")]
    #[only_self]
    fn _register_public_exit_approval(message_hash: Field) {
        set_authorized(self.context, message_hash, true);
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
        self.enqueue_self._assert_not_paused();
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

    // Verify clean hands signature using Schnorr over Grumpkin
    #[contract_library_method]
    fn verify_clean_hands_signature(
        attester_pubkey: GrumpkinPubKey,
        circuit_id: Field,
        action_id: Field,
        nonce: Field,
        user_address: AztecAddress,
        signature: [u8; 64],
    ) -> bool {
        let hash = compute_inner_authwit_hash([circuit_id, action_id, nonce, user_address.to_field()]);
        let pubkey = EmbeddedCurvePoint { x: attester_pubkey.x, y: attester_pubkey.y, is_infinite: false };
        verify_signature(pubkey, signature, hash.to_be_bytes::<32>())
    }

    #[external("public")]
    #[only_self]
    fn _assert_not_paused() {
        assert(self.storage.is_paused.read() == false, "Bridge is paused");
    }

    // Public function to verify the deadline
    #[external("public")]
    #[only_self]
    fn _verify_deadline(deadline: u64) {
        let current_timestamp = self.context.timestamp();
        assert(current_timestamp <= deadline, "Passport deadline passed");
    }

    // Verify passport signature using Schnorr over Grumpkin
    // Note: caller must enqueue _verify_deadline separately
    #[contract_library_method]
    fn verify_passport_signature(
        bridge_address: AztecAddress,
        passport_pubkey: GrumpkinPubKey,
        user_address: AztecAddress,
        max_amount: u128,
        nonce: Field,
        deadline: u64,
        signature: [u8; 64],
    ) -> bool {
        let hash = compute_inner_authwit_hash([
            user_address.to_field(),
            max_amount as Field,
            nonce,
            deadline as Field,
            bridge_address.to_field(),
        ]);
        let pubkey = EmbeddedCurvePoint { x: passport_pubkey.x, y: passport_pubkey.y, is_infinite: false };
        verify_signature(pubkey, signature, hash.to_be_bytes::<32>())
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
        self.enqueue_self._assert_not_paused();
        assert(amount > 0, "Amount must be greater than zero");
        let config = self.storage.config.read();
        let sender = self.msg_sender();

        let mut is_clean_hands = false;

        // Check if clean hands signature is provided (non-zero signature)
        let has_clean_hands_sig =
            (clean_hands.signature[0] != 0u8) | (clean_hands.signature[1] != 0u8);

        if has_clean_hands_sig {
            let attester_pubkey = self.storage.human_id_attester_pubkey.get_current_value();
            let circuit_id = self.storage.clean_hands_circuit_id.get_current_value();
            let action_id = self.storage.clean_hands_action_id.get_current_value();

            is_clean_hands = verify_clean_hands_signature(
                attester_pubkey,
                circuit_id,
                action_id,
                clean_hands.nonce,
                sender,
                clean_hands.signature,
            );

            self.enqueue_self._consume_clean_hands_nonce_public(sender, clean_hands.nonce);
        }

        if !is_clean_hands {
            let has_passport_sig = (passport.signature[0] != 0u8) | (passport.signature[1] != 0u8);
            assert(has_passport_sig, "No Valid passport verification provided");

            let passport_pubkey = self.storage.passport_signer_pubkey.get_current_value();

            // Enqueue deadline check (must happen in public context)
            self.enqueue_self._verify_deadline(passport.deadline);

            let is_passport_valid = verify_passport_signature(
                self.address,
                passport_pubkey,
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
