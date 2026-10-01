//! Program `clp-pool` — OWNER: Backend B.
//!
//! The pool is the counterparty to every trade. It carries two sleeves with
//! separate jobs, and one never does the other's work:
//!
//! - USDC sleeve (`usdc_sleeve`): pays winning traders, withdrawals, liquidations
//! - card sleeve (`card_sleeve_value`): provides the beta and the LP's return
//!
//! The card sleeve never pays a winning trader. That is why the open-interest
//! ceiling looks at `usdc_sleeve` and not at total NAV.
//!
//! Withdrawals are ALWAYS proportional across both sleeves. There is no
//! USDC-only path: if there were, the first out would take the liquid side and
//! the last would be left holding the whole illiquid one.
//!
//! Risk policy lives in `slab-risk`; pure arithmetic lives in `slab-math`.
//! This program validates accounts, moves tokens, and stores state.

use anchor_lang::prelude::*;
use slab_interface::{m, r, seeds, MarketState, PoolParams};
use slab_math::{
    assets_for_shares, card_weight, clp_price, nav, proportional_share, prorata_haircut,
    shares_for_deposit, subtract_bps_ceil, to_u64, utilization,
};
use slab_risk::{self as risk, Capacity};

declare_id!("3XZkAqLeQDoNXD6Bb9YoGSEdnvqk9r7UMgrKsN5x3L9v");

pub mod errors;
use errors::PoolError;

#[program]
pub mod clp_pool {
    use super::*;

    /// Create the pool. Once, by the admin.
    pub fn initialize_pool(ctx: Context<InitializePool>, params: PoolParams) -> Result<()> {
        validate_params(&params)?;
        let p = &mut ctx.accounts.pool;
        p.admin = ctx.accounts.admin.key();
        p.usdc_mint = ctx.accounts.usdc_mint.key();
        p.clp_mint = ctx.accounts.clp_mint.key();
        p.usdc_vault = ctx.accounts.usdc_vault.key();
        p.oracle = ctx.accounts.oracle.key();
        p.perp_market = Pubkey::default();
        p.usdc_sleeve = 0;
        p.card_sleeve_value = 0;
        p.clp_supply = 0;
        p.trader_pnl = 0;
        p.bad_debt = 0;
        p.accrued_fees_lp = 0;
        p.accrued_fees_protocol = 0;
        p.params = params;
        p.state = MarketState::Active;
        p.bump = ctx.bumps.pool;
        Ok(())
    }

    /// Bind the perp market allowed to touch the pool's risk accounting.
    /// After this, only that PDA may sign for it.
    pub fn set_perp_market(ctx: Context<AdminOnly>, market: Pubkey) -> Result<()> {
        ctx.accounts.pool.perp_market = market;
        Ok(())
    }

    /// Change the economic parameters. They live here and nowhere else.
    pub fn set_params(ctx: Context<AdminOnly>, params: PoolParams) -> Result<()> {
        validate_params(&params)?;
        ctx.accounts.pool.params = params;
        Ok(())
    }

    /// Explicit state transition. Deterministic and testable.
    ///
    /// There is no way back from `Settled`: once over, over.
    pub fn set_state(ctx: Context<AdminOnly>, next: MarketState) -> Result<()> {
        let p = &mut ctx.accounts.pool;
        require!(p.state != MarketState::Settled, PoolError::AlreadySettled);
        p.state = next;
        emit!(StateChanged {
            pool: p.key(),
            state: next
        });
        Ok(())
    }

    // D3-D5 (Backend B): deposit, withdraw, settle_position.
    //
    // The decisions already exist and are tested below as pure methods on
    // `Pool`. What is missing is the token movement around them, plus the
    // CPI door that lets `perp` pay a winning trader — see Blocker #4.
}

pub fn validate_params(p: &PoolParams) -> Result<()> {
    require!(p.phi > 0, PoolError::BadParams);
    require!(p.delta_max > 0, PoolError::BadParams);
    require!(p.mu > 0, PoolError::BadParams);
    require!(p.base_leverage > 0, PoolError::BadParams);
    require!(p.maintenance_margin > 0, PoolError::BadParams);
    require!(p.lp_fee_share_bps <= 10_000, PoolError::BadParams);
    require!(p.deposit_haircut_bps < 10_000, PoolError::BadParams);
    Ok(())
}

// ---------------------------------------------------------------------------
// pool accounting
// ---------------------------------------------------------------------------

impl Pool {
    /// `NAV = U + card sleeve - trader PnL - bad debt`
    pub fn nav(&self) -> Result<u64> {
        m(nav(
            self.usdc_sleeve,
            self.card_sleeve_value,
            self.trader_pnl,
            self.bad_debt,
        ))
    }

    pub fn clp_price(&self) -> Result<u128> {
        m(clp_price(self.nav()?, self.clp_supply))
    }

