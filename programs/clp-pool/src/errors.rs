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
}
