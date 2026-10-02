use anchor_lang::prelude::*;

#[error_code]
pub enum PoolError {
    #[msg("Only the pool admin")]
    NotAdmin,
    #[msg("Invalid economic parameter")]
    BadParams,
    #[msg("Open-interest capacity exceeded: the lower of the two ceilings was breached")]
    CapacityExceeded,
    #[msg("This card would exceed the maximum weight inside the sleeve")]
    CardWeightExceeded,
    #[msg("Market is already settled")]
    AlreadySettled,
    #[msg("Market state forbids this operation")]
    StateForbids,
    #[msg("Insufficient liquid sleeve")]
    InsufficientLiquidity,
    #[msg("Only the registered perp market")]
    NotPerpMarket,
    #[msg("Amount is zero")]
    ZeroAmount,
    #[msg("Deposit too small to mint any CLP")]
    DustDeposit,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Oracle account differs from the one registered on the pool")]
    WrongOracle,
    #[msg("Token account uses the wrong mint")]
    WrongMint,
    #[msg("Not one of the pool's registered vaults")]
    WrongVault,
    #[msg("The token account does not belong to the signer")]
    NotOwner,
    #[msg("Deposit would push the card sleeve past its target share")]
    SleeveTargetExceeded,
}
