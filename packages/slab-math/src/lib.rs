//! Fixed-point arithmetic for SLAB.
//!
//! RULE ZERO: no floating point anywhere near money. Everything here is
//! integer arithmetic with an explicit scale and a rounding direction stated
//! per function.
//!
//! # Scales
//!
//! | constant | value | used for |
//! |---|---|---|
//! | [`WAD`]  | 1e6  | ratios, prices, parameters (phi, delta, mu, psi) |
//! | [`BPS`]  | 1e4  | fees and haircuts coming from configuration |
//! | [`RAY`]  | 1e12 | accumulated borrow index (needs more places) |
//!
//! Token amounts are `u64` in native units. USDC has 6 decimals, so
//! 1 USDC = 1_000_000 = 1 WAD. That coincidence is deliberate: a WAD price
//! times a native quantity lands directly in native USDC.
//!
//! # Rounding policy
//!
//! Always in the pool's favour, never the user's. When in doubt the pool
//! keeps the cent. Concretely:
//!
//! - deposit -> CLP minted rounds DOWN ([`shares_for_deposit`])
//! - withdrawal -> assets returned round DOWN ([`assets_for_shares`])
//! - fees, borrow owed and required margin round UP
//! - trader PnL rounds DOWN in magnitude
//!
//! Every function below states its direction in its name or its doc.
//!
//! # Overflow
//!
//! Intermediates are `u128`/`i128`. Nothing narrows with `as` unchecked.
//! Every conversion back to `u64` goes through [`to_u64`], which returns
//! [`MathError::Overflow`] instead of truncating silently.

#![allow(clippy::result_large_err)]

/// Scale for ratios, prices and parameters. 1.0 == `WAD`.
pub const WAD: u128 = 1_000_000;
/// Scale for configured basis points. 100% == `BPS`.
pub const BPS: u128 = 10_000;
/// Scale of the accumulated borrow index.
pub const RAY: u128 = 1_000_000_000_000;

/// Seconds in an hour. The spec's borrow rate is hourly.
pub const SECONDS_PER_HOUR: i64 = 3_600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError {
    /// The result does not fit the destination type.
    Overflow,
    /// Division by zero.
    DivByZero,
    /// An argument violated a documented precondition.
    BadInput,
}

impl core::fmt::Display for MathError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            MathError::Overflow => write!(f, "overflow"),
            MathError::DivByZero => write!(f, "division by zero"),
            MathError::BadInput => write!(f, "bad input"),
        }
    }
}

pub type MResult<T> = core::result::Result<T, MathError>;

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

/// Narrow `u128` to `u64`, failing instead of truncating.
#[inline]
pub fn to_u64(x: u128) -> MResult<u64> {
    u64::try_from(x).map_err(|_| MathError::Overflow)
}

/// `a * b / c`, rounding DOWN.
#[inline]
pub fn mul_div_floor(a: u128, b: u128, c: u128) -> MResult<u128> {
    if c == 0 {
        return Err(MathError::DivByZero);
    }
    a.checked_mul(b)
        .ok_or(MathError::Overflow)
        .map(|prod| prod / c)
}

/// `a * b / c`, rounding UP.
///
/// Used where rounding must favour the pool: fees, borrow owed, minimum
/// required margin.
#[inline]
pub fn mul_div_ceil(a: u128, b: u128, c: u128) -> MResult<u128> {
    if c == 0 {
        return Err(MathError::DivByZero);
    }
    let prod = a.checked_mul(b).ok_or(MathError::Overflow)?;
    Ok(prod.div_ceil(c))
}

/// `x * f / WAD`, rounding down. `f` is a WAD ratio.
#[inline]
pub fn mul_wad_floor(x: u128, f: u128) -> MResult<u128> {
    mul_div_floor(x, f, WAD)
}

/// `x * f / WAD`, rounding up.
#[inline]
pub fn mul_wad_ceil(x: u128, f: u128) -> MResult<u128> {
    mul_div_ceil(x, f, WAD)
}

/// `x * WAD / d`, rounding down. The result is a WAD ratio.
#[inline]
pub fn div_wad_floor(x: u128, d: u128) -> MResult<u128> {
    mul_div_floor(x, WAD, d)
}

/// `x * bps / BPS`, rounding up. Used for fees and haircuts.
#[inline]
pub fn apply_bps_ceil(x: u128, bps: u128) -> MResult<u128> {
    mul_div_ceil(x, bps, BPS)
}

/// `x - x*bps/BPS`, with the deduction rounded UP (the pool keeps the rest).
///
/// Used for the card-fraction deposit haircut.
#[inline]
pub fn subtract_bps_ceil(x: u128, bps: u128) -> MResult<u128> {
    if bps > BPS {
        return Err(MathError::BadInput);
    }
    let cut = apply_bps_ceil(x, bps)?;
    Ok(x.saturating_sub(cut))
}

/// Integer square root by Newton's method. `isqrt(x)` = largest `r` with `r*r <= x`.
pub fn isqrt(x: u128) -> u128 {
    if x < 2 {
        return x;
    }
    // initial guess from the highest set bit
    let mut r = 1u128 << ((128 - x.leading_zeros()).div_ceil(2));
    loop {
        let next = (r + x / r) / 2;
        if next >= r {
            return r;
        }
        r = next;
    }
}

/// `sqrt(x)` with `x` and the result both in WAD. Rounds DOWN.
///
/// `sqrt_wad(WAD) == WAD`, `sqrt_wad(4*WAD) == 2*WAD`.
pub fn sqrt_wad(x_wad: u128) -> MResult<u128> {
    let scaled = x_wad.checked_mul(WAD).ok_or(MathError::Overflow)?;
    Ok(isqrt(scaled))
}

