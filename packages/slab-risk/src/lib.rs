//! Risk decisions for SLAB — the rules, with no knowledge of Solana.
//!
//! # Why this crate exists
//!
//! This crate deliberately does **not** depend on `anchor-lang` or
//! `solana-program`. There is no `AccountInfo`, no `Context`, no `Signer`
//! reachable from here. That is the point: it makes it impossible to write
//! account handling inside a risk rule, and impossible to write a risk rule
//! that cannot be tested without a validator.
//!
//! The split is:
//!
//! - **this crate** decides. Pure functions over plain structs.
//! - **the program** moves tokens, validates accounts, and calls in here.
//!
//! A handler that grows past a couple dozen lines is a sign that a rule
//! leaked out of this crate. Move it back.
//!
//! Every function here is covered by unit tests that run in milliseconds
//! without compiling SBF or starting a validator.

#![forbid(unsafe_code)]

use slab_math::{
    accrue_borrow_index, apply_bps_ceil, borrow_owed as owed, borrow_rate_hourly, equity as eq,
    health_wad, liquidation_price as liq_price, min_margin, mul_wad_ceil, oi_allowed,
    oi_cap_depth, oi_cap_solvency, pnl as raw_pnl, side_multiplier, to_u64, utilization,
    MathError, Side,
};

pub use slab_math::{Side as RiskSide, RAY, WAD};

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/// Why a risk decision was refused. The program maps these onto its own
/// Anchor error codes; this crate never constructs one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskError {
    /// Market state does not allow opening new risk.
    StateForbidsOpen,
    /// Oracle is not in a tradeable state.
    OracleNotTradeable,
    /// Notional is zero.
    ZeroNotional,
    /// Margin below what max leverage requires.
    InsufficientMargin,
    /// Would exceed the lower of the two open-interest ceilings.
    CapacityExceeded,
    /// Utilization is at or above the reduce-only threshold.
    UtilizationTooHigh,
    /// Position is still above maintenance margin.
    NotLiquidatable,
    /// Fixed-point arithmetic failed.
    Math,
}

impl From<MathError> for RiskError {
    fn from(_: MathError) -> Self {
        RiskError::Math
    }
}

pub type RiskResult<T> = core::result::Result<T, RiskError>;

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

/// Economic configuration, as plain numbers.
///
/// Mirrors the serializable `PoolParams`. The mapping is one function with a
/// test behind it, so the two cannot drift apart silently.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RiskParams {
    /// Share of the USDC sleeve committable to traders. WAD.
    pub phi: u64,
    /// Adverse move the liquid sleeve must absorb. WAD.
    pub delta_max: u64,
    /// Share of open interest an attacker captures in a liquidation cascade. WAD.
    pub mu: u64,
    /// Move that takes a max-leverage position to liquidation. WAD.
    pub delta_liq: u64,
    /// Maximum leverage. WAD.
    pub base_leverage: u64,
    /// Maintenance margin. WAD.
    pub maintenance_margin: u64,
    /// Base hourly borrow rate. WAD.
    pub r0: u64,
    /// Quadratic borrow coefficient. WAD.
    pub r1: u64,
    /// Crowded-side borrow surcharge. WAD.
    pub psi: u64,
    /// Utilization at which the market stops accepting new risk. WAD.
    pub reduce_only_utilization: u64,
    /// Liquidator reward, in basis points of notional.
    pub liquidator_fee_bps: u16,
}

/// Preconditions the program evaluates before asking for a decision.
///
/// Passing booleans instead of the state enums keeps this crate free of any
/// representation choice. If the enums change shape, nothing here moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Gates {
    /// `MarketState::allows_open()`
    pub market_allows_open: bool,
    /// `OracleState::is_tradeable()`
    pub oracle_tradeable: bool,
}

/// Price data the program already read and validated from the oracle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PriceInput {
    /// Official price, WAD. Already through TWAP and clamp.
    pub price: u64,
    /// AMM reserve in native USDC. Feeds the depth ceiling.
    pub depth: u64,
}

/// Open-interest and borrow accounting for one market.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarketRisk {
    pub oi_long: u64,
    pub oi_short: u64,
    pub borrow_idx_long: u128,
    pub borrow_idx_short: u128,
    pub last_accrual_ts: i64,
}

impl MarketRisk {
    pub fn new(now: i64) -> Self {
        Self {
            oi_long: 0,
            oi_short: 0,
            borrow_idx_long: RAY,
            borrow_idx_short: RAY,
            last_accrual_ts: now,
        }
    }

