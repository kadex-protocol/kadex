use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Only the registry admin")]
    NotAdmin,
    #[msg("Fraction supply must be greater than zero")]
    ZeroFractions,
    #[msg("Weight outside the valid range")]
    BadWeight,
    #[msg("Card is disabled for new deposits")]
    CardDisabled,
    #[msg("This card is already locked in the vault")]
    AlreadyLocked,
    #[msg("There is no locked NFT to redeem")]
    NotLocked,
    #[msg("Insufficient fractions: redemption requires the entire supply")]
    InsufficientFractions,
    #[msg("NFT mint differs from the registered one")]
    WrongCard,
    #[msg("Fraction mint differs from the registered one")]
    WrongFractionMint,
    #[msg("The token account does not belong to the signer")]
    NotOwner,
    #[msg("The account does not hold exactly 1 unit: not an NFT")]
    NotAnNft,
}
