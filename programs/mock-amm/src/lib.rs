//! Program `mock-amm` — OWNER: Backend A. DEVNET AND TESTS ONLY.
//!
//! A constant-product fraction/USDC pool, reduced to the one thing the oracle
//! needs: two reserves that move the way a real AMM's would.
//!
//! # Why this exists
//!
//! The on-chain layout of the real fraction pool is unconfirmed (Blocker #1).
//! Rather than stub the oracle with an invented price, this program gives the
//! team a pool whose price can genuinely be pushed — so the clamp, the depth
//! floor and the divergence bound can be exercised against something that
//! behaves like the thing they defend against.
//!
//! # What it deliberately is not
//!
//! It holds no tokens. Reserves are plain numbers, not vaults. Nobody can
//! deposit value here and nobody can lose any. That is the point: it is a
//! price surface for testing, not an exchange.
//!
//! The account layout matches `oracle::adapter::MOCK_POOL_LEN` exactly:
//! 8 discriminator bytes + two little-endian `u64`.

use anchor_lang::prelude::*;
use slab_math::{div_wad_floor, isqrt};

declare_id!("AUPEWRMXpNvN42nCA6ovZRt4eYcaySyRhewxnTa6ygJi");

#[program]
pub mod mock_amm {
    use super::*;

    /// Create the pool with its first liquidity.
    ///
    /// This is Blocker #2 in miniature: until someone funds a pool there is no
    /// reserve, no price, and nothing downstream works.
    pub fn create_pool(ctx: Context<CreatePool>, usdc: u64, fraction: u64) -> Result<()> {
        require!(usdc > 0 && fraction > 0, AmmError::EmptyLiquidity);
        let p = &mut ctx.accounts.pool;
        p.usdc = usdc;
        p.fraction = fraction;
        emit!(ReservesChanged {
            pool: p.key(),
            usdc,
            fraction,
            price: p.price()?,
        });
        Ok(())
    }

    /// Add liquidity at the current ratio, leaving the price untouched.
    ///
    /// Deepening the pool raises the open-interest ceiling downstream, which
    /// is the behaviour the depth invariant is built on.
    pub fn add_liquidity(ctx: Context<Modify>, usdc: u64) -> Result<()> {
        require!(usdc > 0, AmmError::EmptyLiquidity);
        let p = &mut ctx.accounts.pool;
        let before = p.price()?;
        let fraction = u64::try_from(
            (usdc as u128)
                .checked_mul(p.fraction as u128)
                .ok_or(AmmError::Overflow)?
                / p.usdc as u128,
        )
        .map_err(|_| AmmError::Overflow)?;
        p.usdc = p.usdc.checked_add(usdc).ok_or(AmmError::Overflow)?;
        p.fraction = p.fraction.checked_add(fraction).ok_or(AmmError::Overflow)?;
        // Proportional by construction, so the price must not have moved more
        // than integer rounding allows.
        require!(p.price()?.abs_diff(before) <= 1, AmmError::PriceDrifted);
        emit!(ReservesChanged {
            pool: p.key(),
            usdc: p.usdc,
            fraction: p.fraction,
            price: p.price()?,
        });
        Ok(())
    }

    /// Remove liquidity at the current ratio.
    ///
    /// Exists so the team can drain the pool below `min_pool_depth` and watch
    /// the oracle refuse to price it — the attack of pulling liquidity to make
    /// the oracle cheap to push.
    pub fn remove_liquidity(ctx: Context<Modify>, usdc: u64) -> Result<()> {
        let p = &mut ctx.accounts.pool;
        require!(usdc < p.usdc, AmmError::WouldEmptyPool);
        let fraction = u64::try_from(
            (usdc as u128)
                .checked_mul(p.fraction as u128)
                .ok_or(AmmError::Overflow)?
                / p.usdc as u128,
        )
        .map_err(|_| AmmError::Overflow)?;
        require!(fraction < p.fraction, AmmError::WouldEmptyPool);
        p.usdc -= usdc;
        p.fraction -= fraction;
        emit!(ReservesChanged {
            pool: p.key(),
            usdc: p.usdc,
            fraction: p.fraction,
            price: p.price()?,
        });
        Ok(())
    }