    pub fn oi_total(&self) -> RiskResult<u64> {
        self.oi_long.checked_add(self.oi_short).ok_or(RiskError::Math)
    }

    pub fn oi_of(&self, side: Side) -> u64 {
        match side {
            Side::Long => self.oi_long,
            Side::Short => self.oi_short,
        }
    }

    pub fn oi_opposite(&self, side: Side) -> u64 {
        match side {
            Side::Long => self.oi_short,
            Side::Short => self.oi_long,
        }
    }

    pub fn borrow_index(&self, side: Side) -> u128 {
        match side {
            Side::Long => self.borrow_idx_long,
            Side::Short => self.borrow_idx_short,
        }
    }

    pub fn add_oi(&mut self, side: Side, notional: u64) -> RiskResult<()> {
        let slot = match side {
            Side::Long => &mut self.oi_long,
            Side::Short => &mut self.oi_short,
        };
        *slot = slot.checked_add(notional).ok_or(RiskError::Math)?;
        Ok(())
    }

    pub fn remove_oi(&mut self, side: Side, notional: u64) {
        let slot = match side {
            Side::Long => &mut self.oi_long,
            Side::Short => &mut self.oi_short,
        };
        *slot = slot.saturating_sub(notional);
    }
}

/// A single position, as plain numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PositionRisk {
    pub side: Side,
    pub notional: u64,
    pub margin: u64,
    pub entry_price: u64,
    pub borrow_idx_entry: u128,
}

// ---------------------------------------------------------------------------
// capacity — the two ceilings
// ---------------------------------------------------------------------------

/// Which ceiling is currently binding. The UI shows this; the program enforces
/// whichever is lower.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Binding {
    /// The pool's liquid sleeve is the limit.
    Solvency,
    /// The AMM's depth is the limit. With the spec parameters this is the
    /// usual case, by a wide margin.
    Depth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capacity {
    pub cap_solvency: u64,
    pub cap_depth: u64,
    /// The one that counts: always the lower of the two.
    pub cap: u64,
    pub binding: Binding,
}

/// Both open-interest ceilings, and which one binds.
///
/// - solvency: `U * phi / delta_max` — winners are always paid from liquid assets
/// - depth: `R * (sqrt(1 + delta_liq) - 1) / mu` — moving the price must cost
///   more than the liquidation cascade pays
pub fn capacity(usdc_sleeve: u64, depth: u64, p: &RiskParams) -> RiskResult<Capacity> {
    let cap_solvency = oi_cap_solvency(usdc_sleeve, p.phi as u128, p.delta_max as u128)?;
    let cap_depth = oi_cap_depth(depth, p.delta_liq as u128, p.mu as u128)?;
    Ok(Capacity {
        cap_solvency,
        cap_depth,
        cap: oi_allowed(cap_solvency, cap_depth),
        binding: if cap_solvency <= cap_depth {
            Binding::Solvency
        } else {
            Binding::Depth
        },
    })
}

// ---------------------------------------------------------------------------
// opening
// ---------------------------------------------------------------------------

/// What the program needs in order to write the position after approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenApproval {
    /// Entry price to record. Always the oracle price, never an internal one.
    pub entry_price: u64,
    /// Borrow index to stamp on the position.
    pub borrow_idx_entry: u128,
    /// Open interest after this position, for the caller to store.
    pub oi_after: u64,
    /// Capacity at decision time, for the event log.
    pub capacity: Capacity,
}

/// The single gate through which risk enters the protocol.
///
/// Everything that can refuse an opening refuses here, in one place, so there
/// is exactly one function to audit.
#[allow(clippy::too_many_arguments)]
pub fn check_open(
    mk: &MarketRisk,
    gates: Gates,
    price: PriceInput,
    usdc_sleeve: u64,
    side: Side,
    notional: u64,
    margin: u64,
    p: &RiskParams,
) -> RiskResult<OpenApproval> {
    if !gates.market_allows_open {
        return Err(RiskError::StateForbidsOpen);
    }
    if !gates.oracle_tradeable {
        return Err(RiskError::OracleNotTradeable);
    }
    if notional == 0 {
        return Err(RiskError::ZeroNotional);
    }
    if price.price == 0 {
        return Err(RiskError::OracleNotTradeable);
    }

    let needed = min_margin(notional, p.base_leverage as u128)?;
    if margin < needed {
        return Err(RiskError::InsufficientMargin);
    }

    let cap = capacity(usdc_sleeve, price.depth, p)?;
    let oi_after = mk.oi_total()?.checked_add(notional).ok_or(RiskError::Math)?;
    if oi_after > cap.cap {
        return Err(RiskError::CapacityExceeded);
    }

    // Refuse the order that would put the market into reduce-only, rather than
    // letting it in and noticing afterwards.
    let u = utilization(oi_after, cap.cap)?;
    if u >= p.reduce_only_utilization as u128 {
        return Err(RiskError::UtilizationTooHigh);
    }

    Ok(OpenApproval {
        entry_price: price.price,
        borrow_idx_entry: mk.borrow_index(side),
        oi_after,
        capacity: cap,
    })
}