// ---------------------------------------------------------------------------
// utilization and borrow
// ---------------------------------------------------------------------------

/// `u = OI_total / capacity`, in WAD. Saturates at `WAD` (100%).
///
/// Zero capacity with zero OI is 0; zero capacity with positive OI is 100%,
/// because there is no room at all.
pub fn utilization(oi_total: u64, capacity: u64) -> MResult<u128> {
    if capacity == 0 {
        return Ok(if oi_total == 0 { 0 } else { WAD });
    }
    let u = div_wad_floor(oi_total as u128, capacity as u128)?;
    Ok(u.min(WAD))
}

/// `r_hourly = r0 + r1 * u^2`, in WAD per hour.
///
/// The quadratic term is what makes the rate climb slowly while capacity
/// remains and spike near the ceiling.
pub fn borrow_rate_hourly(r0_wad: u128, r1_wad: u128, u_wad: u128) -> MResult<u128> {
    let u2 = mul_wad_floor(u_wad, u_wad)?;
    let quad = mul_wad_floor(r1_wad, u2)?;
    r0_wad.checked_add(quad).ok_or(MathError::Overflow)
}

/// Crowded-side borrow multiplier: `1 + psi * max(0, (side - opposite)/total)`.
///
/// Returns WAD (== 1.0) when the side is not crowded.
pub fn side_multiplier(oi_side: u64, oi_opposite: u64, psi_wad: u128) -> MResult<u128> {
    let total = (oi_side as u128)
        .checked_add(oi_opposite as u128)
        .ok_or(MathError::Overflow)?;
    if total == 0 || oi_side <= oi_opposite {
        return Ok(WAD);
    }
    let excess = (oi_side - oi_opposite) as u128;
    let skew = div_wad_floor(excess, total)?;
    let bump = mul_wad_floor(psi_wad, skew)?;
    WAD.checked_add(bump).ok_or(MathError::Overflow)
}

/// Advance the borrow index ([`RAY`] scale) by `elapsed` seconds.
///
/// Rounds UP: the trader pays the cent, never the pool.
pub fn accrue_borrow_index(
    index_ray: u128,
    rate_hourly_wad: u128,
    elapsed_secs: i64,
) -> MResult<u128> {
    if elapsed_secs < 0 {
        return Err(MathError::BadInput);
    }
    if elapsed_secs == 0 || rate_hourly_wad == 0 {
        return Ok(index_ray);
    }
    // factor = rate * elapsed / 3600, in WAD
    let factor = mul_div_ceil(
        rate_hourly_wad,
        elapsed_secs as u128,
        SECONDS_PER_HOUR as u128,
    )?;
    let growth = mul_div_ceil(index_ray, factor, WAD)?;
    index_ray.checked_add(growth).ok_or(MathError::Overflow)
}

/// Borrow owed by a position between its entry index and the current one.
///
/// Rounds UP.
pub fn borrow_owed(notional: u64, index_entry_ray: u128, index_now_ray: u128) -> MResult<u64> {
    if index_now_ray < index_entry_ray {
        return Err(MathError::BadInput);
    }
    if index_entry_ray == 0 {
        return Err(MathError::BadInput);
    }
    let delta = index_now_ray - index_entry_ray;
    let owed = mul_div_ceil(notional as u128, delta, index_entry_ray)?;
    to_u64(owed)
}

// ---------------------------------------------------------------------------
// position
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Long,
    Short,
}

/// Position PnL in native USDC, signed.
///
/// `long  = (price - entry)/entry * notional`
/// `short = (entry - price)/entry * notional`
///
/// Rounds DOWN in magnitude: a trader's gain truncates down, and so does a
/// loss. The pool never pays the rounding cent.
pub fn pnl(side: Side, entry_price: u64, price: u64, notional: u64) -> MResult<i128> {
    if entry_price == 0 {
        return Err(MathError::DivByZero);
    }
    let entry = entry_price as u128;
    let now = price as u128;
    let (hi, lo, positive) = match side {
        Side::Long if now >= entry => (now, entry, true),
        Side::Long => (entry, now, false),
        Side::Short if entry >= now => (entry, now, true),
        Side::Short => (now, entry, false),
    };
    let magnitude = mul_div_floor(notional as u128, hi - lo, entry)?;
    let m = i128::try_from(magnitude).map_err(|_| MathError::Overflow)?;
    Ok(if positive { m } else { -m })
}

/// Position equity: `margin + pnl - borrow_owed`. May be negative — that is
/// bad debt, and the caller must handle it explicitly.
pub fn equity(margin: u64, pnl_signed: i128, borrow_owed: u64) -> MResult<i128> {
    let m = margin as i128;
    let b = borrow_owed as i128;
    m.checked_add(pnl_signed)
        .and_then(|v| v.checked_sub(b))
        .ok_or(MathError::Overflow)
}

/// Health = `equity / notional`, signed, in WAD. Liquidatable when below
/// maintenance margin.
pub fn health_wad(equity_signed: i128, notional: u64) -> MResult<i128> {
    if notional == 0 {
        return Err(MathError::DivByZero);
    }
    let scaled = equity_signed
        .checked_mul(WAD as i128)
        .ok_or(MathError::Overflow)?;
    Ok(scaled / notional as i128)
}

