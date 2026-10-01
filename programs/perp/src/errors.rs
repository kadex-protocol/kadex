use anchor_lang::prelude::*;

#[error_code]
pub enum PerpError {
    #[msg("Market state does not allow opening a position")]
    StateForbidsOpen,
    #[msg("Market state does not allow closing a position")]
    StateForbidsClose,
    #[msg("Notional is zero")]
    ZeroNotional,
    #[msg("Margin below the minimum required by maximum leverage")]
    InsufficientMargin,
    #[msg("Open-interest capacity exceeded: the lower of the two ceilings was breached")]
    CapacityExceeded,
    #[msg("Utilization too high to open new risk")]
    UtilizationTooHigh,
    #[msg("Position is not liquidatable yet")]
    NotLiquidatable,
    #[msg("Fixed-point arithmetic failed")]
    MathFailure,
    #[msg("Only the position owner")]
    NotOwner,
    #[msg("Oracle account differs from the one registered on the market")]
    WrongOracle,
    #[msg("Pool account differs from the one registered on the market")]
    WrongPool,
    #[msg("Token account uses the wrong mint")]
    WrongMint,
    #[msg("Not the pool's registered USDC vault")]
    WrongVault,
}
