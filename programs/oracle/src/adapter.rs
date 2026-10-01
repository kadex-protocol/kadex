//! Adapters that read AMM reserves.
//!
//! # Blocker #1 (ver docs/oracle.md)
//!
//! The on-chain layout of the real fraction/USDC pool is NOT YET CONFIRMED.
//! Rather than pretend otherwise, there is a `Mock` adapter with its own
//! layout, and the real adapters return `AdapterUnsupported`.
//!
//! That lets Backend B and the frontend work from day 1 against the same
//! interface, with nobody writing code that fakes a finished integration.
//!
//! When the real layout is confirmed, the ONLY thing that changes is the
//! corresponding function here. Nothing in `perp` or `clp-pool` is touched.

use anchor_lang::prelude::*;
use slab_interface::AmmAdapter;

use crate::errors::OracleError;

/// Reserves of a fraction/USDC pool, in native units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reserves {
    /// USDC reserve. This is the `R` in the depth invariant.
    pub usdc: u64,
    /// Card-fraction reserve.
    pub fraction: u64,
}

/// Layout of the mock pool account. Plain constant-product, devnet and tests
/// only. 8 discriminator bytes + two little-endian u64.
pub const MOCK_POOL_LEN: usize = 8 + 8 + 8;

pub fn read_reserves(adapter: AmmAdapter, ai: &AccountInfo) -> Result<Reserves> {
    match adapter {
        AmmAdapter::Mock => read_mock(ai),
        // Deliberately unimplemented: see Blocker #1 above.
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
        // An unimplemented adapter must ERROR. Returning zero, or a plausible
        // number, would be worse: the market would open on an invented price.
        for a in [AmmAdapter::Meteora, AmmAdapter::Orca, AmmAdapter::Raydium] {
            let lamports = &mut 0u64;
            let data = &mut [0u8; MOCK_POOL_LEN][..];
            let key = Pubkey::default();
            let owner = Pubkey::default();
            let ai = AccountInfo::new(
                &key, false, false, lamports, data, &owner, false,
            );
            assert!(read_reserves(a, &ai).is_err(), "{a:?} should fail");
        }
    }
}