/// Price at which the position reaches maintenance margin. Deterministic and
/// computable the moment it opens, as the spec requires.
///
/// Tolerated move = `(margin - borrow)/notional - maintenance`.
/// If the position is already below maintenance, returns the entry price
/// itself — meaning already liquidatable.
pub fn liquidation_price(
    side: Side,
    entry_price: u64,
    margin: u64,
    notional: u64,
    borrow_owed: u64,
    maintenance_wad: u128,
) -> MResult<u64> {
    if notional == 0 {
        return Err(MathError::DivByZero);
    }
    let net = (margin as i128) - (borrow_owed as i128);
    if net <= 0 {
        return Ok(entry_price);
    }
    let buffer = div_wad_floor(net as u128, notional as u128)?;
    if buffer <= maintenance_wad {
        return Ok(entry_price);
    }
    let move_wad = buffer - maintenance_wad;
    let delta = mul_wad_floor(entry_price as u128, move_wad)?;
    let p = match side {
        Side::Long => (entry_price as u128).saturating_sub(delta),
        Side::Short => (entry_price as u128)
            .checked_add(delta)
            .ok_or(MathError::Overflow)?,
    };
    to_u64(p)
}

/// Minimum margin required to open `notional` at maximum leverage
/// `max_leverage_wad`. Rounds UP.
pub fn min_margin(notional: u64, max_leverage_wad: u128) -> MResult<u64> {
    if max_leverage_wad == 0 {
        return Err(MathError::DivByZero);
    }
    let m = mul_div_ceil(notional as u128, WAD, max_leverage_wad)?;
    to_u64(m)
}

// ---------------------------------------------------------------------------
// risk ceilings
// ---------------------------------------------------------------------------

/// Open-interest ceiling from the liquid sleeve's solvency.
///
/// `OI_max = U * phi / delta_max`
///
/// Comes from the invariant `OI * delta_max <= U * phi`: a winning trader is
/// always paid out of liquid assets.
pub fn oi_cap_solvency(usdc_sleeve: u64, phi_wad: u128, delta_max_wad: u128) -> MResult<u64> {
    if delta_max_wad == 0 {
        return Err(MathError::DivByZero);
    }
    let budget = mul_wad_floor(usdc_sleeve as u128, phi_wad)?;
    let cap = mul_div_floor(budget, WAD, delta_max_wad)?;
    to_u64(cap)
}

/// Open-interest ceiling from AMM depth — the anti-manipulation defence.
///
/// `OI_max = R * (sqrt(1 + delta_liq) - 1) / mu`
///
/// The numerator is the cost of pushing a constant-product pool's price to
/// the liquidation point; `mu` is the share of open interest an attacker
/// captures in the cascade. Moving the price must cost more than it pays.
pub fn oi_cap_depth(depth_usdc: u64, delta_liq_wad: u128, mu_wad: u128) -> MResult<u64> {
    if mu_wad == 0 {
        return Err(MathError::DivByZero);
    }
    let one_plus = WAD.checked_add(delta_liq_wad).ok_or(MathError::Overflow)?;
    let root = sqrt_wad(one_plus)?;
    let factor = root.saturating_sub(WAD);
    let cost = mul_wad_floor(depth_usdc as u128, factor)?;
    let cap = mul_div_floor(cost, WAD, mu_wad)?;
    to_u64(cap)
}

/// The ceiling that counts is the LOWER of the two. Never the higher, never the average.
pub fn oi_allowed(cap_solvency: u64, cap_depth: u64) -> u64 {
    cap_solvency.min(cap_depth)
}

/// Approximate cost of moving a constant-product pool's price by a factor of
/// `(1 + delta)`. Exposed for the UI and the attack tests.
pub fn cost_to_move_price(depth_usdc: u64, delta_wad: u128) -> MResult<u64> {
    let one_plus = WAD.checked_add(delta_wad).ok_or(MathError::Overflow)?;
    let root = sqrt_wad(one_plus)?;
    let factor = root.saturating_sub(WAD);
    to_u64(mul_wad_floor(depth_usdc as u128, factor)?)
}

// ---------------------------------------------------------------------------
// pool
// ---------------------------------------------------------------------------

/// Pool NAV: `U + card_sleeve_value - trader_pnl - liabilities`.
///
/// `liabilities` is everything the pool owes that is not trader PnL: realised
/// bad debt, plus margin it is holding on behalf of open positions. Margin
/// sits in the same vault as the LPs' money but is not the LPs' money, and a
/// NAV that counts it lets an early withdrawer take value from whoever stays.
///
/// Positive trader PnL LEAVES the pool, and so do liabilities.
/// Saturates at zero: a negative NAV means insolvency and becomes `Settled`,
/// not a negative number circulating through the rest of the program.
pub fn nav(usdc_sleeve: u64, card_sleeve_value: u64, trader_pnl: i128, liabilities: u64) -> MResult<u64> {
    let assets = (usdc_sleeve as i128)
        .checked_add(card_sleeve_value as i128)
        .ok_or(MathError::Overflow)?;
    let after_pnl = assets
        .checked_sub(trader_pnl)
        .and_then(|v| v.checked_sub(liabilities as i128))
        .ok_or(MathError::Overflow)?;
    if after_pnl <= 0 {
        return Ok(0);
    }
    to_u64(after_pnl as u128)
}

/// CLP price in WAD. An empty pool is worth 1.0 by convention (first deposit).
pub fn clp_price(nav: u64, clp_supply: u64) -> MResult<u128> {
    if clp_supply == 0 {
        return Ok(WAD);
    }
    div_wad_floor(nav as u128, clp_supply as u128)
}

