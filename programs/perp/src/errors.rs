use anchor_lang::prelude::*;

#[error_code]
pub enum PerpError {
    #[msg("Estado do mercado nao permite abrir posicao")]
    StateForbidsOpen,
    #[msg("Estado do mercado nao permite fechar posicao")]
    StateForbidsClose,
    #[msg("Notional zero")]
    ZeroNotional,
    #[msg("Margem abaixo do minimo exigido pela alavancagem maxima")]
    InsufficientMargin,
    #[msg("Capacidade de OI excedida: o menor dos dois tetos foi estourado")]
    CapacityExceeded,
    #[msg("Utilizacao alta demais para abrir risco novo")]
    UtilizationTooHigh,
    #[msg("Posicao ainda nao esta liquidavel")]
    NotLiquidatable,
    #[msg("Falha de aritmetica de ponto fixo")]
    MathFailure,
    #[msg("Somente o dono da posicao")]
    NotOwner,
    #[msg("Oraculo diferente do registrado no mercado")]
    WrongOracle,
}
