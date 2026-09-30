use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Somente o admin do registro")]
    NotAdmin,
    #[msg("Supply de fracoes tem que ser maior que zero")]
    ZeroFractions,
    #[msg("Peso fora do intervalo valido")]
    BadWeight,
    #[msg("Card desabilitado para novos depositos")]
    CardDisabled,
    #[msg("Este card ja esta travado no cofre")]
    AlreadyLocked,
    #[msg("Nao existe NFT travado para resgatar")]
    NotLocked,
    #[msg("Fracoes insuficientes: o resgate exige o supply inteiro")]
    InsufficientFractions,
    #[msg("Mint de NFT diferente do registrado")]
    WrongCard,
    #[msg("Mint de fracao diferente do registrado")]
    WrongFractionMint,
    #[msg("A conta de token nao pertence ao signatario")]
    NotOwner,
    #[msg("A conta nao contem exatamente 1 unidade: nao e um NFT")]
    NotAnNft,
}