/// CLP minted for a deposit of `value` (haircut already applied).
/// Rounds DOWN: whoever enters never receives an extra share.
pub fn shares_for_deposit(value: u64, nav: u64, clp_supply: u64) -> MResult<u64> {
    if clp_supply == 0 || nav == 0 {
        return Ok(value); // bootstrap: 1 CLP per unit of value
    }
    to_u64(mul_div_floor(value as u128, clp_supply as u128, nav as u128)?)
}

/// Value returned for burning `shares`. Rounds DOWN.
pub fn assets_for_shares(shares: u64, nav: u64, clp_supply: u64) -> MResult<u64> {
    if clp_supply == 0 {
        return Err(MathError::DivByZero);
    }
    to_u64(mul_div_floor(shares as u128, nav as u128, clp_supply as u128)?)
}

/// Proportional slice of one sleeve for a redemption of `shares`.
///
/// Withdrawals are ALWAYS proportional across both sleeves. There is no
/// USDC-only path: if there were, the first out would take the liquid side
/// and the last would be left holding the whole illiquid one.
pub fn proportional_share(sleeve_amount: u64, shares: u64, clp_supply: u64) -> MResult<u64> {
    if clp_supply == 0 {
        return Err(MathError::DivByZero);
    }
    if shares > clp_supply {
        return Err(MathError::BadInput);
    }
    to_u64(mul_div_floor(
        sleeve_amount as u128,
        shares as u128,
        clp_supply as u128,
    )?)
}

/// Pro-rata haircut at graceful settlement: what each holder receives when
/// the pool does not cover the total owed. Equal for everyone, by construction.
pub fn prorata_haircut(claim: u64, total_claims: u64, available: u64) -> MResult<u64> {
    if total_claims == 0 {
        return Ok(0);
    }
    if available >= total_claims {
        return Ok(claim);
    }
    to_u64(mul_div_floor(
        claim as u128,
        available as u128,
        total_claims as u128,
    )?)
}