    /// Swap against the curve, moving the price. `x * y = k`.
    ///
    /// `usdc_in > 0` buys fractions and pushes the price up; otherwise
    /// `fraction_in` sells fractions and pushes it down.
    pub fn swap(ctx: Context<Modify>, usdc_in: u64, fraction_in: u64) -> Result<()> {
        require!(
            (usdc_in > 0) ^ (fraction_in > 0),
            AmmError::ExactlyOneSide
        );
        let p = &mut ctx.accounts.pool;
        let k = (p.usdc as u128)
            .checked_mul(p.fraction as u128)
            .ok_or(AmmError::Overflow)?;

        if usdc_in > 0 {
            let new_usdc = p.usdc.checked_add(usdc_in).ok_or(AmmError::Overflow)?;
            let new_fraction = u64::try_from(k / new_usdc as u128).map_err(|_| AmmError::Overflow)?;
            require!(new_fraction > 0, AmmError::WouldEmptyPool);
            p.usdc = new_usdc;
            p.fraction = new_fraction;
        } else {
            let new_fraction = p
                .fraction
                .checked_add(fraction_in)
                .ok_or(AmmError::Overflow)?;
            let new_usdc = u64::try_from(k / new_fraction as u128).map_err(|_| AmmError::Overflow)?;
            require!(new_usdc > 0, AmmError::WouldEmptyPool);
            p.usdc = new_usdc;
            p.fraction = new_fraction;
        }

        emit!(ReservesChanged {
            pool: p.key(),
            usdc: p.usdc,
            fraction: p.fraction,
            price: p.price()?,
        });
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct MockPool {
    /// USDC reserve, native units. This is the `R` the depth ceiling reads.
    pub usdc: u64,
    /// Card-fraction reserve, native units.
    pub fraction: u64,
}

impl MockPool {
    /// `price = usdc / fraction`, in WAD — the same expression the oracle's
    /// adapter computes from the raw bytes.
    pub fn price(&self) -> Result<u64> {
        require!(self.fraction > 0, AmmError::WouldEmptyPool);
        let p = div_wad_floor(self.usdc as u128, self.fraction as u128)
            .map_err(|_| error!(AmmError::Overflow))?;
        u64::try_from(p).map_err(|_| error!(AmmError::Overflow))
    }
}

/// USDC needed to move the price by a factor of `(1 + delta_wad)` on a
/// constant-product curve, exactly: `R * (sqrt(1+delta) - 1)`.
///
/// Exposed so the attack tests can compute a push instead of guessing one, and
/// so the number in the UI comes from the same formula the ceiling uses.
pub fn usdc_to_move_price(usdc_reserve: u64, delta_wad: u64) -> Option<u64> {
    let one_plus = slab_math::WAD.checked_add(delta_wad as u128)?;
    let root = isqrt(one_plus.checked_mul(slab_math::WAD)?);
    let factor = root.checked_sub(slab_math::WAD)?;
    u64::try_from((usdc_reserve as u128).checked_mul(factor)? / slab_math::WAD).ok()
}

#[derive(Accounts)]
pub struct CreatePool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + MockPool::INIT_SPACE)]
    pub pool: Account<'info, MockPool>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Modify<'info> {
    /// Permissionless: this is a test fixture, not an exchange.
    pub caller: Signer<'info>,
    #[account(mut)]
    pub pool: Account<'info, MockPool>,
}

#[event]
pub struct ReservesChanged {
    pub pool: Pubkey,
    pub usdc: u64,
    pub fraction: u64,
    pub price: u64,
}

