mod test;

use aztec::macros::aztec;

#[aztec]
pub contract TokenMinterProxy {
    use aztec::{
        macros::{functions::{external, initializer, only_self, view}, storage::storage},
        protocol::address::AztecAddress,
        state_vars::{
            Map,
            PublicImmutable,
            PublicMutable,
        },
    };
    use token::Token;

    #[storage]
    struct Storage<Context> {
        owner: PublicMutable<AztecAddress, Context>,
        pending_owner: PublicMutable<AztecAddress, Context>,
        token: PublicImmutable<AztecAddress, Context>,
        can_mint: Map<AztecAddress, PublicMutable<bool, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor() {
        self.storage.owner.write(self.msg_sender());
    }

    #[external("public")]
    fn set_token(token_address: AztecAddress) {
        let sender = self.msg_sender();
        assert(self.storage.owner.read().eq(sender), "not owner");
        self.storage.token.initialize(token_address);
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
        self.storage.owner.write(sender);
        self.storage.pending_owner.write(AztecAddress::zero());
    }

    #[external("public")]
    #[view]
    fn get_pending_owner() -> AztecAddress {
        self.storage.pending_owner.read()
    }

    #[external("public")]
    #[view]
    fn get_owner() -> AztecAddress {
        self.storage.owner.read()
    }

    #[external("public")]
    #[view]
    fn get_token() -> AztecAddress {
        self.storage.token.read()
    }

    #[external("public")]
    #[view]
    fn is_minter(minter: AztecAddress) -> bool {
        self.storage.can_mint.at(minter).read()
    }

    #[external("public")]
    fn set_minter(minter: AztecAddress, allowed: bool) {
        let sender = self.msg_sender();
        assert(self.storage.owner.read().eq(sender), "not owner");
        self.storage.can_mint.at(minter).write(allowed);
    }

    #[external("public")]
    #[only_self]
    fn assert_minter(minter: AztecAddress) {
        assert(self.storage.can_mint.at(minter).read(), "not authorized minter");
    }

    #[external("public")]
    fn mint_to_public(recipient: AztecAddress, amount: u128) {
        let sender = self.msg_sender();
        assert(self.storage.can_mint.at(sender).read(), "not authorized minter");
        let token = Token::at(self.storage.token.read());
        self.call(token.mint_to_public(recipient, amount));
    }

    #[external("public")]
    fn burn_public(user_address: AztecAddress, amount: u128, authwit_nonce: Field) {
        let sender = self.msg_sender();
        assert(self.storage.can_mint.at(sender).read(), "not authorized minter");
        let token = Token::at(self.storage.token.read());
        self.call(token.burn_public(user_address, amount, authwit_nonce));
    }

    #[external("private")]
    fn mint_to_private(recipient: AztecAddress, amount: u128) {
        let sender = self.msg_sender();
        self.enqueue_self.assert_minter(sender);
        let token = Token::at(self.storage.token.read());
        self.call(token.mint_to_private(recipient, amount));
    }

    #[external("private")]
    fn burn_private(user_address: AztecAddress, amount: u128, authwit_nonce: Field) {
        let sender = self.msg_sender();
        self.enqueue_self.assert_minter(sender);
        let token = Token::at(self.storage.token.read());
        self.call(token.burn_private(user_address, amount, authwit_nonce));
    }
}
