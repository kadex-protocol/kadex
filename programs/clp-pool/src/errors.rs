use anchor_lang::prelude::*;

#[error_code]
pub enum PoolError {
    #[msg("Somente o admin do pool")]
    NotAdmin,
    #[msg("Parametro economico invalido")]
    BadParams,
    #[msg("Capacidade de OI excedida: o menor dos dois tetos foi estourado")]
    CapacityExceeded,
    #[msg("Este card passaria do peso maximo dentro da manga")]
    CardWeightExceeded,
    #[msg("Mercado ja encerrado")]
    AlreadySettled,
    #[msg("Operacao nao permitida no estado atual do mercado")]
    StateForbids,
    #[msg("Manga liquida insuficiente")]
    InsufficientLiquidity,
    #[msg("Somente o mercado de perp registrado")]
    NotPerpMarket,
}