#[error_code]
pub enum AmmError {
    #[msg("Liquidity must be greater than zero")]
    EmptyLiquidity,
    #[msg("Operation would empty the pool")]
    WouldEmptyPool,
    #[msg("Provide exactly one of usdc_in or fraction_in")]
    ExactlyOneSide,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Proportional liquidity change moved the price")]
    PriceDrifted,
}

#[cfg(test)]
mod tests {
    use super::*;
    use slab_math::WAD;

    const USDC: u64 = 1_000_000;

    fn pool() -> MockPool {
        // 60k USDC against 60k fractions -> $1.00 per fraction
        MockPool {
            usdc: 60_000 * USDC,
            fraction: 60_000 * USDC,
        }
    }

    fn swap_usdc_in(p: &mut MockPool, amount: u64) {
        let k = p.usdc as u128 * p.fraction as u128;
        p.usdc += amount;
        p.fraction = (k / p.usdc as u128) as u64;
    }

    #[test]
    fn price_starts_at_parity() {
        assert_eq!(pool().price().unwrap(), WAD as u64);
    }

    #[test]
    fn buying_fractions_pushes_the_price_up() {
        let mut p = pool();
        let before = p.price().unwrap();
        swap_usdc_in(&mut p, 5_000 * USDC);
        assert!(p.price().unwrap() > before);
    }

    #[test]
    fn the_product_is_preserved_within_rounding() {
        let mut p = pool();
        let k0 = p.usdc as u128 * p.fraction as u128;
        swap_usdc_in(&mut p, 5_000 * USDC);
        let k1 = p.usdc as u128 * p.fraction as u128;
        // integer division can only lose, never create
        assert!(k1 <= k0);
        assert!((k0 - k1) * 1_000_000 / k0 == 0, "lost more than a millionth of k");
    }

    #[test]
    fn the_cost_to_move_the_price_matches_the_ceiling_formula() {
        // This is the number the depth ceiling is derived from. If the curve
        // and the formula disagree, the ceiling is protecting against the
        // wrong attack.
        let depth = 60_000 * USDC;
        let delta = 187_500u64; // 0.1875, the 5x liquidation move
        let predicted = usdc_to_move_price(depth, delta).unwrap();

        let mut p = pool();
        swap_usdc_in(&mut p, predicted);
        let achieved = p.price().unwrap();
        let target = WAD as u64 + (WAD as u64 * 1_875 / 10_000);

        // within 1% of the intended move
        let err = achieved.abs_diff(target) as u128 * 10_000 / target as u128;
        assert!(err <= 100, "predicted push landed {err} bps away from target");
    }

    #[test]
    fn a_deeper_pool_costs_proportionally_more_to_push() {
        let delta = 187_500u64;
        let a = usdc_to_move_price(25_000 * USDC, delta).unwrap();
        let b = usdc_to_move_price(50_000 * USDC, delta).unwrap();
        assert_eq!(b / a, 2, "cost is linear in depth, as the ceiling assumes");
    }

    #[test]
    fn a_shallow_pool_is_cheap_to_push_which_is_the_whole_problem() {
        let delta = 187_500u64;
        let deep = usdc_to_move_price(1_000_000 * USDC, delta).unwrap();
        let thin = usdc_to_move_price(5_000 * USDC, delta).unwrap();
        assert!(thin * 100 < deep, "thin pools must be far cheaper to move");
    }

    #[test]
    fn proportional_liquidity_does_not_move_the_price() {
        let mut p = pool();
        let before = p.price().unwrap();
        let add = 10_000 * USDC;
        let fraction = (add as u128 * p.fraction as u128 / p.usdc as u128) as u64;
        p.usdc += add;
        p.fraction += fraction;
        assert!(p.price().unwrap().abs_diff(before) <= 1);
    }

    #[test]
    fn an_empty_fraction_reserve_has_no_price() {
        let p = MockPool {
            usdc: 1,
            fraction: 0,
        };
        assert!(p.price().is_err());
    }
}
