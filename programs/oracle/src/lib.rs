//! Program `oracle` — OWNER: Backend A.
//!
//! Reads the reserves of an external fraction/USDC AMM pool, computes a TWAP,
//! applies a per-tick clamp, checks depth and divergence, and publishes a
//! single price the rest of the protocol consumes.
//!
//! What this program deliberately does NOT do:
//!
//! - it signs nothing with an off-chain key: `refresh_price` is permissionless
//!   and recomputes from on-chain state, so there is no "oracle key" to steal
//! - it does not use external fills as a price source: they enter only as a
//!   sanity bound (`external_median`), as the spec requires
//!
//! The account it publishes (`slab_interface::OracleAccount`) is the FROZEN
//! INTERFACE with Backend B.

use anchor_lang::prelude::*;
use slab_interface::{
    m, require_deployer, seeds, AmmAdapter, Observation, OracleAccount, OracleParams, OracleState,
    ORACLE_OBSERVATIONS,
};
use slab_math::{div_wad_floor, mul_wad_floor, WAD};

declare_id!("5288ShBXsFxqXiGm22FZi1ZrMnmet4i1ZR3bccyAguqp");

pub mod adapter;
pub mod errors;

use errors::OracleError;

#[program]
pub mod oracle {
    use super::*;

    /// Create a basket's oracle. Upgrade authority only, once per basket.
    pub fn initialize(
        ctx: Context<Initialize>,
        adapter: AmmAdapter,
        params: OracleParams,
    ) -> Result<()> {
        require_deployer(
            &ctx.accounts.program.to_account_info(),
            ctx.accounts.program_data.as_ref().map(|a| a.as_ref()),
            &crate::ID,
            &ctx.accounts.admin.key(),
        )?;
        validate_params(&params)?;
        let o = &mut ctx.accounts.oracle;
        o.basket = ctx.accounts.basket.key();
        o.amm_pool = ctx.accounts.amm_pool.key();
        o.adapter = adapter;
        o.admin = ctx.accounts.admin.key();
        o.price = 0;
        o.twap = 0;
        o.spot = 0;
        o.cumulative = 0;
        o.slow_twap = 0;
        o.depth_usdc = 0;
        o.last_update_ts = 0;
        o.last_update_slot = 0;
        o.external_median = 0;
        o.external_ts = 0;
        o.params = params;
        o.state = OracleState::Uninitialized;
        o.observations = [Observation::default(); ORACLE_OBSERVATIONS];
        o.obs_head = 0;
        o.obs_len = 0;
        o.bump = ctx.bumps.oracle;
        Ok(())
    }

    /// Read the AMM and republish the price. PERMISSIONLESS: anyone may call
    /// it, which is exactly why there is no privileged oracle key here — and
    /// exactly why nothing in it may get cheaper by calling it more often.
    ///
    /// Order of defences (each blocks a different attack):
    ///
    /// 1. one update per slot -> a second call in the same slot is a no-op
    /// 2. time-weighted TWAP -> a pushed spot counts only for the seconds it stays
    /// 3. clamp scaled by elapsed time -> the price cannot outrun the clock
    /// 4. minimum depth over the window -> liquidity must stay to count
    /// 5. divergence against the external median -> blocks sustained manipulation
    pub fn refresh_price(ctx: Context<RefreshPrice>) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let o = &mut ctx.accounts.oracle;

        // Idempotent within a slot, and SUCCESSFUL, so a trader can always
        // prepend a refresh without racing the keeper.
        if o.last_update_ts != 0 && o.last_update_slot == clock.slot {
            return Ok(());
        }

        let reserves = adapter::read_reserves(o.adapter, &ctx.accounts.amm_pool)?;
        require!(reserves.fraction > 0, OracleError::EmptyPool);
        let spot_u128 = m(div_wad_floor(
            reserves.usdc as u128,
            reserves.fraction as u128,
        ))?;
        let spot = u64::try_from(spot_u128).map_err(|_| error!(OracleError::PriceOverflow))?;
        require!(spot > 0, OracleError::EmptyPool);

