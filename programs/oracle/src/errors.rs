use anchor_lang::prelude::*;

#[error_code]
pub enum OracleError {
    #[msg("AMM pool is empty or has no fraction reserve")]
    EmptyPool,
    #[msg("Price does not fit in u64")]
    PriceOverflow,
    #[msg("No observations recorded")]
    NoObservations,
    #[msg("AMM pool account differs from the one registered on the oracle")]
    WrongAmmPool,
    #[msg("Only the oracle admin")]
    NotAdmin,
    #[msg("Invalid parameter")]
    BadParams,
    #[msg("AMM adapter not implemented yet")]
    AdapterUnsupported,
    #[msg("AMM pool account has an unexpected layout")]
    AdapterBadAccount,
    #[msg("Pool vault is missing or is not the vault the pool records")]
    AdapterWrongVault,
    #[msg("Pool does not pair the oracle's basket mint, or a vault holds the wrong mint")]
    AdapterWrongMint,
    #[msg("Pool vault is not owned by the AMM's own authority")]
    AdapterWrongAuthority,
    #[msg("Pool token uses a token program or decimals the oracle does not price")]
    AdapterUnsupportedToken,
    #[msg("Pool has swaps disabled, so its reserves are not a market price")]
    AdapterPoolDisabled,
    #[msg("Pool vault holds less than the fees it owes")]
    AdapterInsufficientVault,
}
