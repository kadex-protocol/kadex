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
    m, seeds, AmmAdapter, Observation, OracleAccount, OracleParams, OracleState,
    ORACLE_OBSERVATIONS,
};
use slab_math::{div_wad_floor, mul_wad_floor};

declare_id!("5288ShBXsFxqXiGm22FZi1ZrMnmet4i1ZR3bccyAguqp");

pub mod adapter;
pub mod errors;

use errors::OracleError;

#[program]
pub mod oracle {
    use super::*;

    /// Create a basket's oracle. Admin only, once.
    pub fn initialize(
        ctx: Context<Initialize>,
        adapter: AmmAdapter,
        params: OracleParams,
    ) -> Result<()> {
        let o = &mut ctx.accounts.oracle;
        o.basket = ctx.accounts.basket.key();
        o.amm_pool = ctx.accounts.amm_pool.key();
        o.adapter = adapter;
        o.admin = ctx.accounts.admin.key();
        o.price = 0;
        o.twap = 0;
        o.spot = 0;
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
    /// it, which is exactly why there is no privileged oracle key here.
    ///
    /// Order of defences (each blocks a different attack):
    ///
    /// 1. read reserves -> spot
    /// 2. record observation -> window TWAP
    /// 3. per-tick clamp against the previous price -> blocks a single-block jump
    /// 4. minimum depth -> blocks pulling liquidity to make the oracle cheap
    /// 5. divergence against the external median -> blocks sustained manipulation
    pub fn refresh_price(ctx: Context<RefreshPrice>) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let reserves =
            adapter::read_reserves(ctx.accounts.oracle.adapter, &ctx.accounts.amm_pool)?;
        require!(reserves.fraction > 0, OracleError::EmptyPool);

        let spot_u128 = m(div_wad_floor(
            reserves.usdc as u128,
            reserves.fraction as u128,
        ))?;
        let spot = u64::try_from(spot_u128).map_err(|_| error!(OracleError::PriceOverflow))?;
        require!(spot > 0, OracleError::EmptyPool);

        let o = &mut ctx.accounts.oracle;
        o.spot = spot;
        o.depth_usdc = reserves.usdc;

        // ---- observation + TWAP ----
        push_observation(o, spot, now);
        let twap = compute_twap(o, now)?;
        o.twap = twap;

        // ---- clamp por tick ----
        // The official price never moves more than `max_tick_move` per update.
        // This does not prevent slow manipulation; it makes it expensive and
        // kills the instantaneous, profitable version of it.
        let previous = o.price;
        o.price = if previous == 0 {
            twap // first publication: nothing to defend against yet
        } else {
            clamp_move(previous, twap, o.params.max_tick_move)?
        };

        // The sluggish mark used for collateral. Updated after the clamp, so
        // it trails an already-smoothed price rather than the raw spot.
        o.slow_twap = advance_slow(o.slow_twap, o.price, o.params.slow_alpha)?;

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
        require!(params.twap_window_secs > 0, OracleError::BadParams);
        require!(params.max_tick_move > 0, OracleError::BadParams);
        require!(params.max_staleness_secs > 0, OracleError::BadParams);
        ctx.accounts.oracle.params = params;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// pure logic — testable without a validator
// ---------------------------------------------------------------------------

/// Store the reading in the ring buffer.
pub fn push_observation(o: &mut OracleAccount, price: u64, ts: i64) {
    let head = o.obs_head as usize % ORACLE_OBSERVATIONS;
    o.observations[head] = Observation { price, ts };
    o.obs_head = ((head + 1) % ORACLE_OBSERVATIONS) as u8;
    if (o.obs_len as usize) < ORACLE_OBSERVATIONS {
        o.obs_len += 1;
    }
}

/// Mean of the observations inside the window. If none fall inside it, falls
/// back to the most recent one — never returns zero when data is present.
pub fn compute_twap(o: &OracleAccount, now: i64) -> Result<u64> {
    let window = o.params.twap_window_secs as i64;
    let mut sum: u128 = 0;
    let mut count: u128 = 0;
    let mut newest: Option<Observation> = None;

    for i in 0..(o.obs_len as usize) {
        let obs = o.observations[i];
        if obs.ts == 0 {
            continue;
        }
        if newest.map(|n| obs.ts > n.ts).unwrap_or(true) {
            newest = Some(obs);
        }
        if now.saturating_sub(obs.ts) <= window {
            sum += obs.price as u128;
            count += 1;
        }
    }

    if count == 0 {
        let n = newest.ok_or(error!(OracleError::NoObservations))?;
        return Ok(n.price);
    }
    u64::try_from(sum / count).map_err(|_| error!(OracleError::PriceOverflow))
}

/// Limit the published price's movement to `max_move_wad` per update.
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

/// Decide the oracle's state from the three defences.
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
    Ok(OracleState::Ok)
}

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
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
    use slab_math::WAD;