        let first = o.last_update_ts == 0;
        let elapsed = if first { 0 } else { now.saturating_sub(o.last_update_ts).max(0) };

        // The PREVIOUS spot was in force for `elapsed` seconds; the new one
        // has not been in force at all yet.
        o.cumulative = advance_cumulative(o.cumulative, o.spot, elapsed)?;
        o.spot = spot;
        record_checkpoint(o, now, reserves.usdc);

        let twap = if first { spot } else { compute_twap(o, now)?.unwrap_or(o.price) };
        o.twap = twap;
        o.depth_usdc = window_min_depth(o, now, reserves.usdc);

        let previous = o.price;
        o.price = if previous == 0 {
            twap // first publication: nothing to defend against yet
        } else {
            let allowed = allowed_move(o.params.max_tick_move, elapsed, o.params.clamp_period_secs)?;
            clamp_move(previous, twap, allowed)?
        };

        o.slow_twap = advance_slow(
            o.slow_twap,
            o.price,
            allowed_move(o.params.slow_alpha, elapsed, o.params.clamp_period_secs)?,
        )?;

        o.last_update_ts = now;
        o.last_update_slot = clock.slot;
        o.state = evaluate_state(o, now)?;

        emit!(PriceRefreshed {
            oracle: o.key(),
            spot,
            twap,
            price: o.price,
            depth_usdc: o.depth_usdc,
            state: o.state,
            ts: now,
        });
        Ok(())
    }

    /// Publish the median of external fills, which is only the sanity bound.
    ///
    /// If this feed fails, the market loses ONE defence and keeps working off
    /// the AMM price. It never becomes a price source.
    pub fn set_external_median(ctx: Context<SetExternal>, median: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let o = &mut ctx.accounts.oracle;
        o.external_median = median;
        o.external_ts = now;
        o.state = evaluate_state(o, now)?;
        Ok(())
    }

    /// Change the oracle's risk parameters. Admin only.
    pub fn set_params(ctx: Context<SetParams>, params: OracleParams) -> Result<()> {
        validate_params(&params)?;
        ctx.accounts.oracle.params = params;
        Ok(())
    }
}

/// The same checks at creation and on every change.
pub fn validate_params(p: &OracleParams) -> Result<()> {
    require!(p.twap_window_secs > 0, OracleError::BadParams);
    require!(p.max_tick_move > 0 && p.max_tick_move <= WAD as u64, OracleError::BadParams);
    require!(p.max_staleness_secs > 0, OracleError::BadParams);
    require!(p.slow_alpha > 0 && p.slow_alpha <= WAD as u64, OracleError::BadParams);
    require!(p.clamp_period_secs > 0, OracleError::BadParams);
    require!(p.min_pool_depth > 0, OracleError::BadParams);
    Ok(())
}

// ---------------------------------------------------------------------------
// pure logic — testable without a validator
// ---------------------------------------------------------------------------

/// `cumulative + spot * elapsed`.
pub fn advance_cumulative(cumulative: u128, spot: u64, elapsed: i64) -> Result<u128> {
    let add = (spot as u128)
        .checked_mul(elapsed.max(0) as u128)
        .ok_or(error!(OracleError::PriceOverflow))?;
    cumulative.checked_add(add).ok_or(error!(OracleError::PriceOverflow))
}

/// Minimum spacing between checkpoints, so 32 of them always span a window.
pub fn checkpoint_spacing(window_secs: u32) -> i64 {
    ((window_secs as i64) / (ORACLE_OBSERVATIONS as i64 - 1)).max(1)
}

fn newest_index(o: &OracleAccount) -> Option<usize> {
    if o.obs_len == 0 {
        return None;
    }
    Some((o.obs_head as usize + ORACLE_OBSERVATIONS - 1) % ORACLE_OBSERVATIONS)
}