    /// Both open-interest ceilings and which one binds. Delegated to
    /// `slab-risk`: the pool stores the inputs, the risk crate decides.
    pub fn capacity(&self, oracle_depth: u64) -> Result<Capacity> {
        r(risk::capacity(
            self.usdc_sleeve,
            oracle_depth,
            &self.params.risk(),
        ))
    }

    /// Utilization in WAD against the binding ceiling.
    pub fn utilization(&self, oi_total: u64, oracle_depth: u64) -> Result<u128> {
        m(utilization(oi_total, self.capacity(oracle_depth)?.cap))
    }

    /// Effective value of a card-fraction deposit after the haircut.
    pub fn haircut_value(&self, gross_value: u64) -> Result<u64> {
        let net = m(subtract_bps_ceil(
            gross_value as u128,
            self.params.deposit_haircut_bps as u128,
        ))?;
        m(to_u64(net))
    }

    /// Weight ceiling for one card inside the sleeve. Stops the pool from
    /// becoming a bet on a single card.
    pub fn require_card_weight(&self, card_value_after: u64, sleeve_after: u64) -> Result<()> {
        let w = m(card_weight(card_value_after, sleeve_after))?;
        require!(
            w <= self.params.max_card_weight as u128,
            PoolError::CardWeightExceeded
        );
        Ok(())
    }

    /// CLP minted for a deposit. Rounds down.
    pub fn shares_for(&self, value: u64) -> Result<u64> {
        m(shares_for_deposit(value, self.nav()?, self.clp_supply))
    }

    /// Total value returned for a redemption. Rounds down.
    pub fn assets_for(&self, shares: u64) -> Result<u64> {
        m(assets_for_shares(shares, self.nav()?, self.clp_supply))
    }

    /// PROPORTIONAL slice of each sleeve for a redemption. Both sides always
    /// leave together.
    pub fn withdraw_split(&self, shares: u64) -> Result<(u64, u64)> {
        let usdc = m(proportional_share(self.usdc_sleeve, shares, self.clp_supply))?;
        let cards = m(proportional_share(
            self.card_sleeve_value,
            shares,
            self.clp_supply,
        ))?;
        Ok((usdc, cards))
    }

    /// Final redemption in `Settled`, with an equal pro-rata haircut.
    pub fn settlement_payout(&self, shares: u64, total_claims: u64) -> Result<u64> {
        let claim = self.assets_for(shares)?;
        m(prorata_haircut(claim, total_claims, self.usdc_sleeve))
    }
}

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub clp_mint: Pubkey,
    pub usdc_vault: Pubkey,
    pub oracle: Pubkey,
    /// The perp market allowed to touch risk accounting.
    pub perp_market: Pubkey,

    /// Liquid sleeve `U`, in native USDC. Winners are paid from here.
    pub usdc_sleeve: u64,
    /// Marked value of the card sleeve, in native USDC.
    pub card_sleeve_value: u64,
    pub clp_supply: u64,

    /// Net trader PnL, signed. Positive means traders are winning and NAV is
    /// falling. Written by the `perp` program.
    pub trader_pnl: i128,
    /// Realised loss the pool absorbed. VISIBLE on purpose.
    pub bad_debt: u64,

    pub accrued_fees_lp: u64,
    pub accrued_fees_protocol: u64,

    pub params: PoolParams,
    pub state: MarketState,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: USDC mint; full validation is outside day-1 scope.
    pub usdc_mint: UncheckedAccount<'info>,
    /// CHECK: CLP mint, created by the admin.
    pub clp_mint: UncheckedAccount<'info>,
    /// CHECK: token account holding the liquid sleeve.
    pub usdc_vault: UncheckedAccount<'info>,
    /// CHECK: oracle account; ownership verified on every read.
    pub oracle: UncheckedAccount<'info>,
    #[account(
        init, payer = admin, space = 8 + Pool::INIT_SPACE,
        seeds = [seeds::POOL, usdc_mint.key().as_ref()], bump
    )]
    pub pool: Account<'info, Pool>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(address = pool.admin @ PoolError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [seeds::POOL, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
}

#[event]
pub struct StateChanged {
    pub pool: Pubkey,
    pub state: MarketState,
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use slab_math::WAD;
    use slab_risk::Binding;

    const USDC: u64 = 1_000_000;

    fn pool() -> Pool {
        Pool {
            admin: Pubkey::default(),
            usdc_mint: Pubkey::default(),
            clp_mint: Pubkey::default(),
            usdc_vault: Pubkey::default(),
            oracle: Pubkey::default(),
            perp_market: Pubkey::default(),
            usdc_sleeve: 140_000 * USDC,
            card_sleeve_value: 60_000 * USDC,
            clp_supply: 200_000 * USDC,
            trader_pnl: 0,
            bad_debt: 0,
            accrued_fees_lp: 0,
            accrued_fees_protocol: 0,
            params: PoolParams::default(),
            state: MarketState::Active,
            bump: 255,
        }
    }

