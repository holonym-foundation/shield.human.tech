use aztec::macros::aztec;

#[aztec]
pub contract TokenMinterProxy {
    use dep::aztec::{
        macros::{functions::{external, initializer, view}, storage::storage},
        protocol_types::address::AztecAddress,
        state_vars::{
            delayed_public_mutable::DelayedPublicMutable, map::Map,
            public_immutable::PublicImmutable,
        },
    };
    use token::Token;

    #[storage]
    struct Storage<Context> {
        owner: PublicImmutable<AztecAddress, Context>,
        token: PublicImmutable<AztecAddress, Context>,
        can_mint: Map<AztecAddress, DelayedPublicMutable<bool, 1, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor() {
        let sender = self.context.msg_sender().unwrap();
        self.storage.owner.initialize(sender);
    }

    #[external("public")]
    fn set_token(token_address: AztecAddress) {
        let sender = self.context.msg_sender().unwrap();
        assert(self.storage.owner.read().eq(sender), "not owner");
        self.storage.token.initialize(token_address);
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
        self.storage.can_mint.at(minter).get_current_value()
    }

    #[external("public")]
    fn set_minter(minter: AztecAddress, allowed: bool) {
        let sender = self.context.msg_sender().unwrap();
        assert(self.storage.owner.read().eq(sender), "not owner");
        self.storage.can_mint.at(minter).schedule_value_change(allowed);
    }

    #[external("public")]
    fn mint_to_public(recipient: AztecAddress, amount: u128) {
        let sender = self.context.msg_sender().unwrap();
        assert(self.storage.can_mint.at(sender).get_current_value(), "not authorized minter");
        let token = Token::at(self.storage.token.read());
        self.call(token.mint_to_public(recipient, amount));
    }

    #[external("public")]
    fn burn_public(user_address: AztecAddress, amount: u128, authwit_nonce: Field) {
        let sender = self.context.msg_sender().unwrap();
        assert(self.storage.can_mint.at(sender).get_current_value(), "not authorized minter");
        let token = Token::at(self.storage.token.read());
        self.call(token.burn_public(user_address, amount, authwit_nonce));
    }

    #[external("private")]
    fn mint_to_private(recipient: AztecAddress, amount: u128) {
        let sender = self.context.msg_sender().unwrap();
        assert(self.storage.can_mint.at(sender).get_current_value(), "not authorized minter");
        let token = Token::at(self.storage.token.read());
        self.call(token.mint_to_private(recipient, amount));
    }

    #[external("private")]
    fn burn_private(user_address: AztecAddress, amount: u128, authwit_nonce: Field) {
        let sender = self.context.msg_sender().unwrap();
        assert(self.storage.can_mint.at(sender).get_current_value(), "not authorized minter");
        let token = Token::at(self.storage.token.read());
        self.call(token.burn_private(user_address, amount, authwit_nonce));
    }
}