/// Weight of one card inside the card sleeve, in WAD. Checked against
/// `max_card_weight` so the pool never becomes a bet on a single card.
pub fn card_weight(card_value: u64, card_sleeve_value: u64) -> MResult<u128> {
    if card_sleeve_value == 0 {
        return Ok(0);
    }
    div_wad_floor(card_value as u128, card_sleeve_value as u128)
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const USDC: u64 = 1_000_000;

    // ---- primitives ----

    #[test]
    fn mul_div_rounds_in_the_declared_direction() {
        assert_eq!(mul_div_floor(10, 1, 3).unwrap(), 3);
        assert_eq!(mul_div_ceil(10, 1, 3).unwrap(), 4);
        // exact division is unaffected by direction
        assert_eq!(mul_div_floor(9, 1, 3).unwrap(), 3);
        assert_eq!(mul_div_ceil(9, 1, 3).unwrap(), 3);
    }

    #[test]
    fn div_by_zero_is_an_error_not_a_panic() {
        assert_eq!(mul_div_floor(1, 1, 0), Err(MathError::DivByZero));
        assert_eq!(mul_div_ceil(1, 1, 0), Err(MathError::DivByZero));
        assert_eq!(clp_price(1, 0).unwrap(), WAD); // defined case, not an error
        assert_eq!(assets_for_shares(1, 1, 0), Err(MathError::DivByZero));
        assert_eq!(health_wad(1, 0), Err(MathError::DivByZero));
        assert_eq!(pnl(Side::Long, 0, 1, 1), Err(MathError::DivByZero));
    }

    #[test]
    fn overflow_is_caught_not_truncated() {
        assert_eq!(mul_div_floor(u128::MAX, 2, 1), Err(MathError::Overflow));
        assert_eq!(to_u64(u64::MAX as u128 + 1), Err(MathError::Overflow));
        // a result too large for u64 becomes an error, not a wrong number
        assert_eq!(
            oi_cap_solvency(u64::MAX, WAD, 1),
            Err(MathError::Overflow)
        );
    }

    #[test]
    fn to_u64_boundary() {
        assert_eq!(to_u64(u64::MAX as u128).unwrap(), u64::MAX);
        assert!(to_u64(u64::MAX as u128 + 1).is_err());
    }

    #[test]
    fn isqrt_is_exact_on_squares_and_floors_otherwise() {
        assert_eq!(isqrt(0), 0);
        assert_eq!(isqrt(1), 1);
        assert_eq!(isqrt(3), 1);
        assert_eq!(isqrt(4), 2);
        assert_eq!(isqrt(8), 2);
        assert_eq!(isqrt(9), 3);
        assert_eq!(isqrt(1_000_000), 1_000);
        for n in 1u128..2_000 {
            let r = isqrt(n);
            assert!(r * r <= n, "isqrt({n}) too high");
            assert!((r + 1) * (r + 1) > n, "isqrt({n}) too low");
        }
    }

    #[test]
    fn sqrt_wad_identity() {
        assert_eq!(sqrt_wad(WAD).unwrap(), WAD);
        assert_eq!(sqrt_wad(4 * WAD).unwrap(), 2 * WAD);
        // sqrt(1.1875) ~= 1.089724...
        let r = sqrt_wad(WAD + 187_500).unwrap();
        assert!((1_089_000..=1_090_000).contains(&r), "got {r}");
    }

    #[test]
    fn subtract_bps_keeps_the_remainder_for_the_pool() {
        // a 3% haircut on 1000 -> 970
        assert_eq!(subtract_bps_ceil(1_000, 300).unwrap(), 970);
        // the deduction rounds up: 3% of 101 = 3.03 -> 4
        assert_eq!(subtract_bps_ceil(101, 300).unwrap(), 97);
        assert_eq!(subtract_bps_ceil(100, 20_000), Err(MathError::BadInput));
    }

    // ---- utilization and borrow ----

    #[test]
    fn utilization_saturates_and_handles_empty_capacity() {
        assert_eq!(utilization(0, 0).unwrap(), 0);
        assert_eq!(utilization(1, 0).unwrap(), WAD);
        assert_eq!(utilization(50, 100).unwrap(), WAD / 2);
        assert_eq!(utilization(200, 100).unwrap(), WAD); // saturates
    }

    #[test]
    fn borrow_rate_is_quadratic_in_utilization() {
        let r0 = 50; // 0.005% in WAD
        let r1 = 500; // 0.05% in WAD
        let at = |u: u128| borrow_rate_hourly(r0, r1, u).unwrap();

        assert_eq!(at(0), r0);
        assert_eq!(at(WAD), r0 + r1);

        // doubling utilization quadruples the term, up to rounding down:
        // at u=0.25 the exact term is 31.25 and becomes 31, so 31*4 = 124
        // against 125 measured. The loss is always <= 1 unit and always in
        // the pool's favour.
        let a = at(WAD / 4) - r0;
        let b = at(WAD / 2) - r0;
        assert!(
            b >= a * 4 && b - a * 4 <= 1,
            "expected ~{} from quadratic scaling, measured {b}",
            a * 4
        );

        // with parameters that divide exactly, the relation is exact
        let at2 = |u: u128| borrow_rate_hourly(0, WAD, u).unwrap();
        assert_eq!(at2(WAD / 2), WAD / 4);
        assert_eq!(at2(WAD / 4), WAD / 16);
        assert_eq!(at2(WAD / 2), at2(WAD / 4) * 4);
    }

    #[test]
    fn crowded_side_pays_more_and_thin_side_does_not() {
        let psi = WAD / 2; // 0.5
        // balanced
        assert_eq!(side_multiplier(100, 100, psi).unwrap(), WAD);
        // the thin side never pays a premium
        assert_eq!(side_multiplier(10, 90, psi).unwrap(), WAD);
        // empty book
        assert_eq!(side_multiplier(0, 0, psi).unwrap(), WAD);
        // 90/10 -> skew 0.8 -> multiplier 1.4
        assert_eq!(side_multiplier(90, 10, psi).unwrap(), WAD + 400_000);
        // 100/0 -> skew 1.0 -> multiplier 1.5
        assert_eq!(side_multiplier(100, 0, psi).unwrap(), WAD + 500_000);
    }

    #[test]
    fn borrow_index_only_grows_and_rounds_against_the_trader() {
        let start = RAY;
        let rate = 1_000; // 0.1%/h em WAD
        let after = accrue_borrow_index(start, rate, SECONDS_PER_HOUR).unwrap();
        assert!(after > start);
        // one hour at 0.1% -> +0.1%
        assert_eq!(after, start + RAY / 1_000);

        // zero elapsed does not move it
        assert_eq!(accrue_borrow_index(start, rate, 0).unwrap(), start);
        // a zero rate does not move it
        assert_eq!(accrue_borrow_index(start, 0, 7_200).unwrap(), start);
        // negative elapsed is invalid input, not a silent decrement
        assert_eq!(
            accrue_borrow_index(start, rate, -1),
            Err(MathError::BadInput)
        );
    }

    #[test]
    fn borrow_owed_rejects_a_regressing_index() {
        assert_eq!(borrow_owed(1_000, RAY, RAY - 1), Err(MathError::BadInput));
        assert_eq!(borrow_owed(1_000, 0, RAY), Err(MathError::BadInput));
        assert_eq!(borrow_owed(1_000, RAY, RAY).unwrap(), 0);
        // index rose 1% -> the borrower pays 1% of notional, rounded up
        assert_eq!(borrow_owed(1_000, RAY, RAY + RAY / 100).unwrap(), 10);
    }

    // ---- position ----

    #[test]
    fn pnl_is_symmetric_between_sides() {
        let entry = WAD as u64;
        let up = (WAD + WAD / 5) as u64; // +20%
        let n = 1_000 * USDC;

        let long = pnl(Side::Long, entry, up, n).unwrap();
        let short = pnl(Side::Short, entry, up, n).unwrap();
        assert_eq!(long, 200 * USDC as i128);
        assert_eq!(short, -(200 * USDC as i128));
        assert_eq!(long + short, 0, "zero sum across the two sides");
    }

    #[test]
    fn pnl_at_entry_is_exactly_zero() {
        let e = 1_234_567;
        assert_eq!(pnl(Side::Long, e, e, 999_999).unwrap(), 0);
        assert_eq!(pnl(Side::Short, e, e, 999_999).unwrap(), 0);
    }

    #[test]
    fn health_and_equity_track_losses_into_bad_debt() {
        let margin = 200 * USDC;
        let notional = 1_000 * USDC;
        // a 250 loss against 200 margin -> negative equity
        let p = -(250 * USDC as i128);
        let eq = equity(margin, p, 0).unwrap();
        assert!(eq < 0, "should be bad debt");
        assert!(health_wad(eq, notional).unwrap() < 0);
    }

    #[test]
    fn liquidation_price_is_deterministic_and_sided() {
        let entry = WAD as u64;
        let notional = 1_000 * USDC;
        let margin = notional / 5; // 5x
        let maint = 62_500; // 6.25% in WAD

        let l = liquidation_price(Side::Long, entry, margin, notional, 0, maint).unwrap();
        let s = liquidation_price(Side::Short, entry, margin, notional, 0, maint).unwrap();

        // buffer = 20% - 6.25% = 13.75%
        assert_eq!(l, entry - 137_500);
        assert_eq!(s, entry + 137_500);
        assert!(l < entry && s > entry);
    }

    #[test]
    fn liquidation_price_collapses_when_already_underwater() {
        let entry = WAD as u64;
        let notional = 1_000 * USDC;
        let maint = 62_500;
        // margin already eaten by borrow
        let p = liquidation_price(Side::Long, entry, 10, notional, 10_000, maint).unwrap();
        assert_eq!(p, entry, "already liquidatable");
    }

    #[test]
    fn min_margin_rounds_up() {
        // 5x on 1000 -> exactly 200
        assert_eq!(min_margin(1_000, 5 * WAD).unwrap(), 200);
        // 3x on 1000 -> 333.33 -> 334; the trader puts in the cent
        assert_eq!(min_margin(1_000, 3 * WAD).unwrap(), 334);
        assert_eq!(min_margin(1_000, 0), Err(MathError::DivByZero));
    }

    // ---- ceilings ----

    #[test]
    fn solvency_cap_matches_the_spec_formula() {
        // U = 140k, phi = 0.5, delta_max = 0.3  ->  140k*0.5/0.3 = 233_333.33
        let cap = oi_cap_solvency(140_000 * USDC, WAD / 2, 300_000).unwrap();
        assert_eq!(cap / USDC, 233_333);
    }

    #[test]
    fn depth_cap_matches_the_spec_formula() {
        // R = 60k, delta_liq = 0.1875, mu = 0.3
        // 60000 * (sqrt(1.1875)-1) / 0.3 = 60000 * 0.089724 / 0.3 ~= 17_944
        let cap = oi_cap_depth(60_000 * USDC, 187_500, 300_000).unwrap();
        assert_eq!(cap / USDC, 17_944);
    }

    #[test]
    fn the_lower_cap_always_wins() {
        let solv = oi_cap_solvency(140_000 * USDC, WAD / 2, 300_000).unwrap();
        let depth = oi_cap_depth(60_000 * USDC, 187_500, 300_000).unwrap();
        assert_eq!(oi_allowed(solv, depth), depth, "depth should bind");
        // and with a deep AMM, solvency starts to bind
        let deep = oi_cap_depth(5_000_000 * USDC, 187_500, 300_000).unwrap();
        assert_eq!(oi_allowed(solv, deep), solv);
    }

    #[test]
    fn deeper_pool_allows_more_oi_monotonically() {
        let a = oi_cap_depth(25_000 * USDC, 187_500, 300_000).unwrap();
        let b = oi_cap_depth(50_000 * USDC, 187_500, 300_000).unwrap();
        let c = oi_cap_depth(100_000 * USDC, 187_500, 300_000).unwrap();
        assert!(a < b && b < c);
        // doubling depth doubles the ceiling (the formula is linear in R)
        assert_eq!(b / a, 2);
    }

    #[test]
    fn attacking_must_cost_more_than_the_cascade_pays() {
        let depth = 60_000 * USDC;
        let mu = 300_000;
        let delta_liq = 187_500;
        let cap = oi_cap_depth(depth, delta_liq, mu).unwrap();
        let cost = cost_to_move_price(depth, delta_liq).unwrap();

        // with OI exactly at the ceiling, cost == maximum gain (the boundary)
        let gain_at_cap = mul_wad_floor(cap as u128, mu).unwrap() as u64;
        assert!(
            cost >= gain_at_cap,
            "cost {cost} should cover the gain {gain_at_cap}"
        );

        // below the ceiling, attacking loses money
        let gain_below = mul_wad_floor((cap / 2) as u128, mu).unwrap() as u64;
        assert!(cost > gain_below);
    }

    // ---- pool ----

    #[test]
    fn nav_subtracts_trader_profit_one_for_one() {
        let base = nav(140_000 * USDC, 60_000 * USDC, 0, 0).unwrap();
        assert_eq!(base, 200_000 * USDC);
        // trader gains 640 -> NAV falls by exactly 640
        let after = nav(140_000 * USDC, 60_000 * USDC, 640 * USDC as i128, 0).unwrap();
        assert_eq!(base - after, 640 * USDC);
        // trader loses 640 -> NAV rises by exactly 640
        let worse = nav(140_000 * USDC, 60_000 * USDC, -(640 * USDC as i128), 0).unwrap();
        assert_eq!(worse - base, 640 * USDC);
    }

    #[test]
    fn nav_deducts_bad_debt_and_floors_at_zero() {
        let n = nav(1_000, 0, 0, 400).unwrap();
        assert_eq!(n, 600);
        assert_eq!(nav(1_000, 0, 0, 5_000).unwrap(), 0);
        assert_eq!(nav(1_000, 0, 9_999, 0).unwrap(), 0);
    }

    #[test]
    fn first_deposit_bootstraps_one_to_one() {
        assert_eq!(shares_for_deposit(5_000, 0, 0).unwrap(), 5_000);
        assert_eq!(clp_price(0, 0).unwrap(), WAD);
    }

    #[test]
    fn deposit_then_withdraw_never_creates_value() {
        let nav0 = 200_000 * USDC;
        let supply0 = 200_000 * USDC;
        let dep = 5_000 * USDC;

        let shares = shares_for_deposit(dep, nav0, supply0).unwrap();
        let nav1 = nav0 + dep;
        let supply1 = supply0 + shares;
        let back = assets_for_shares(shares, nav1, supply1).unwrap();

        assert!(back <= dep, "got {back} back after putting in {dep}");
        assert!(dep - back <= 1, "rounding loss greater than 1 unit");
    }

    #[test]
    fn withdraw_is_proportional_across_both_sleeves() {
        let usdc = 140_000 * USDC;
        let cards = 60_000 * USDC;
        let supply = 200_000 * USDC;
        let shares = supply / 10; // 10%

        let u = proportional_share(usdc, shares, supply).unwrap();
        let c = proportional_share(cards, shares, supply).unwrap();

        assert_eq!(u, 14_000 * USDC);
        assert_eq!(c, 6_000 * USDC);
        // neither sleeve alone covers the redemption: that is the run defence
        assert!(u < shares);
    }

    #[test]
    fn proportional_share_rejects_more_shares_than_supply() {
        assert_eq!(proportional_share(100, 11, 10), Err(MathError::BadInput));
        assert_eq!(proportional_share(100, 1, 0), Err(MathError::DivByZero));
    }

    #[test]
    fn prorata_haircut_is_equal_for_everyone() {
        let total = 1_000u64;
        let available = 700u64;
        let a = prorata_haircut(600, total, available).unwrap();
        let b = prorata_haircut(400, total, available).unwrap();
        assert_eq!(a, 420);
        assert_eq!(b, 280);
        assert!(a + b <= available, "never pays out more than exists");
        // with no shortfall nobody takes a haircut
        assert_eq!(prorata_haircut(600, total, 1_000).unwrap(), 600);
    }

    #[test]
    fn card_weight_guards_against_a_single_card_pool() {
        assert_eq!(card_weight(0, 0).unwrap(), 0);
        assert_eq!(card_weight(15, 100).unwrap(), 150_000); // 15%
        let max = 150_000u128; // max_card_weight = 15%
        assert!(card_weight(16, 100).unwrap() > max, "should breach the ceiling");
    }

    // ---- end-to-end scenario from the spec ----

    #[test]
    fn full_hedge_leaves_combined_pnl_near_zero() {
        // wallet holding ~3200 in cards, 3200 short, index falls 20%
        let entry = WAD as u64;
        let notional = 3_200 * USDC;
        let after = (WAD * 80 / 100) as u64;

        let card_loss = -(mul_wad_floor(notional as u128, WAD * 20 / 100).unwrap() as i128);
        let short_gain = pnl(Side::Short, entry, after, notional).unwrap();

        assert_eq!(short_gain, 640 * USDC as i128);
        assert_eq!(card_loss + short_gain, 0, "the hedge should net to zero");
    }
}