/// Checkpoints from oldest to newest.
fn ordered(o: &OracleAccount) -> impl Iterator<Item = Observation> + '_ {
    let len = o.obs_len as usize;
    let start = if len < ORACLE_OBSERVATIONS { 0 } else { o.obs_head as usize };
    (0..len).map(move |k| o.observations[(start + k) % ORACLE_OBSERVATIONS])
}

/// Write a new checkpoint if the newest is old enough; otherwise fold this
/// reading's depth into the newest one's minimum.
///
/// Refreshing every slot therefore cannot shorten the history: checkpoints
/// stay `window / 31` apart however often anyone calls.
pub fn record_checkpoint(o: &mut OracleAccount, now: i64, depth: u64) {
    let spacing = checkpoint_spacing(o.params.twap_window_secs);
    if let Some(i) = newest_index(o) {
        let newest = o.observations[i];
        if now.saturating_sub(newest.ts) < spacing {
            o.observations[i].depth = newest.depth.min(depth);
            return;
        }
    }
    let head = o.obs_head as usize % ORACLE_OBSERVATIONS;
    o.observations[head] = Observation { ts: now, cumulative: o.cumulative, depth };
    o.obs_head = ((head + 1) % ORACLE_OBSERVATIONS) as u8;
    if (o.obs_len as usize) < ORACLE_OBSERVATIONS {
        o.obs_len += 1;
    }
}

/// The checkpoint the TWAP measures from: the newest one at least a window
/// old, or the oldest one there is while history is shorter than a window.
fn window_start(o: &OracleAccount, now: i64) -> Option<Observation> {
    let edge = now.saturating_sub(o.params.twap_window_secs as i64);
    let mut chosen: Option<Observation> = None;
    for obs in ordered(o) {
        match chosen {
            None => chosen = Some(obs),
            Some(_) if obs.ts <= edge => chosen = Some(obs),
            _ => break,
        }
    }
    chosen
}

/// Time-weighted average spot over the window.
///
/// `None` when no time has passed since the window's start — there is no
/// average of zero seconds, and the caller keeps the price it had.
pub fn compute_twap(o: &OracleAccount, now: i64) -> Result<Option<u64>> {
    let start = window_start(o, now).ok_or(error!(OracleError::NoObservations))?;
    let span = now.saturating_sub(start.ts);
    if span <= 0 {
        return Ok(None);
    }
    let delta = o
        .cumulative
        .checked_sub(start.cumulative)
        .ok_or(error!(OracleError::PriceOverflow))?;
    let avg = delta / span as u128;
    u64::try_from(avg).map(Some).map_err(|_| error!(OracleError::PriceOverflow))
}

/// Lowest depth over the window, including the reading just taken.
pub fn window_min_depth(o: &OracleAccount, now: i64, current: u64) -> u64 {
    let from = window_start(o, now).map(|w| w.ts).unwrap_or(now);
    ordered(o)
        .filter(|obs| obs.ts >= from)
        .map(|obs| obs.depth)
        .fold(current, u64::min)
}

/// How far the price may move after `elapsed` seconds: `rate` per `period`,
/// capped at one full `rate` however long the gap.
pub fn allowed_move(rate_wad: u64, elapsed: i64, period_secs: u32) -> Result<u64> {
    let period = period_secs.max(1) as u128;
    let secs = (elapsed.max(0) as u128).min(period);
    let v = m(slab_math::mul_div_floor(rate_wad as u128, secs, period))?;
    u64::try_from(v).map_err(|_| error!(OracleError::PriceOverflow))
}

/// Limit the published price's movement to `max_move_wad`.
pub fn clamp_move(previous: u64, target: u64, max_move_wad: u64) -> Result<u64> {
    let delta = m(mul_wad_floor(previous as u128, max_move_wad as u128))?;
    let hi = (previous as u128).saturating_add(delta);
    let lo = (previous as u128).saturating_sub(delta);
    let clamped = (target as u128).clamp(lo, hi);
    u64::try_from(clamped).map_err(|_| error!(OracleError::PriceOverflow))
}