    #[test]
    fn nav_and_clp_price_start_at_parity() {
        let p = pool();
        assert_eq!(p.nav().unwrap(), 200_000 * USDC);
        assert_eq!(p.clp_price().unwrap(), WAD);
    }

    #[test]
    fn trader_profit_reduces_nav_one_for_one() {
        let mut p = pool();
        let before = p.nav().unwrap();
        p.trader_pnl = 640 * USDC as i128;
        assert_eq!(before - p.nav().unwrap(), 640 * USDC);
    }

    #[test]
    fn bad_debt_is_deducted_and_stays_visible() {
        let mut p = pool();
        p.bad_debt = 1_000 * USDC;
        assert_eq!(p.nav().unwrap(), 199_000 * USDC);
    }

    #[test]
    fn the_depth_ceiling_binds_long_before_solvency_does() {
        // The finding the simulator surfaced: with the spec parameters it is
        // AMM depth that sizes the market, not the CLP balance.
        let c = pool().capacity(60_000 * USDC).unwrap();
        assert_eq!(c.cap_solvency / USDC, 233_333);
        assert_eq!(c.cap_depth / USDC, 17_944);
        assert_eq!(c.cap, c.cap_depth);
        assert_eq!(c.binding, Binding::Depth);
    }

    #[test]
    fn solvency_binds_once_the_amm_is_deep() {
        let c = pool().capacity(5_000_000 * USDC).unwrap();
        assert_eq!(c.cap, c.cap_solvency);
        assert_eq!(c.binding, Binding::Solvency);
    }

    #[test]
    fn withdrawals_are_proportional_and_never_usdc_only() {
        let p = pool();
        let shares = p.clp_supply / 10;
        let (usdc, cards) = p.withdraw_split(shares).unwrap();
        assert_eq!(usdc, 14_000 * USDC);
        assert_eq!(cards, 6_000 * USDC);
        // neither sleeve alone covers the redemption: that is what stops a run
        assert!(usdc < p.assets_for(shares).unwrap());
        assert_eq!(usdc + cards, p.assets_for(shares).unwrap());
    }

    #[test]
    fn deposit_then_withdraw_never_prints_value() {
        let mut p = pool();
        let dep = 5_000 * USDC;
        let shares = p.shares_for(dep).unwrap();
        p.usdc_sleeve += dep;
        p.clp_supply += shares;
        let back = p.assets_for(shares).unwrap();
        assert!(back <= dep);
        assert!(dep - back <= 1);
    }

    #[test]
    fn card_deposits_take_the_haircut() {
        assert_eq!(pool().haircut_value(1_000 * USDC).unwrap(), 970 * USDC);
    }

    #[test]
    fn a_single_card_cannot_dominate_the_sleeve() {
        let p = pool();
        assert!(p.require_card_weight(15, 100).is_ok()); // 15% exactly
        assert!(p.require_card_weight(16, 100).is_err());
    }

    #[test]
    fn the_settlement_haircut_is_equal_for_everyone() {
        let mut p = pool();
        p.usdc_sleeve = 70_000 * USDC; // pool holds only 70% of what it owes
        p.card_sleeve_value = 0;
        let total_claims = 100_000 * USDC;
        let a = p.settlement_payout(p.clp_supply / 2, total_claims).unwrap();
        let b = p.settlement_payout(p.clp_supply / 4, total_claims).unwrap();
        assert!(a > 0 && b > 0);
        assert!((a as i128 - 2 * b as i128).abs() <= 2);
    }

    #[test]
    fn state_gates_match_the_spec() {
        let mut p = pool();
        assert!(p.state.allows_open() && p.state.allows_withdraw());
        p.state = MarketState::ReduceOnly;
        assert!(!p.state.allows_open());
        assert!(!p.state.allows_withdraw(), "withdrawals freeze in ReduceOnly");
        assert!(p.state.allows_close() && p.state.allows_liquidate());
        p.state = MarketState::Settled;
        assert!(!p.state.allows_close() && !p.state.allows_liquidate());
    }

    #[test]
    fn bad_params_are_refused() {
        let mut bad = PoolParams::default();
        bad.phi = 0;
        assert!(validate_params(&bad).is_err());
        bad = PoolParams::default();
        bad.delta_max = 0;
        assert!(validate_params(&bad).is_err());
        bad = PoolParams::default();
        bad.deposit_haircut_bps = 10_000;
        assert!(validate_params(&bad).is_err());
        assert!(validate_params(&PoolParams::default()).is_ok());
    }
}