// ---------------------------------------------------------------------------
// property tests — issue #6
// ---------------------------------------------------------------------------

/// Randomised checks over the properties that must hold for every input, not
/// just the handful a human thinks to write down.
///
/// Operation order and rounding direction are where money bugs live: a single
/// `a * b / c` reordered to `a / c * b` changes the result, and the difference
/// only shows up at inputs nobody picked by hand. These run thousands of
/// cases per property with a fixed seed, so a failure is reproducible.
#[cfg(test)]
mod properties {
    use super::*;

    /// Deterministic LCG. A real fuzzer would be better; a dependency-free one
    /// that always replays identically is better than none.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 11
        }
        /// Values biased toward realistic token amounts, with the extremes
        /// still reachable.
        fn amount(&mut self) -> u64 {
            match self.next() % 4 {
                0 => self.next() % 1_000,
                1 => self.next() % 1_000_000_000,
                2 => self.next() % 1_000_000_000_000_000,
                _ => self.next(),
            }
        }
        fn wad(&mut self) -> u128 {
            1 + (self.next() as u128 % (10 * WAD))
        }
    }

    const CASES: usize = 20_000;

    #[test]
    fn depositing_then_withdrawing_never_creates_value() {
        let mut r = Rng(0xA11CE);
        for _ in 0..CASES {
            let nav = r.amount();
            let supply = r.amount();
            let deposit = r.amount();
            if nav == 0 || supply == 0 {
                continue;
            }
            let Ok(shares) = shares_for_deposit(deposit, nav, supply) else { continue };
            let Some(nav2) = nav.checked_add(deposit) else { continue };
            let Some(supply2) = supply.checked_add(shares) else { continue };
            let Ok(back) = assets_for_shares(shares, nav2, supply2) else { continue };
            assert!(
                back <= deposit,
                "round trip created value: in {deposit}, out {back} (nav {nav}, supply {supply})"
            );
        }
    }

    #[test]
    fn the_two_sides_of_a_position_always_cancel() {
        let mut r = Rng(0xBEEF);
        for _ in 0..CASES {
            let entry = 1 + r.amount() % 1_000_000_000;
            let price = 1 + r.amount() % 1_000_000_000;
            let notional = r.amount() % 1_000_000_000_000;
            let (Ok(long), Ok(short)) = (
                pnl(Side::Long, entry, price, notional),
                pnl(Side::Short, entry, price, notional),
            ) else {
                continue;
            };
            assert_eq!(long, -short, "long and short disagreed at entry {entry} price {price}");
        }
    }

    #[test]
    fn proportional_shares_never_exceed_the_sleeve() {
        let mut r = Rng(0xC0FFEE);
        for _ in 0..CASES {
            let sleeve = r.amount();
            let supply = 1 + r.amount();
            let shares = r.next() % (supply + 1);
            let Ok(part) = proportional_share(sleeve, shares, supply) else { continue };
            assert!(part <= sleeve, "slice {part} exceeded sleeve {sleeve}");
        }
    }

    #[test]
    fn a_full_redemption_takes_everything_and_no_more() {
        let mut r = Rng(0xD15EA5E);
        for _ in 0..CASES {
            let sleeve = r.amount();
            let supply = 1 + r.amount();
            let Ok(all) = proportional_share(sleeve, supply, supply) else { continue };
            assert_eq!(all, sleeve, "redeeming the whole supply did not drain the sleeve");
        }
    }

    #[test]
    fn ceil_is_never_below_floor_and_never_more_than_one_above() {
        let mut r = Rng(0xFEED);
        for _ in 0..CASES {
            let a = r.amount() as u128;
            let b = r.amount() as u128;
            let c = 1 + r.amount() as u128;
            let (Ok(lo), Ok(hi)) = (mul_div_floor(a, b, c), mul_div_ceil(a, b, c)) else { continue };
            assert!(hi >= lo && hi - lo <= 1, "floor {lo} ceil {hi} for {a}*{b}/{c}");
        }
    }

    #[test]
    fn utilization_never_leaves_its_range() {
        let mut r = Rng(0x1234);
        for _ in 0..CASES {
            let oi = r.amount();
            let cap = r.amount();
            let Ok(u) = utilization(oi, cap) else { continue };
            assert!(u <= WAD, "utilization {u} above 100% for oi {oi} cap {cap}");
        }
    }

    #[test]
    fn the_haircut_is_monotone_in_what_is_available() {
        // More in the pot can never mean less in your hand.
        let mut r = Rng(0x5EED);
        for _ in 0..CASES {
            let claim = r.amount();
            let total = 1 + r.amount();
            let a = r.next() % (total + 1);
            let b = r.next() % (total + 1);
            let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
            let (Ok(x), Ok(y)) = (prorata_haircut(claim, total, lo), prorata_haircut(claim, total, hi)) else {
                continue;
            };
            assert!(x <= y, "haircut fell when availability rose: {x} then {y}");
        }
    }

    #[test]
    fn the_depth_ceiling_only_ever_grows_with_depth() {
        let mut r = Rng(0x9999);
        for _ in 0..1_000 {
            let mu = 1 + r.wad();
            let delta = r.wad();
            let d1 = r.amount() % 1_000_000_000_000;
            let d2 = d1.saturating_add(r.amount() % 1_000_000_000);
            let (Ok(c1), Ok(c2)) = (oi_cap_depth(d1, delta, mu), oi_cap_depth(d2, delta, mu)) else {
                continue;
            };
            assert!(c2 >= c1, "deeper pool allowed less OI: {c1} then {c2}");
        }
    }

    #[test]
    fn nothing_panics_on_adversarial_input() {
        // Every entry point must return an error rather than unwind. A panic
        // inside a program aborts the transaction with no useful error, and
        // on-chain that is indistinguishable from a bug in the caller.
        let mut r = Rng(0xDEAD);
        for _ in 0..CASES {
            let a = r.amount();
            let b = r.amount();
            let c = r.amount();
            let w = r.wad();
            let _ = mul_div_floor(a as u128, b as u128, c as u128);
            let _ = mul_div_ceil(a as u128, b as u128, c as u128);
            let _ = utilization(a, b);
            let _ = borrow_rate_hourly(a as u128, b as u128, w);
            let _ = side_multiplier(a, b, w);
            let _ = pnl(Side::Long, a, b, c);
            let _ = pnl(Side::Short, a, b, c);
            let _ = liquidation_price(Side::Long, a, b, c, a, w);
            let _ = oi_cap_solvency(a, w, w);
            let _ = oi_cap_depth(a, w, w);
            let _ = nav(a, b, c as i128, a);
            let _ = clp_price(a, b);
            let _ = shares_for_deposit(a, b, c);
            let _ = assets_for_shares(a, b, c);
            let _ = proportional_share(a, b, c);
            let _ = prorata_haircut(a, b, c);
            let _ = accrue_borrow_index(a as u128, w, b as i64);
            let _ = borrow_owed(a, b as u128, c as u128);
        }
    }

    /// Issue #3: 6 decimals with 1 fraction = $1 has to price real cards
    /// without coarse rounding.
    #[test]
    fn six_decimals_prices_real_cards_without_visible_rounding() {
        // Prices from the basket in the product mock, in native USDC.
        for card in [1_420_000_000u64, 980_000_000, 520_000_000, 280_000_000, 4_200_000_000] {
            // One fraction is $1, so a card is `price` fractions.
            let fractions = card;
            // Round-trip it through the WAD price the oracle produces.
            let price = WAD; // $1.00 per fraction
            let value = mul_wad_floor(fractions as u128, price).unwrap();
            assert_eq!(value as u64, card, "a card did not round-trip at par");

            // And at an awkward price, the error must stay under a cent.
            let odd = 1_234_567u128; // $1.234567
            let v = mul_wad_floor(fractions as u128, odd).unwrap();
            let implied = mul_div_floor(v, WAD, fractions as u128).unwrap();
            assert!(
                odd.abs_diff(implied) <= 1,
                "price round-trip lost more than one unit: {odd} -> {implied}"
            );
        }
    }

    #[test]
    fn a_single_fraction_is_still_worth_something() {
        // If one fraction rounded to zero at realistic prices, dust deposits
        // would mint CLP for free.
        for price in [1_000u128, 10_000, WAD, 10 * WAD] {
            let v = mul_wad_floor(1_000_000, price).unwrap(); // one whole fraction
            assert!(v > 0, "one fraction priced to zero at {price}");
        }
    }
}