// ---------------------------------------------------------------------------
// borrow
// ---------------------------------------------------------------------------

/// Hourly borrow rate for one side, including the crowded-side surcharge.
pub fn borrow_rate(mk: &MarketRisk, side: Side, cap: u64, p: &RiskParams) -> RiskResult<u128> {
    let u = utilization(mk.oi_total()?, cap)?;
    let base = borrow_rate_hourly(p.r0 as u128, p.r1 as u128, u)?;
    let mult = side_multiplier(mk.oi_of(side), mk.oi_opposite(side), p.psi as u128)?;
    Ok(mul_wad_ceil(base, mult)?)
}

/// Advance both borrow indices to `now`. Never moves backwards.
pub fn accrue(mk: &mut MarketRisk, now: i64, cap: u64, p: &RiskParams) -> RiskResult<()> {
    let elapsed = now.saturating_sub(mk.last_accrual_ts);
    if elapsed <= 0 {
        return Ok(());
    }
    let rl = borrow_rate(mk, Side::Long, cap, p)?;
    let rs = borrow_rate(mk, Side::Short, cap, p)?;
    mk.borrow_idx_long = accrue_borrow_index(mk.borrow_idx_long, rl, elapsed)?;
    mk.borrow_idx_short = accrue_borrow_index(mk.borrow_idx_short, rs, elapsed)?;
    mk.last_accrual_ts = now;
    Ok(())
}

// ---------------------------------------------------------------------------
// position maths
// ---------------------------------------------------------------------------

pub fn borrow_owed(pos: &PositionRisk, index_now: u128) -> RiskResult<u64> {
    Ok(owed(pos.notional, pos.borrow_idx_entry, index_now)?)
}

pub fn pnl(pos: &PositionRisk, price: u64) -> RiskResult<i128> {
    Ok(raw_pnl(pos.side, pos.entry_price, price, pos.notional)?)
}

pub fn equity(pos: &PositionRisk, price: u64, index_now: u128) -> RiskResult<i128> {
    Ok(eq(pos.margin, pnl(pos, price)?, borrow_owed(pos, index_now)?)?)
}

pub fn health(pos: &PositionRisk, price: u64, index_now: u128) -> RiskResult<i128> {
    Ok(health_wad(equity(pos, price, index_now)?, pos.notional)?)
}

/// Deterministic liquidation price, knowable the moment the position opens.
/// The frontend displays exactly this number.
pub fn liquidation_price(pos: &PositionRisk, index_now: u128, p: &RiskParams) -> RiskResult<u64> {
    Ok(liq_price(
        pos.side,
        pos.entry_price,
        pos.margin,
        pos.notional,
        borrow_owed(pos, index_now)?,
        p.maintenance_margin as u128,
    )?)
}

pub fn is_liquidatable(pos: &PositionRisk, price: u64, index_now: u128, p: &RiskParams) -> RiskResult<bool> {
    Ok(health(pos, price, index_now)? < p.maintenance_margin as i128)
}

/// How a liquidation splits. The three fields always reconcile with the
/// position's equity — nothing is rounded into existence or out of sight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Liquidation {
    pub liquidator_fee: u64,
    pub to_pool: u64,
    /// Loss past the margin. Recorded, never hidden.
    pub bad_debt: u64,
}

pub fn settle_liquidation(
    pos: &PositionRisk,
    price: u64,
    index_now: u128,
    p: &RiskParams,
) -> RiskResult<Liquidation> {
    let e = equity(pos, price, index_now)?;
    if e <= 0 {
        return Ok(Liquidation {
            liquidator_fee: 0,
            to_pool: 0,
            bad_debt: to_u64(e.unsigned_abs())?,
        });
    }
    let e_u = to_u64(e as u128)?;
    let fee = to_u64(apply_bps_ceil(
        pos.notional as u128,
        p.liquidator_fee_bps as u128,
    )?)?
    .min(e_u);
    Ok(Liquidation {
        liquidator_fee: fee,
        to_pool: e_u - fee,
        bad_debt: 0,
    })
}

