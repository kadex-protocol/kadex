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
    accrue_borrow_index, apply_bps_ceil, borrow_owed as owed, borrow_rate_hourly,
    div_wad_floor, equity as eq, health_wad, liquidation_price as liq_price, min_margin,
    mul_wad_ceil, mul_wad_floor, oi_allowed, oi_cap_depth, oi_cap_solvency, pnl as raw_pnl,
    side_multiplier, to_u64, utilization, MathError, Side,
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
    /// An LP withdrawal would leave open interest above capacity.
    WithdrawBreachesCapacity,
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
    /// How many times attacking must cost what it pays, at the ceiling. WAD.
    ///
    /// Without this the depth ceiling leaves NO margin: `cap = cost / mu`
    /// means `cap * mu == cost`, so at the ceiling an attack breaks even
    /// exactly and rounding decides whether it is profitable. A factor of 2
    /// says moving the price must cost twice the cascade, which is the
    /// difference between an invariant and a coin flip.
    pub attack_safety: u64,
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
    /// Sum of `notional / entry_price` across open longs, in WAD.
    ///
    /// This exists so aggregate unrealized PnL is O(1). For one position,
    /// `notional * (p - e) / e == p * (notional / e) - notional`, so summing
    /// `notional / e` lets the whole side be marked with one multiply. Without
    /// it, NAV would have to iterate every position, which cannot be done
    /// on-chain — and a NAV that ignores open positions is simply wrong.
    pub units_long: u128,
    /// Same, for open shorts.
    pub units_short: u128,
    pub borrow_idx_long: u128,
    pub borrow_idx_short: u128,
    pub last_accrual_ts: i64,
}

impl MarketRisk {
    pub fn new(now: i64) -> Self {
        Self {
            oi_long: 0,
            oi_short: 0,
            units_long: 0,
            units_short: 0,
            borrow_idx_long: RAY,
            borrow_idx_short: RAY,
            last_accrual_ts: now,
        }
    }

    /// Aggregate unrealized PnL of every open position, signed, at `price`.
    ///
    /// Positive means traders are ahead, which means the pool is behind by the
    /// same amount.
    pub fn unrealized_pnl(&self, price: u64) -> RiskResult<i128> {
        let long_mark = mul_wad_floor(self.units_long, price as u128)?;
        let short_mark = mul_wad_floor(self.units_short, price as u128)?;
        let long = (long_mark as i128) - (self.oi_long as i128);
        let short = (self.oi_short as i128) - (short_mark as i128);
        long.checked_add(short).ok_or(RiskError::Math)
    }