/// Advance the sluggish EMA: `slow += (price - slow) * alpha`.
///
/// Seeded on the first call rather than crawling up from zero, which would
/// mark the whole card sleeve at nothing for the first hour.
pub fn advance_slow(slow: u64, price: u64, alpha_wad: u64) -> Result<u64> {
    if slow == 0 {
        return Ok(price);
    }
    let delta = if price >= slow {
        let step = m(mul_wad_floor((price - slow) as u128, alpha_wad as u128))?;
        (slow as u128).saturating_add(step)
    } else {
        let step = m(mul_wad_floor((slow - price) as u128, alpha_wad as u128))?;
        (slow as u128).saturating_sub(step)
    };
    u64::try_from(delta).map_err(|_| error!(OracleError::PriceOverflow))
}

/// Decide the oracle's state from the defences.
pub fn evaluate_state(o: &OracleAccount, now: i64) -> Result<OracleState> {
    if o.price == 0 || o.last_update_ts == 0 {
        return Ok(OracleState::Uninitialized);
    }
    if now.saturating_sub(o.last_update_ts) > o.params.max_staleness_secs as i64 {
        return Ok(OracleState::Stale);
    }
    if o.depth_usdc < o.params.min_pool_depth {
        return Ok(OracleState::ShallowDepth);
    }
    // Divergence only applies when a recent external median exists. Without
    // one the market runs with one defence fewer, not halted.
    if o.external_median > 0
        && now.saturating_sub(o.external_ts) <= o.params.max_staleness_secs as i64
    {
        let (hi, lo) = if o.price >= o.external_median {
            (o.price, o.external_median)
        } else {
            (o.external_median, o.price)
        };
        let div = m(div_wad_floor((hi - lo) as u128, o.external_median as u128))?;
        if div > o.params.max_divergence as u128 {
            return Ok(OracleState::Diverged);
        }
    }
    // The clamp is binding: the published price is known to be behind.
    if o.price != o.twap {
        return Ok(OracleState::CatchingUp);
    }
    Ok(OracleState::Ok)
}

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// Must be this program's upgrade authority.
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: this program's own account; its loader header names the
    /// upgrade authority. Address-checked.
    #[account(address = crate::ID)]
    pub program: UncheckedAccount<'info>,
    /// CHECK: v3-loader program data. Verified against `program` in
    /// `require_deployer`; absent under loader v4.
    pub program_data: Option<UncheckedAccount<'info>>,
    /// CHECK: basket identifier; used only as a seed and a label.
    pub basket: UncheckedAccount<'info>,
    /// CHECK: external AMM pool. Validated by the adapter in `refresh_price`.
    pub amm_pool: UncheckedAccount<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + OracleAccount::INIT_SPACE,
        seeds = [seeds::ORACLE, basket.key().as_ref()],
        bump
    )]
    pub oracle: Account<'info, OracleAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefreshPrice<'info> {
    /// Permissionless by design: any keeper will do, and if ours goes down
    /// someone else keeps the price alive.
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [seeds::ORACLE, oracle.basket.as_ref()],
        bump = oracle.bump,
        has_one = amm_pool @ OracleError::WrongAmmPool,
    )]
    pub oracle: Account<'info, OracleAccount>,
    /// CHECK: deserialized by the adapter selected by `oracle.adapter`.
    pub amm_pool: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SetExternal<'info> {
    #[account(address = oracle.admin @ OracleError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [seeds::ORACLE, oracle.basket.as_ref()],
        bump = oracle.bump,
    )]
    pub oracle: Account<'info, OracleAccount>,
}

#[derive(Accounts)]
pub struct SetParams<'info> {
    #[account(address = oracle.admin @ OracleError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [seeds::ORACLE, oracle.basket.as_ref()],
        bump = oracle.bump,
    )]
    pub oracle: Account<'info, OracleAccount>,
}

#[event]
pub struct PriceRefreshed {
    pub oracle: Pubkey,
    pub spot: u64,
    pub twap: u64,
    pub price: u64,
    pub depth_usdc: u64,
    pub state: OracleState,
    pub ts: i64,
}

