//! Adaptadores de leitura de reservas de AMM.
//!
//! # Blocker #1 (ver docs/oracle.md)
//!
//! O formato on-chain do pool real de fracoes/USDC AINDA NAO FOI CONFIRMADO.
//! Em vez de fingir que foi, existe um adaptador `Mock` com layout proprio e
//! os adaptadores reais retornam `AdapterUnsupported`.
//!
//! Isso deixa Backend B e o frontend trabalharem desde o dia 1 contra a mesma
//! interface, sem ninguem escrever codigo que finge integracao pronta.
//!
//! Quando o formato real for confirmado, a UNICA coisa que muda e a funcao
//! correspondente aqui. Nada em `perp` nem em `clp-pool` e tocado.

use anchor_lang::prelude::*;
use slab_interface::AmmAdapter;

use crate::errors::OracleError;

/// Reservas de um pool fracao/USDC, em unidades nativas.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reserves {
    /// Reserva em USDC. E o `R` da invariante de profundidade.
    pub usdc: u64,
    /// Reserva em fracoes de card.
    pub fraction: u64,
}

/// Layout da conta do pool mock. Constant-product simples, so devnet e testes.
///
/// 8 bytes de discriminador + dois u64 little-endian.
pub const MOCK_POOL_LEN: usize = 8 + 8 + 8;

pub fn read_reserves(adapter: AmmAdapter, ai: &AccountInfo) -> Result<Reserves> {
    match adapter {
        AmmAdapter::Mock => read_mock(ai),
        // Nao implementado de proposito: ver Blocker #1 acima.
        AmmAdapter::Meteora | AmmAdapter::Orca | AmmAdapter::Raydium => {
            err!(OracleError::AdapterUnsupported)
        }
    }
}

fn read_mock(ai: &AccountInfo) -> Result<Reserves> {
    let data = ai.try_borrow_data()?;
    require!(data.len() >= MOCK_POOL_LEN, OracleError::AdapterBadAccount);
    let usdc = u64::from_le_bytes(
        data[8..16]
            .try_into()
            .map_err(|_| error!(OracleError::AdapterBadAccount))?,
    );
    let fraction = u64::from_le_bytes(
        data[16..24]
            .try_into()
            .map_err(|_| error!(OracleError::AdapterBadAccount))?,
    );
    Ok(Reserves { usdc, fraction })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_adapters_fail_loudly_instead_of_returning_fake_data() {
        // Um adaptador nao implementado tem que ERRAR. Retornar zero ou um
        // numero plausivel seria pior: o mercado abriria com preco inventado.
        for a in [AmmAdapter::Meteora, AmmAdapter::Orca, AmmAdapter::Raydium] {
            let lamports = &mut 0u64;
            let data = &mut [0u8; MOCK_POOL_LEN][..];
            let key = Pubkey::default();
            let owner = Pubkey::default();
            let ai = AccountInfo::new(
                &key, false, false, lamports, data, &owner, false,
            );
            assert!(read_reserves(a, &ai).is_err(), "{a:?} deveria falhar");
        }
    }
}