    /// Units contributed by a position of `notional` entered at `entry_price`.
    pub fn units_of(notional: u64, entry_price: u64) -> RiskResult<u128> {
        if entry_price == 0 {
            return Err(RiskError::Math);
        }
        Ok(div_wad_floor(notional as u128, entry_price as u128)?)
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

    /// Record an opened position. Notional and units move together; letting
    /// them drift would corrupt every NAV afterwards.
    pub fn add_position(&mut self, side: Side, notional: u64, entry_price: u64) -> RiskResult<()> {
        let units = Self::units_of(notional, entry_price)?;
        match side {
            Side::Long => {
                self.oi_long = self.oi_long.checked_add(notional).ok_or(RiskError::Math)?;
                self.units_long = self.units_long.checked_add(units).ok_or(RiskError::Math)?;
            }
            Side::Short => {
                self.oi_short = self.oi_short.checked_add(notional).ok_or(RiskError::Math)?;
                self.units_short = self.units_short.checked_add(units).ok_or(RiskError::Math)?;
            }
        }
        Ok(())
    }

    /// Record a closed or liquidated position.
    pub fn remove_position(&mut self, side: Side, notional: u64, entry_price: u64) -> RiskResult<()> {
        let units = Self::units_of(notional, entry_price)?;
        match side {
            Side::Long => {
                self.oi_long = self.oi_long.saturating_sub(notional);
                self.units_long = self.units_long.saturating_sub(units);
            }
            Side::Short => {
                self.oi_short = self.oi_short.saturating_sub(notional);
                self.units_short = self.units_short.saturating_sub(units);
            }
        }
        Ok(())
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
/// - depth: `R * (sqrt(1 + delta_liq) - 1) / (mu * safety)` — moving the price
///   must cost `safety` times what the liquidation cascade pays
pub fn capacity(usdc_sleeve: u64, depth: u64, p: &RiskParams) -> RiskResult<Capacity> {
    let cap_solvency = oi_cap_solvency(usdc_sleeve, p.phi as u128, p.delta_max as u128)?;
    // Folding the safety factor into mu keeps the tested formula untouched:
    // a larger effective mu is exactly a smaller ceiling.
    let mu_effective = mul_wad_ceil(p.mu as u128, p.attack_safety as u128)?;
    let cap_depth = oi_cap_depth(depth, p.delta_liq as u128, mu_effective)?;
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

/// The gate on LP withdrawals.
///
/// Positions were admitted against a capacity computed from the USDC sleeve.
/// Letting LPs drain that sleeve afterwards un-admits them silently: the
/// winners would find nothing to be paid from. A withdrawal may take the
/// pool down to the capacity its open interest needs, and no further.
pub fn check_withdraw(
    oi_total: u64,
    usdc_sleeve_after: u64,
    depth: u64,
    p: &RiskParams,
) -> RiskResult<()> {
    if oi_total == 0 {
        return Ok(());
    }
    let cap = capacity(usdc_sleeve_after, depth, p)?;
    if oi_total > cap.cap_solvency {
        return Err(RiskError::WithdrawBreachesCapacity);
    }
    Ok(())
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
            attack_safety: 2_000_000, // 2x
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
        assert_eq!(c.cap_depth / USDC, 8_972, "halved by the 2x attack safety factor");
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
    fn attacking_at_the_ceiling_costs_more_than_it_pays() {
        // The property the depth ceiling exists for. Before the safety factor
        // this held only with equality, which is not a margin at all.
        let p = params();
        for depth in [25_000, 60_000, 250_000, 1_000_000] {
            let depth = depth * USDC;
            let c = capacity(140_000 * USDC, depth, &p).unwrap();
            let cost = slab_math::cost_to_move_price(depth, p.delta_liq as u128).unwrap();
            let gain = mul_wad_floor(c.cap_depth as u128, p.mu as u128).unwrap() as u64;
            assert!(
                cost >= gain * 2 - 2,
                "at {depth} depth: attack costs {cost}, pays {gain} - margin gone"
            );
        }
    }

    #[test]
    fn a_bigger_safety_factor_means_a_smaller_market() {
        let mut p = params();
        let base = capacity(140_000 * USDC, 60_000 * USDC, &p).unwrap().cap_depth;
        p.attack_safety = 4_000_000; // 4x
        let tighter = capacity(140_000 * USDC, 60_000 * USDC, &p).unwrap().cap_depth;
        assert!(tighter < base);
        assert_eq!(base / tighter, 2, "doubling the factor should halve the ceiling");
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
            5_000 * USDC,
            1_000 * USDC,
            &params(),
        )
        .unwrap();
        assert_eq!(a.entry_price, WAD as u64);
        assert_eq!(a.borrow_idx_entry, RAY);
        assert_eq!(a.oi_after, 5_000 * USDC);
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
    fn withdrawals_stop_at_the_capacity_open_interest_needs() {
        let p = params();
        // sleeve 140k -> solvency cap 233,333
        assert!(check_withdraw(200_000 * USDC, 140_000 * USDC, 60_000 * USDC, &p).is_ok());
        // sleeve 100k -> 166,666 < 200k open
        assert_eq!(
            check_withdraw(200_000 * USDC, 100_000 * USDC, 60_000 * USDC, &p),
            Err(RiskError::WithdrawBreachesCapacity)
        );
        // no open interest: anything goes
        assert!(check_withdraw(0, 0, 0, &p).is_ok());
    }

    #[test]
    fn a_shallow_amm_does_not_trap_lps() {
        // Depth is about manipulation, not about who pays winners. Thin AMM
        // liquidity must not freeze LP money that the solvency ceiling clears.
        let p = params();
        assert!(check_withdraw(10_000 * USDC, 140_000 * USDC, 0, &p).is_ok());
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
        let par = WAD as u64;
        mk.add_position(Side::Long, 1_000, par).unwrap();
        mk.add_position(Side::Short, 400, par).unwrap();
        assert_eq!(mk.oi_total().unwrap(), 1_400);
        mk.remove_position(Side::Long, 1_000, par).unwrap();
        assert_eq!(mk.oi_long, 0);
        assert_eq!(mk.units_long, 0, "units must unwind with notional");
        assert_eq!(mk.oi_total().unwrap(), 400);
    }

    #[test]
    fn aggregate_unrealized_pnl_matches_summing_positions_one_by_one() {
        // The whole reason units exist: this has to be exact, because NAV
        // depends on it and NAV cannot iterate positions on-chain.
        let par = WAD as u64;
        let mut mk = MarketRisk::new(0);
        let entries = [(Side::Long, 1_000 * USDC, par), (Side::Long, 500 * USDC, par * 2),
                       (Side::Short, 800 * USDC, par), (Side::Short, 300 * USDC, par / 2)];
        for (side, notional, entry) in entries {
            mk.add_position(side, notional, entry).unwrap();
        }

        let price = par * 3 / 2;
        let aggregate = mk.unrealized_pnl(price).unwrap();
        let summed: i128 = entries
            .iter()
            .map(|(side, notional, entry)| {
                pnl(&PositionRisk { side: *side, notional: *notional, margin: 0,
                                    entry_price: *entry, borrow_idx_entry: RAY }, price).unwrap()
            })
            .sum();

        // rounding can differ by at most one unit per position
        assert!((aggregate - summed).abs() <= entries.len() as i128,
                "aggregate {aggregate} vs summed {summed}");
    }

    #[test]
    fn an_empty_market_has_no_unrealized_pnl() {
        let mk = MarketRisk::new(0);
        assert_eq!(mk.unrealized_pnl(WAD as u64).unwrap(), 0);
        assert_eq!(mk.unrealized_pnl(WAD as u64 * 3).unwrap(), 0);
    }

    #[test]
    fn a_balanced_book_nets_to_zero_at_any_price() {
        let par = WAD as u64;
        let mut mk = MarketRisk::new(0);
        mk.add_position(Side::Long, 1_000 * USDC, par).unwrap();
        mk.add_position(Side::Short, 1_000 * USDC, par).unwrap();
        for p in [par / 2, par, par * 2, par * 7] {
            assert_eq!(mk.unrealized_pnl(p).unwrap(), 0, "at price {p}");
        }
    }

    #[test]
    fn trader_gains_show_up_as_a_positive_aggregate() {
        let par = WAD as u64;
        let mut mk = MarketRisk::new(0);
        mk.add_position(Side::Long, 1_000 * USDC, par).unwrap();
        assert_eq!(mk.unrealized_pnl(par * 12 / 10).unwrap(), 200 * USDC as i128);
        assert_eq!(mk.unrealized_pnl(par * 8 / 10).unwrap(), -(200 * USDC as i128));
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