// ---------------------------------------------------------------------------
// pure-logic tests (no validator, run under `cargo test`)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const PAR: u64 = WAD as u64;

    fn fresh() -> OracleAccount {
        OracleAccount {
            basket: Pubkey::default(),
            amm_pool: Pubkey::default(),
            adapter: AmmAdapter::Mock,
            admin: Pubkey::default(),
            price: 0,
            twap: 0,
            spot: 0,
            cumulative: 0,
            slow_twap: 0,
            depth_usdc: 0,
            last_update_ts: 0,
            last_update_slot: 0,
            external_median: 0,
            external_ts: 0,
            params: OracleParams::default(),
            state: OracleState::Uninitialized,
            observations: [Observation::default(); ORACLE_OBSERVATIONS],
            obs_head: 0,
            obs_len: 0,
            bump: 255,
        }
    }

    /// `refresh_price` minus the account plumbing, so the defences can be
    /// exercised call by call with a controlled clock and slot.
    fn refresh(o: &mut OracleAccount, now: i64, slot: u64, spot: u64, depth: u64) {
        if o.last_update_ts != 0 && o.last_update_slot == slot {
            return;
        }
        let first = o.last_update_ts == 0;
        let elapsed = if first { 0 } else { (now - o.last_update_ts).max(0) };
        o.cumulative = advance_cumulative(o.cumulative, o.spot, elapsed).unwrap();
        o.spot = spot;
        record_checkpoint(o, now, depth);
        let twap = if first { spot } else { compute_twap(o, now).unwrap().unwrap_or(o.price) };
        o.twap = twap;
        o.depth_usdc = window_min_depth(o, now, depth);
        let prev = o.price;
        o.price = if prev == 0 {
            twap
        } else {
            let a = allowed_move(o.params.max_tick_move, elapsed, o.params.clamp_period_secs).unwrap();
            clamp_move(prev, twap, a).unwrap()
        };
        let a = allowed_move(o.params.slow_alpha, elapsed, o.params.clamp_period_secs).unwrap();
        o.slow_twap = advance_slow(o.slow_twap, o.price, a).unwrap();
        o.last_update_ts = now;
        o.last_update_slot = slot;
        o.state = evaluate_state(o, now).unwrap();
    }

    const DEPTH: u64 = 60_000_000_000;

    /// A market that has been quiet at $1 for a full window, keeper every 5s.
    fn settled() -> (OracleAccount, i64, u64) {
        let mut o = fresh();
        let (mut now, mut slot) = (1_000_000i64, 1u64);
        for _ in 0..400 {
            refresh(&mut o, now, slot, PAR, DEPTH);
            now += 5;
            slot += 12;
        }
        (o, now, slot)
    }

    #[test]
    fn many_refreshes_in_one_slot_move_nothing() {
        // The exploit this replaces: twelve refreshes in one transaction moved
        // the price 79.6% against a 5% clamp, on a local validator.
        let (mut o, now, slot) = settled();
        let before = o.price;
        for _ in 0..100 {
            refresh(&mut o, now, slot, PAR * 3, DEPTH);
        }
        // Only the first call in the slot did anything, and the pushed spot
        // has been in force for zero seconds, so it is worth zero.
        assert_eq!(o.price, before);
        assert_eq!(o.slow_twap, PAR);
    }

    #[test]
    fn many_refreshes_in_one_second_move_nothing() {
        // Consecutive slots inside the same second: different slots, but no
        // time has passed, so the clamp allows no movement at all.
        let (mut o, now, slot) = settled();
        let before = o.price;
        for k in 0..30 {
            refresh(&mut o, now, slot + k, PAR * 3, DEPTH);
        }
        assert_eq!(o.price, before);
    }

    #[test]
    fn the_clamp_follows_the_clock_not_the_caller() {
        // Tighten the window so the TWAP would happily run ahead, then refresh
        // in every slot for fifteen seconds: one full step, no more.
        let (mut o, now, slot) = settled();
        o.params.twap_window_secs = 10;
        let start = o.price;
        for k in 0..(15 * 25) {
            refresh(&mut o, now + k / 25, slot + k as u64, PAR * 3, DEPTH);
        }
        refresh(&mut o, now + 15, slot + 10_000, PAR * 3, DEPTH);
        let moved = (o.price - start) as u128 * WAD / start as u128;
        // Fifteen one-second steps of 5%/15 compound to 5.12%, not 5%.
        assert!(moved <= 51_200, "moved {moved} in 15s");
        assert!(moved > 0, "the price should still be able to move");
    }

    #[test]
    fn a_push_held_for_one_transaction_is_worth_almost_nothing() {
        let (mut o, now, slot) = settled();
        // push, refresh, release, refresh one slot later in the same second
        refresh(&mut o, now, slot, PAR * 3, DEPTH);
        refresh(&mut o, now, slot + 1, PAR, DEPTH);
        // keeper, five seconds on
        refresh(&mut o, now + 5, slot + 13, PAR, DEPTH);
        assert_eq!(o.twap, PAR, "a zero-second push leaked into the TWAP");
    }

    #[test]
    fn twap_weights_each_price_by_how_long_it_held() {
        let mut o = fresh();
        o.params.twap_window_secs = 100;
        refresh(&mut o, 1_000, 1, PAR, DEPTH);
        refresh(&mut o, 1_075, 2, 2 * PAR, DEPTH); // $1 held for 75s
        refresh(&mut o, 1_100, 3, 2 * PAR, DEPTH); // $2 held for 25s
        assert_eq!(o.twap, PAR + PAR / 4);
    }

    #[test]
    fn spamming_refresh_cannot_shorten_the_history() {
        let mut o = fresh();
        for k in 0..1_000u64 {
            refresh(&mut o, 1_000 + k as i64, k + 1, PAR, DEPTH);
        }
        let spacing = checkpoint_spacing(o.params.twap_window_secs);
        let ts: Vec<i64> = ordered(&o).map(|x| x.ts).collect();
        assert!(ts.windows(2).all(|w| w[1] - w[0] >= spacing));
    }

    #[test]
    fn liquidity_added_for_a_moment_buys_no_depth() {
        let (mut o, now, slot) = settled();
        refresh(&mut o, now, slot, PAR, DEPTH * 10);
        assert_eq!(o.depth_usdc, DEPTH, "depth jumped on liquidity that just arrived");
    }

    #[test]
    fn liquidity_pulled_counts_immediately() {
        let (mut o, now, slot) = settled();
        refresh(&mut o, now, slot, PAR, DEPTH / 10);
        assert_eq!(o.depth_usdc, DEPTH / 10);
        assert_eq!(o.state, OracleState::ShallowDepth);
    }

    #[test]
    fn a_binding_clamp_stops_new_risk() {
        // Keepers miss ten minutes while the market doubles. The TWAP has
        // moved about a third; the clamp allows one step. The published price
        // is known to be behind, so nothing new may open at it.
        let (mut o, now, slot) = settled();
        refresh(&mut o, now, slot, PAR * 2, DEPTH);
        refresh(&mut o, now + 600, slot + 1_500, PAR * 2, DEPTH);
        assert!(o.twap > o.price);
        assert_eq!(o.state, OracleState::CatchingUp);
        assert!(!o.state.is_tradeable());
    }

    #[test]
    fn clamp_blocks_a_jump() {
        let prev = PAR;
        assert_eq!(clamp_move(prev, prev * 3 / 2, 50_000).unwrap(), 1_050_000);
        assert_eq!(clamp_move(prev, prev / 2, 50_000).unwrap(), 950_000);
        assert_eq!(clamp_move(prev, 1_010_000, 50_000).unwrap(), 1_010_000);
    }

    #[test]
    fn allowed_move_scales_with_time_and_caps_at_one_step() {
        assert_eq!(allowed_move(50_000, 0, 15).unwrap(), 0);
        assert_eq!(allowed_move(50_000, 3, 15).unwrap(), 10_000);
        assert_eq!(allowed_move(50_000, 15, 15).unwrap(), 50_000);
        assert_eq!(allowed_move(50_000, 3_600, 15).unwrap(), 50_000);
    }

    #[test]
    fn shallow_depth_forces_reduce_only() {
        let mut o = fresh();
        o.price = PAR;
        o.twap = PAR;
        o.last_update_ts = 1_000;
        o.depth_usdc = o.params.min_pool_depth - 1;
        assert_eq!(evaluate_state(&o, 1_010).unwrap(), OracleState::ShallowDepth);
        o.depth_usdc = o.params.min_pool_depth;
        assert_eq!(evaluate_state(&o, 1_010).unwrap(), OracleState::Ok);
    }

    #[test]
    fn stale_oracle_is_detected() {
        let mut o = fresh();
        o.price = PAR;
        o.last_update_ts = 1_000;
        let late = 1_000 + o.params.max_staleness_secs as i64 + 1;
        assert_eq!(evaluate_state(&o, late).unwrap(), OracleState::Stale);
    }

    #[test]
    fn divergence_from_external_median_trips_the_sanity_bound() {
        let mut o = fresh();
        o.price = PAR;
        o.twap = PAR;
        o.depth_usdc = DEPTH;
        o.last_update_ts = 1_000;
        o.external_ts = 1_000;
        o.external_median = 909_091;
        assert_eq!(evaluate_state(&o, 1_010).unwrap(), OracleState::Ok);
        o.external_median = 800_000;
        assert_eq!(evaluate_state(&o, 1_010).unwrap(), OracleState::Diverged);
    }

    #[test]
    fn missing_external_feed_degrades_instead_of_halting() {
        let mut o = fresh();
        o.price = PAR;
        o.twap = PAR;
        o.depth_usdc = DEPTH;
        o.last_update_ts = 1_000;
        assert_eq!(evaluate_state(&o, 1_010).unwrap(), OracleState::Ok);
    }

    #[test]
    fn the_slow_mark_seeds_then_crawls() {
        let alpha = 10_000;
        assert_eq!(advance_slow(0, PAR, alpha).unwrap(), PAR);
        assert_eq!(advance_slow(PAR, 2 * PAR, alpha).unwrap(), PAR + 10_000);
    }

    #[test]
    fn the_slow_mark_follows_time_not_calls() {
        // ~50 minutes to cover most of a step at the default alpha, whether
        // the keeper runs every 5s or every 15s.
        for step in [5i64, 15] {
            let (mut o, mut now, mut slot) = settled();
            let target = 2 * PAR;
            let mut t = 0;
            // hold the spot so the fast price converges, then watch slow
            while o.slow_twap < PAR + PAR / 2 && t < 20_000 {
                refresh(&mut o, now, slot, target, DEPTH);
                now += step;
                slot += 40;
                t += step;
            }
            assert!(t > 1_200, "slow mark covered half a doubling in {t}s at {step}s refresh");
        }
    }

    #[test]
    fn the_slow_mark_falls_as_slowly_as_it_rises() {
        let alpha = 10_000;
        let up = advance_slow(PAR, 2 * PAR, alpha).unwrap() - PAR;
        let down = PAR - advance_slow(PAR, 0, alpha).unwrap();
        assert_eq!(up, down);
    }

    #[test]
    fn uninitialized_until_the_first_price() {
        assert_eq!(evaluate_state(&fresh(), 1).unwrap(), OracleState::Uninitialized);
    }

    #[test]
    fn params_are_validated_at_creation_too() {
        assert!(validate_params(&OracleParams::default()).is_ok());
        let mut p = OracleParams::default();
        p.max_tick_move = 0;
        assert!(validate_params(&p).is_err(), "a zero clamp freezes the price forever");
        let mut p = OracleParams::default();
        p.clamp_period_secs = 0;
        assert!(validate_params(&p).is_err());
    }
}