/// Settle a position being closed by its owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Close {
    /// Paid back to the trader. Zero if the position is underwater.
    pub to_trader: u64,
    /// Kept by the pool (borrow plus any loss, capped at the margin).
    pub to_pool: u64,
    pub bad_debt: u64,
}

pub fn settle_close(pos: &PositionRisk, price: u64, index_now: u128) -> RiskResult<Close> {
    let e = equity(pos, price, index_now)?;
    if e <= 0 {
        return Ok(Close {
            to_trader: 0,
            to_pool: pos.margin,
            bad_debt: to_u64(e.unsigned_abs())?,
        });
    }
    let e_u = to_u64(e as u128)?;
    Ok(Close {
        to_trader: e_u,
        to_pool: pos.margin.saturating_sub(e_u.min(pos.margin)),
        bad_debt: 0,
    })
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const USDC: u64 = 1_000_000;

    fn params() -> RiskParams {
        RiskParams {
            phi: 500_000,
            delta_max: 300_000,
            mu: 300_000,
            delta_liq: 187_500,
            base_leverage: 5_000_000,
            maintenance_margin: 62_500,
            r0: 50,
            r1: 500,
            psi: 500_000,
            reduce_only_utilization: 950_000,
            liquidator_fee_bps: 100,
        }
    }

    fn open_gates() -> Gates {
        Gates {
            market_allows_open: true,
            oracle_tradeable: true,
        }
    }

    fn price(depth: u64) -> PriceInput {
        PriceInput {
            price: WAD as u64,
            depth,
        }
    }

    fn position(side: Side, notional: u64, lev: u64) -> PositionRisk {
        PositionRisk {
            side,
            notional,
            margin: notional / lev,
            entry_price: WAD as u64,
            borrow_idx_entry: RAY,
        }
    }

    // ---- capacity ----

    #[test]
    fn depth_ceiling_binds_long_before_solvency_does() {
        let c = capacity(140_000 * USDC, 60_000 * USDC, &params()).unwrap();
        assert_eq!(c.cap_solvency / USDC, 233_333);
        assert_eq!(c.cap_depth / USDC, 17_944);
        assert_eq!(c.cap, c.cap_depth);
        assert_eq!(c.binding, Binding::Depth);
    }

    #[test]
    fn solvency_binds_once_the_amm_is_deep() {
        let c = capacity(140_000 * USDC, 5_000_000 * USDC, &params()).unwrap();
        assert_eq!(c.cap, c.cap_solvency);
        assert_eq!(c.binding, Binding::Solvency);
    }

    #[test]
    fn capacity_scales_linearly_with_amm_depth() {
        let p = params();
        let a = capacity(140_000 * USDC, 25_000 * USDC, &p).unwrap().cap_depth;
        let b = capacity(140_000 * USDC, 50_000 * USDC, &p).unwrap().cap_depth;
        assert_eq!(b / a, 2);
    }

    // ---- opening ----

    #[test]
    fn a_sound_order_is_approved_with_the_oracle_price() {
        let mk = MarketRisk::new(0);
        let a = check_open(
            &mk,
            open_gates(),
            price(60_000 * USDC),
            140_000 * USDC,
            Side::Long,
            10_000 * USDC,
            2_000 * USDC,
            &params(),
        )
        .unwrap();
        assert_eq!(a.entry_price, WAD as u64);
        assert_eq!(a.borrow_idx_entry, RAY);
        assert_eq!(a.oi_after, 10_000 * USDC);
    }

    #[test]
    fn opening_past_the_depth_ceiling_is_refused() {
        let mk = MarketRisk::new(0);
        let e = check_open(
            &mk,
            open_gates(),
            price(60_000 * USDC),
            140_000 * USDC,
            Side::Long,
            20_000 * USDC,
            4_000 * USDC,
            &params(),
        )
        .unwrap_err();
        assert_eq!(e, RiskError::CapacityExceeded);
    }

    #[test]
    fn opening_past_the_solvency_ceiling_is_refused() {
        let mk = MarketRisk::new(0);
        // deep AMM, thin liquid sleeve: solvency is what bites
        let e = check_open(
            &mk,
            open_gates(),
            price(5_000_000 * USDC),
            1_000 * USDC,
            Side::Long,
            5_000 * USDC,
            1_000 * USDC,
            &params(),
        )
        .unwrap_err();
        assert_eq!(e, RiskError::CapacityExceeded);
    }

    #[test]
    fn one_unit_over_the_ceiling_is_still_refused() {
        let mk = MarketRisk::new(0);
        let p = params();
        let cap = capacity(140_000 * USDC, 60_000 * USDC, &p).unwrap().cap;
        // sit just under the reduce-only threshold to isolate the capacity check
        let n = cap * 90 / 100;
        assert!(check_open(&mk, open_gates(), price(60_000 * USDC), 140_000 * USDC, Side::Long, n, n, &p).is_ok());
        assert_eq!(
            check_open(&mk, open_gates(), price(60_000 * USDC), 140_000 * USDC, Side::Long, cap + 1, cap + 1, &p)
                .unwrap_err(),
            RiskError::CapacityExceeded
        );
    }

    #[test]
    fn insufficient_margin_is_refused() {
        let mk = MarketRisk::new(0);
        let p = params();
        let n = 1_000 * USDC;
        assert!(check_open(&mk, open_gates(), price(60_000 * USDC), 140_000 * USDC, Side::Long, n, 200 * USDC, &p).is_ok());
        assert_eq!(
            check_open(&mk, open_gates(), price(60_000 * USDC), 140_000 * USDC, Side::Long, n, 199 * USDC, &p)
                .unwrap_err(),
            RiskError::InsufficientMargin
        );
    }

    #[test]
    fn a_closed_market_refuses_before_anything_else_is_checked() {
        let mk = MarketRisk::new(0);
        let gates = Gates {
            market_allows_open: false,
            oracle_tradeable: true,
        };
        // notional is zero too, but state is reported first
        assert_eq!(
            check_open(&mk, gates, price(60_000 * USDC), 140_000 * USDC, Side::Long, 0, 0, &params())
                .unwrap_err(),
            RiskError::StateForbidsOpen
        );
    }

    #[test]
    fn an_unhealthy_oracle_refuses_opening() {
        let mk = MarketRisk::new(0);
        let gates = Gates {
            market_allows_open: true,
            oracle_tradeable: false,
        };
        assert_eq!(
            check_open(&mk, gates, price(60_000 * USDC), 140_000 * USDC, Side::Long, 1_000 * USDC, 500 * USDC, &params())
                .unwrap_err(),
            RiskError::OracleNotTradeable
        );
    }

    #[test]
    fn zero_notional_and_zero_price_are_refused() {
        let mk = MarketRisk::new(0);
        let p = params();
        assert_eq!(
            check_open(&mk, open_gates(), price(60_000 * USDC), 140_000 * USDC, Side::Long, 0, 0, &p).unwrap_err(),
            RiskError::ZeroNotional
        );
        let dead = PriceInput { price: 0, depth: 60_000 * USDC };
        assert_eq!(
            check_open(&mk, open_gates(), dead, 140_000 * USDC, Side::Long, 1_000 * USDC, 500 * USDC, &p).unwrap_err(),
            RiskError::OracleNotTradeable
        );
    }

    #[test]
    fn the_order_that_would_trip_reduce_only_is_refused() {
        let mk = MarketRisk::new(0);
        let p = params();
        let cap = capacity(140_000 * USDC, 60_000 * USDC, &p).unwrap().cap;
        let n = cap * 96 / 100; // under the cap, but over 95% utilization
        assert_eq!(
            check_open(&mk, open_gates(), price(60_000 * USDC), 140_000 * USDC, Side::Long, n, n, &p).unwrap_err(),
            RiskError::UtilizationTooHigh
        );
    }

    // ---- borrow ----

    #[test]
    fn borrow_grows_quadratically_with_utilization() {
        let p = params();
        let cap = 100_000 * USDC;
        let mut low = MarketRisk::new(0);
        low.oi_long = 10_000 * USDC;
        let mut high = MarketRisk::new(0);
        high.oi_long = 80_000 * USDC;
        let rl = borrow_rate(&low, Side::Long, cap, &p).unwrap();
        let rh = borrow_rate(&high, Side::Long, cap, &p).unwrap();
        assert!(rh > rl * 4);
    }

    #[test]
    fn the_crowded_side_pays_more() {
        let p = params();
        let cap = 100_000 * USDC;
        let mut mk = MarketRisk::new(0);
        mk.oi_long = 90_000 * USDC;
        mk.oi_short = 10_000 * USDC;
        assert!(
            borrow_rate(&mk, Side::Long, cap, &p).unwrap()
                > borrow_rate(&mk, Side::Short, cap, &p).unwrap()
        );
    }

    #[test]
    fn borrow_index_never_moves_backwards() {
        let p = params();
        let mut mk = MarketRisk::new(0);
        mk.oi_long = 50_000 * USDC;
        accrue(&mut mk, 3_600, 100_000 * USDC, &p).unwrap();
        let after = mk.borrow_idx_long;
        assert!(after > RAY);
        accrue(&mut mk, 0, 100_000 * USDC, &p).unwrap(); // clock going backwards
        assert_eq!(mk.borrow_idx_long, after);
    }

    // ---- position ----

    #[test]
    fn liquidation_price_is_known_at_open_time() {
        let p = params();
        let l = liquidation_price(&position(Side::Long, 1_000 * USDC, 5), RAY, &p).unwrap();
        let s = liquidation_price(&position(Side::Short, 1_000 * USDC, 5), RAY, &p).unwrap();
        assert_eq!(l, WAD as u64 - 137_500);
        assert_eq!(s, WAD as u64 + 137_500);
    }

    #[test]
    fn a_position_above_maintenance_is_not_liquidatable() {
        let p = params();
        let pos = position(Side::Long, 1_000 * USDC, 5);
        let l = liquidation_price(&pos, RAY, &p).unwrap();
        assert!(!is_liquidatable(&pos, l + 1_000, RAY, &p).unwrap());
        assert!(is_liquidatable(&pos, l - 1_000, RAY, &p).unwrap());
    }

    #[test]
    fn liquidation_pays_the_caller_then_the_pool_and_reconciles() {
        let p = params();
        let pos = position(Side::Long, 1_000 * USDC, 5);
        let price = (WAD * 85 / 100) as u64; // equity 200 - 150 = 50
        let r = settle_liquidation(&pos, price, RAY, &p).unwrap();
        assert_eq!(r.liquidator_fee, 10 * USDC);
        assert_eq!(r.to_pool, 40 * USDC);
        assert_eq!(r.bad_debt, 0);
        assert_eq!(r.liquidator_fee + r.to_pool, 50 * USDC);
    }

    #[test]
    fn a_gap_through_the_margin_is_recorded_as_bad_debt() {
        let p = params();
        let pos = position(Side::Long, 1_000 * USDC, 5);
        let price = (WAD * 70 / 100) as u64; // loss 300 against margin 200
        let r = settle_liquidation(&pos, price, RAY, &p).unwrap();
        assert_eq!(r.bad_debt, 100 * USDC);
        assert_eq!(r.liquidator_fee, 0);
        assert_eq!(r.to_pool, 0);
    }

    #[test]
    fn closing_in_profit_pays_the_trader_and_closing_underwater_does_not() {
        let pos = position(Side::Long, 1_000 * USDC, 5);
        let up = settle_close(&pos, (WAD * 110 / 100) as u64, RAY).unwrap();
        assert_eq!(up.to_trader, 300 * USDC); // 200 margin + 100 profit
        assert_eq!(up.bad_debt, 0);

        let down = settle_close(&pos, (WAD * 70 / 100) as u64, RAY).unwrap();
        assert_eq!(down.to_trader, 0);
        assert_eq!(down.to_pool, 200 * USDC);
        assert_eq!(down.bad_debt, 100 * USDC);
    }

    #[test]
    fn borrow_moves_liquidation_closer() {
        let p = params();
        let pos = position(Side::Long, 1_000 * USDC, 5);
        let clean = liquidation_price(&pos, RAY, &p).unwrap();
        let with_borrow = liquidation_price(&pos, RAY + RAY / 50, &p).unwrap();
        assert!(with_borrow > clean);
    }

    #[test]
    fn open_interest_accounting_is_symmetric() {
        let mut mk = MarketRisk::new(0);
        mk.add_oi(Side::Long, 1_000).unwrap();
        mk.add_oi(Side::Short, 400).unwrap();
        assert_eq!(mk.oi_total().unwrap(), 1_400);
        mk.remove_oi(Side::Long, 1_000);
        assert_eq!(mk.oi_long, 0);
        assert_eq!(mk.oi_total().unwrap(), 400);
    }

    #[test]
    fn the_full_hedge_from_the_spec_nets_to_zero() {
        let pos = position(Side::Short, 3_200 * USDC, 4);
        let after = (WAD * 80 / 100) as u64;
        let gain = pnl(&pos, after).unwrap();
        assert_eq!(gain, 640 * USDC as i128);
        assert_eq!(gain + -(640 * USDC as i128), 0);
    }
}
