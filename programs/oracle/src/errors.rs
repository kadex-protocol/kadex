use anchor_lang::prelude::*;

#[error_code]
pub enum OracleError {
    #[msg("Pool AMM vazio ou sem reserva de fracao")]
    EmptyPool,
    #[msg("Preco nao cabe em u64")]
    PriceOverflow,
    #[msg("Nenhuma observacao registrada")]
    NoObservations,
    #[msg("Conta de pool AMM diferente da registrada no oraculo")]
    WrongAmmPool,
    #[msg("Somente o admin do oraculo")]
    NotAdmin,
    #[msg("Parametro invalido")]
    BadParams,
    #[msg("Adaptador de AMM ainda nao implementado")]
    AdapterUnsupported,
    #[msg("Conta de pool AMM com layout inesperado")]
    AdapterBadAccount,
}