    fn fresh() -> OracleAccount {
        OracleAccount {
            basket: Pubkey::default(),
            amm_pool: Pubkey::default(),
            adapter: AmmAdapter::Mock,
            admin: Pubkey::default(),
            price: 0,
            twap: 0,
            spot: 0,
            slow_twap: 0,
            depth_usdc: 60_000_000_000,
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

    #[test]
    fn clamp_blocks_a_single_block_jump() {
        let prev = WAD as u64;
        // target 50% higher, 5% clamp -> it moves only 5%
        assert_eq!(clamp_move(prev, prev * 3 / 2, 50_000).unwrap(), 1_050_000);
        // downwards too
        assert_eq!(clamp_move(prev, prev / 2, 50_000).unwrap(), 950_000);
        // a small move passes through intact
        assert_eq!(clamp_move(prev, 1_010_000, 50_000).unwrap(), 1_010_000);
    }

    #[test]
    fn clamp_reaches_the_target_over_repeated_updates() {
        // manipulation does not become impossible, it becomes expensive
        let mut p = WAD as u64;
        let target = (WAD as u64) * 3 / 2;
        let mut steps = 0;
        while p < target && steps < 100 {
            p = clamp_move(p, target, 50_000).unwrap();
            steps += 1;
        }
        assert!(steps >= 8, "should need several updates, took {steps}");
        assert!(p >= target - 1);
    }

    #[test]
    fn twap_averages_only_inside_the_window() {
        let mut o = fresh();
        let now = 10_000i64;
        push_observation(&mut o, 1_000_000, now - 100);
        push_observation(&mut o, 1_200_000, now - 200);
        // outside the 1800s window: must not enter the mean
        push_observation(&mut o, 9_000_000, now - 5_000);
        assert_eq!(compute_twap(&o, now).unwrap(), 1_100_000);
    }

    #[test]
    fn twap_falls_back_to_newest_when_all_observations_are_old() {
        let mut o = fresh();
        push_observation(&mut o, 1_000_000, 10);
        push_observation(&mut o, 2_000_000, 20);
        assert_eq!(compute_twap(&o, 100_000).unwrap(), 2_000_000);
    }

    #[test]
    fn observation_ring_buffer_wraps_without_losing_capacity() {
        let mut o = fresh();
        for i in 0..(ORACLE_OBSERVATIONS as i64 * 2) {
            push_observation(&mut o, 1_000_000 + i as u64, 1_000 + i);
        }
        assert_eq!(o.obs_len as usize, ORACLE_OBSERVATIONS);
        assert!(o.observations.iter().all(|x| x.ts != 0));
    }

    #[test]
    fn shallow_depth_forces_reduce_only() {
        let mut o = fresh();
        o.price = WAD as u64;
        o.last_update_ts = 1_000;
        o.depth_usdc = o.params.min_pool_depth - 1;
        assert_eq!(evaluate_state(&o, 1_010).unwrap(), OracleState::ShallowDepth);
        o.depth_usdc = o.params.min_pool_depth;
        assert_eq!(evaluate_state(&o, 1_010).unwrap(), OracleState::Ok);
    }

    #[test]
    fn stale_oracle_is_detected() {
        let mut o = fresh();
        o.price = WAD as u64;
        o.last_update_ts = 1_000;
        let late = 1_000 + o.params.max_staleness_secs as i64 + 1;
        assert_eq!(evaluate_state(&o, late).unwrap(), OracleState::Stale);
    }

    #[test]
    fn divergence_from_external_median_trips_the_sanity_bound() {
        let mut o = fresh();
        o.price = WAD as u64;
        o.last_update_ts = 1_000;
        o.external_ts = 1_000;

        // 10% apart: inside the 15% bound
        o.external_median = 909_091;
        assert_eq!(evaluate_state(&o, 1_010).unwrap(), OracleState::Ok);

        // 25% apart: breaches it
        o.external_median = 800_000;
        assert_eq!(evaluate_state(&o, 1_010).unwrap(), OracleState::Diverged);
    }

    #[test]
    fn missing_external_feed_degrades_instead_of_halting() {
        let mut o = fresh();
        o.price = WAD as u64;
        o.last_update_ts = 1_000;
        o.external_median = 0; // never fed
        assert_eq!(
            evaluate_state(&o, 1_010).unwrap(),
            OracleState::Ok,
            "with no external feed the market loses a defence, not its pulse"
        );
    }

    #[test]
    fn the_slow_mark_seeds_then_crawls() {
        let alpha = 10_000; // 0.01
        // first sample seeds rather than crawling up from zero
        assert_eq!(advance_slow(0, WAD as u64, alpha).unwrap(), WAD as u64);

        // a doubling is followed at 1% per update
        let next = advance_slow(WAD as u64, 2 * WAD as u64, alpha).unwrap();
        assert_eq!(next, WAD as u64 + 10_000);

        // and it takes hundreds of updates to get there
        let mut slow = WAD as u64;
        let mut steps = 0;
        while slow < (WAD as u64) * 3 / 2 && steps < 10_000 {
            slow = advance_slow(slow, 2 * WAD as u64, alpha).unwrap();
            steps += 1;
        }
        assert!(steps > 60, "a 50% mark-up took only {steps} updates");
    }

    #[test]
    fn the_slow_mark_falls_as_slowly_as_it_rises() {
        // Symmetry matters: the protection comes from min(price, slow), not
        // from the EMA itself being asymmetric.
        let alpha = 10_000;
        let up = advance_slow(WAD as u64, 2 * WAD as u64, alpha).unwrap() - WAD as u64;
        let down = WAD as u64 - advance_slow(WAD as u64, 0, alpha).unwrap();
        assert_eq!(up, down);
    }

    #[test]
    fn uninitialized_until_the_first_price() {
        assert_eq!(evaluate_state(&fresh(), 1).unwrap(), OracleState::Uninitialized);
    }
}
