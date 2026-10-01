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
}
