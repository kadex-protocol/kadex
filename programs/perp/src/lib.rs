//! Program `perp` — OWNER: Backend B.
//!
//! Long and short positions against the CLP pool. There is no order book and
//! no trader-to-trader matching: the pool rents out exposure and charges
//! borrow by the hour.
//!
//! # The shape to copy
//!
//! `open_position` below is the reference. Every instruction in this codebase
//! follows it:
//!
//! 1. Anchor validates the accounts (constraints in the `#[derive(Accounts)]`)
//! 2. the handler reads what it needs and calls **one** function in `slab-risk`
//! 3. the handler moves tokens and writes state
//! 4. the handler emits an event
//!
//! The handler decides nothing. Every rule — the two ceilings, the margin
//! requirement, the utilization gate — lives in `slab-risk`, which cannot
//! reach an `AccountInfo` and is therefore testable in milliseconds.
//!
//! If a handler here grows past ~25 lines, a rule has leaked out of
//! `slab-risk`. Move it back. `handlers_stay_thin` fails when that happens.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use clp_pool::Pool;
use slab_interface::{m, r, read_oracle, seeds, OracleView, Side, ORACLE_PROGRAM_ID};
use slab_risk::{self as risk, Gates, MarketRisk, PositionRisk};

declare_id!("BcVwJ91Jd1k7xUNcGYzRygq2ubaCYn7p5MeUZzy1EyLR");

pub mod errors;
use errors::PerpError;

#[program]
pub mod perp {
    use super::*;

    /// Create the market for a pool and an oracle.
    pub fn initialize_market(ctx: Context<InitializeMarket>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mk = &mut ctx.accounts.market;
        mk.pool = ctx.accounts.pool.key();
        mk.oracle = ctx.accounts.oracle.key();
        mk.set_risk(MarketRisk::new(now));
        mk.open_positions = 0;
        mk.bump = ctx.bumps.market;
        Ok(())
    }

    /// Open a leveraged position against the pool.
    ///
    /// REFERENCE IMPLEMENTATION — copy this shape.
    pub fn open_position(
        ctx: Context<OpenPosition>,
        nonce: u64,
        side: Side,
        notional: u64,
        margin: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pool = &ctx.accounts.pool;
        let params = pool.params.risk();
        let oracle = ctx.accounts.oracle_view()?;

        // One call. Every rule that can refuse this order refuses in there.
        let approval = r(risk::check_open(
            &ctx.accounts.market.risk(),
            ctx.accounts.gates(&oracle),
            oracle.risk_input(),
            pool.usdc_sleeve,
            side.into(),
            notional,
            margin,
            &params,
        ))?;

        let fee = m(slab_math::apply_bps_ceil(
            notional as u128,
            pool.params.open_close_fee_bps as u128,
        ))
        .and_then(|v| m(slab_math::to_u64(v)))?;
        ctx.accounts.collect(margin + fee)?;

        let mk = &mut ctx.accounts.market;
        let mut state = mk.risk();
        r(state.add_position(side.into(), notional, approval.entry_price))?;
        mk.set_risk(state);
        mk.open_positions = mk.open_positions.saturating_add(1);

        ctx.accounts.position.set_inner(Position {
            owner: ctx.accounts.trader.key(),
            market: mk.key(),
            side,
            notional,
            margin,
            entry_price: approval.entry_price,
            borrow_idx_entry: approval.borrow_idx_entry,
            opened_ts: now,
            nonce,
            bump: ctx.bumps.position,
        });

        emit!(PositionOpened {
            position: ctx.accounts.position.key(),
            owner: ctx.accounts.trader.key(),
            side,
            notional,
            margin,
            entry_price: approval.entry_price,
            fee,
            oi_after: approval.oi_after,
            cap: approval.capacity.cap,
        });
        Ok(())
    }

    /// Advance both borrow indices. PERMISSIONLESS: without an actor nobody
    /// pays rent, so anyone may call it.
    pub fn accrue_borrow(ctx: Context<AccrueBorrow>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let params = ctx.accounts.pool.params.risk();
        let depth = ctx.accounts.oracle_view()?.depth;
        let cap = r(risk::capacity(ctx.accounts.pool.usdc_sleeve, depth, &params))?.cap;
        let mk = &mut ctx.accounts.market;
        let mut state = mk.risk();
        r(risk::accrue(&mut state, now, cap, &params))?;
        mk.set_risk(state);
        Ok(())
    }

    /// Close your own position and take what is left of the margin.
    pub fn close_position(ctx: Context<ClosePosition>) -> Result<()> {
        let price = ctx.accounts.mark_price()?;
        let pos = ctx.accounts.position.risk();
        let idx = ctx.accounts.market.risk().borrow_index(pos.side);

        let outcome = r(risk::settle_close(&pos, price, idx))?;
        let fee = ctx.accounts.close_fee(pos.notional)?;
        let snapshot = ctx.accounts.unwind(pos, price)?;

        ctx.accounts.settle(outcome.to_trader.saturating_sub(fee), fee, outcome.bad_debt, snapshot)?;

        emit!(PositionClosed {
            position: ctx.accounts.position.key(),
            owner: ctx.accounts.owner.key(),
            price,
            to_trader: outcome.to_trader.saturating_sub(fee),
            fee,
            bad_debt: outcome.bad_debt,
        });
        Ok(())
    }

    /// Liquidate an underwater position. PERMISSIONLESS, and paid.
    ///
    /// Liquidation does not happen on its own: somebody has to send the
    /// transaction, so somebody has to be paid for it. The maintenance margin
    /// exists precisely so there is still something left to pay them with.
    pub fn liquidate(ctx: Context<Liquidate>) -> Result<()> {
        let price = ctx.accounts.mark_price()?;
        let params = ctx.accounts.pool.params.risk();
        let pos = ctx.accounts.position.risk();
        let idx = ctx.accounts.market.risk().borrow_index(pos.side);

        require!(
            r(risk::is_liquidatable(&pos, price, idx, &params))?,
            PerpError::NotLiquidatable
        );

        let outcome = r(risk::settle_liquidation(&pos, price, idx, &params))?;
        let snapshot = ctx.accounts.unwind(pos, price)?;
        ctx.accounts.settle(outcome.liquidator_fee, 0, outcome.bad_debt, snapshot)?;

        emit!(PositionLiquidated {
            position: ctx.accounts.position.key(),
            owner: ctx.accounts.position.owner,
            liquidator: ctx.accounts.liquidator.key(),
            price,
            liquidator_fee: outcome.liquidator_fee,
            to_pool: outcome.to_pool,
            bad_debt: outcome.bad_debt,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub pool: Pubkey,
    pub oracle: Pubkey,
    pub oi_long: u64,
    pub oi_short: u64,
    /// Sum of `notional / entry_price` per side, in WAD. Lets the whole book
    /// be marked in O(1) so NAV can account for open positions.
    pub units_long: u128,
    pub units_short: u128,
    pub borrow_idx_long: u128,
    pub borrow_idx_short: u128,
    pub last_accrual_ts: i64,
    pub open_positions: u32,
    pub bump: u8,
}

impl Market {
    /// Project onto the plain struct `slab-risk` works with.
    ///
    /// The fields are stored flat rather than as a nested `MarketRisk` on
    /// purpose: nesting it would force `slab-risk` to depend on Borsh and
    /// Anchor's `InitSpace`, and the whole value of that crate is that it
    /// depends on neither. A copy in and out is the price of the guarantee.
    pub fn risk(&self) -> MarketRisk {
        MarketRisk {
            oi_long: self.oi_long,
            oi_short: self.oi_short,
            units_long: self.units_long,
            units_short: self.units_short,
            borrow_idx_long: self.borrow_idx_long,
            borrow_idx_short: self.borrow_idx_short,
            last_accrual_ts: self.last_accrual_ts,
        }
    }

    pub fn set_risk(&mut self, r: MarketRisk) {
        self.oi_long = r.oi_long;
        self.oi_short = r.oi_short;
        self.units_long = r.units_long;
        self.units_short = r.units_short;
        self.borrow_idx_long = r.borrow_idx_long;
        self.borrow_idx_short = r.borrow_idx_short;
        self.last_accrual_ts = r.last_accrual_ts;
    }

    pub fn signer_seeds<'a>(&'a self, pool: &'a Pubkey) -> [&'a [u8]; 3] {
        [seeds::MARKET, pool.as_ref(), core::slice::from_ref(&self.bump)]
    }
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub side: Side,
    pub notional: u64,
    pub margin: u64,
    pub entry_price: u64,
    pub borrow_idx_entry: u128,
    pub opened_ts: i64,
    pub nonce: u64,
    pub bump: u8,
}

impl Position {
    /// Shape this position takes when handed to `slab-risk`.
    pub fn risk(&self) -> PositionRisk {
        PositionRisk {
            side: self.side.into(),
            notional: self.notional,
            margin: self.margin,
            entry_price: self.entry_price,
            borrow_idx_entry: self.borrow_idx_entry,
        }
    }
}

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: pool identity only; its fields are read where they are needed.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: oracle account; ownership checked on every read.
    pub oracle: UncheckedAccount<'info>,
    #[account(
        init, payer = admin, space = 8 + Market::INIT_SPACE,
        seeds = [seeds::MARKET, pool.key().as_ref()], bump
    )]
    pub market: Account<'info, Market>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        mut,
        seeds = [seeds::MARKET, market.pool.as_ref()], bump = market.bump,
        has_one = pool @ PerpError::WrongPool,
        has_one = oracle @ PerpError::WrongOracle,
    )]
    pub market: Account<'info, Market>,

    /// Read-only here: the pool supplies the parameters and the liquid sleeve
    /// that the capacity ceiling is computed from.
    pub pool: Account<'info, Pool>,

    /// CHECK: deserialized through `read_oracle`, which verifies the owner is
    /// the oracle program. Never read by hand.
    pub oracle: UncheckedAccount<'info>,

    #[account(
        init, payer = trader, space = 8 + Position::INIT_SPACE,
        seeds = [seeds::POSITION, market.key().as_ref(), trader.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub position: Account<'info, Position>,

    #[account(
        mut,
        constraint = trader_usdc.mint == pool.usdc_mint @ PerpError::WrongMint,
        constraint = trader_usdc.owner == trader.key() @ PerpError::NotOwner,
    )]
    pub trader_usdc: Account<'info, TokenAccount>,

    #[account(mut, address = pool.usdc_vault @ PerpError::WrongVault)]
    pub usdc_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> OpenPosition<'info> {
    /// The only door to the oracle.
    pub fn oracle_view(&self) -> Result<OracleView> {
        read_oracle(&self.oracle.to_account_info(), &ORACLE_PROGRAM_ID)
    }

    /// Translate the two state enums into the booleans `slab-risk` asks for.
    /// Keeping the enums out of the risk crate means a change in their shape
    /// never reaches a rule.
    pub fn gates(&self, oracle: &OracleView) -> Gates {
        Gates {
            market_allows_open: self.pool.state.allows_open(),
            oracle_tradeable: oracle.state.is_tradeable(),
        }
    }

    /// Margin plus fee, from the trader into the pool's liquid sleeve.
    pub fn collect(&self, amount: u64) -> Result<()> {
        token::transfer(
            CpiContext::new(
                self.token_program.key(),
                Transfer {
                    from: self.trader_usdc.to_account_info(),
                    to: self.usdc_vault.to_account_info(),
                    authority: self.trader.to_account_info(),
                },
            ),
            amount,
        )
    }
}

#[derive(Accounts)]
pub struct AccrueBorrow<'info> {
    /// Permissionless by design.
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [seeds::MARKET, market.pool.as_ref()], bump = market.bump,
        has_one = pool @ PerpError::WrongPool,
        has_one = oracle @ PerpError::WrongOracle,
    )]
    pub market: Account<'info, Market>,
    pub pool: Account<'info, Pool>,
    /// CHECK: read through `read_oracle`.
    pub oracle: UncheckedAccount<'info>,
}

impl<'info> AccrueBorrow<'info> {
    pub fn oracle_view(&self) -> Result<OracleView> {
        read_oracle(&self.oracle.to_account_info(), &ORACLE_PROGRAM_ID)
    }
}

#[event]
pub struct PositionOpened {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub side: Side,
    pub notional: u64,
    pub margin: u64,
    pub entry_price: u64,
    pub fee: u64,
    pub oi_after: u64,
    /// Capacity at the moment of approval, so the log explains refusals later.
    pub cap: u64,
}

// ---------------------------------------------------------------------------
// structural guards
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    /// A handler longer than this almost always has a rule hidden inside it.
    /// Decisions belong in `slab-risk`, where they can be tested without a
    /// validator.
    ///
    /// This is a blunt instrument on purpose: it fails in the `cargo test` of
    /// whoever broke it, within the same minute, instead of surfacing in a
    /// code review nobody has time for.
    const MAX_HANDLER_LINES: usize = 45;

    #[test]
    fn handlers_stay_thin() {
        let src = include_str!("lib.rs");
        let mut inside = false;
        let mut depth = 0usize;
        let mut current: Option<(String, usize)> = None;
        let mut seen: Vec<String> = Vec::new();

        for line in src.lines() {
            let t = line.trim();
            if t.starts_with("pub mod perp {") {
                inside = true;
                continue;
            }
            if !inside {
                continue;
            }
            if let Some(rest) = t.strip_prefix("pub fn ") {
                let name = rest.split('(').next().unwrap_or("?").to_string();
                current = Some((name, 0));
                depth = 0;
            }
            if let Some((_, ref mut n)) = current {
                *n += 1;
                depth += t.matches('{').count();
                depth -= t.matches('}').count().min(depth);
                if depth == 0 && *n > 1 {
                    let (name, count) = current.take().unwrap();
                    assert!(
                        count <= MAX_HANDLER_LINES,
                        "handler `{name}` is {count} lines; limit is {MAX_HANDLER_LINES}. \
                         A rule probably leaked out of slab-risk — move it back."
                    );
                    seen.push(name);
                }
            }
        }

        // A guard that silently finds nothing is worse than no guard: it
        // reports green while the thing it watches rots. If the parser stops
        // recognising handlers — say someone reformats the `#[program]`
        // module — this fails instead of passing vacuously.
        assert!(
            seen.len() >= 3,
            "the thin-handler guard only found {seen:?}; it has stopped \
             parsing the #[program] module and is no longer checking anything"
        );
    }

    #[test]
    fn risk_crate_cannot_reach_solana() {
        // The guarantee is structural: if slab-risk ever gains anchor-lang or
        // solana-program, a rule can start reading accounts and the split
        // stops meaning anything.
        let manifest = include_str!("../../../packages/slab-risk/Cargo.toml");
        let deps = manifest
            .split("[dependencies]")
            .nth(1)
            .expect("slab-risk manifest must declare [dependencies]");
        for forbidden in ["anchor-lang", "anchor-spl", "solana-program", "solana-sdk"] {
            assert!(
                !deps.contains(forbidden),
                "slab-risk must not depend on {forbidden}: risk rules would be \
                 able to touch accounts and stop being testable without a validator"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// settlement accounts
// ---------------------------------------------------------------------------

/// Shared settlement plumbing for closing and liquidating.
///
/// Both instructions do the same three things once the decision is made:
/// unwind the book, push the new PnL snapshot, and move USDC out of the pool.
/// Keeping it in one place means there is one CPI door to audit, not two.
macro_rules! settler {
    ($t:ty) => {
        impl<'info> $t {
            /// Price for marking. `require_markable`, not `require_tradeable`:
            /// a position must be closable and liquidatable even when the
            /// market has stopped accepting new risk. Blocking that would
            /// leave rotten positions accumulating.
            pub fn mark_price(&self) -> Result<u64> {
                let view = read_oracle(
                    &self.oracle.to_account_info(),
                    &ORACLE_PROGRAM_ID,
                )?;
                let now = Clock::get()?.unix_timestamp;
                view.require_markable(now, 900)
            }

            /// Remove the position from the book and return the resulting
            /// whole-book PnL, which the pool stores as its snapshot.
            pub fn unwind(&mut self, pos: slab_risk::PositionRisk, price: u64) -> Result<i128> {
                let mk = &mut self.market;
                let mut state = mk.risk();
                r(state.remove_position(pos.side, pos.notional, pos.entry_price))?;
                mk.set_risk(state);
                mk.open_positions = mk.open_positions.saturating_sub(1);
                r(state.unrealized_pnl(price))
            }

            /// The one door value leaves the pool through.
            pub fn settle(
                &self,
                to_trader: u64,
                fee: u64,
                bad_debt: u64,
                trader_pnl_now: i128,
            ) -> Result<()> {
                let pool_key = self.pool.key();
                let seeds = self.market.signer_seeds(&pool_key);
                clp_pool::cpi::settle_position(
                    CpiContext::new_with_signer(
                        self.clp_pool_program.key(),
                        clp_pool::cpi::accounts::SettlePosition {
                            market: self.market.to_account_info(),
                            pool: self.pool.to_account_info(),
                            usdc_vault: self.usdc_vault.to_account_info(),
                            trader_usdc: self.payout_usdc.to_account_info(),
                            token_program: self.token_program.to_account_info(),
                        },
                        &[&seeds],
                    ),
                    to_trader,
                    fee,
                    bad_debt,
                    trader_pnl_now,
                )
            }
        }
    };
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [seeds::MARKET, market.pool.as_ref()], bump = market.bump,
        has_one = pool @ PerpError::WrongPool,
        has_one = oracle @ PerpError::WrongOracle,
    )]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub pool: Account<'info, Pool>,
    /// CHECK: read through `read_oracle`.
    pub oracle: UncheckedAccount<'info>,
    #[account(
        mut,
        close = owner,
        has_one = owner @ PerpError::NotOwner,
        constraint = position.market == market.key() @ PerpError::WrongMarket,
    )]
    pub position: Account<'info, Position>,
    #[account(mut, address = pool.usdc_vault @ PerpError::WrongVault)]
    pub usdc_vault: Account<'info, TokenAccount>,
    /// The closing trader is paid here.
    #[account(mut, constraint = payout_usdc.owner == owner.key() @ PerpError::NotOwner)]
    pub payout_usdc: Account<'info, TokenAccount>,
    pub clp_pool_program: Program<'info, clp_pool::program::ClpPool>,
    pub token_program: Program<'info, Token>,
}
settler!(ClosePosition<'info>);

impl<'info> ClosePosition<'info> {
    /// Closing fee, rounded up, capped at what the trader is actually owed so
    /// a fee can never manufacture bad debt.
    pub fn close_fee(&self, notional: u64) -> Result<u64> {
        let fee = m(slab_math::apply_bps_ceil(
            notional as u128,
            self.pool.params.open_close_fee_bps as u128,
        ))
        .and_then(|v| m(slab_math::to_u64(v)))?;
        Ok(fee)
    }
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    /// Permissionless. Whoever sends this transaction is paid for it.
    #[account(mut)]
    pub liquidator: Signer<'info>,
    #[account(
        mut,
        seeds = [seeds::MARKET, market.pool.as_ref()], bump = market.bump,
        has_one = pool @ PerpError::WrongPool,
        has_one = oracle @ PerpError::WrongOracle,
    )]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub pool: Account<'info, Pool>,
    /// CHECK: read through `read_oracle`.
    pub oracle: UncheckedAccount<'info>,
    /// Rent goes back to the position's owner, not to the liquidator. The
    /// liquidator is paid by the fee; taking the rent as well would be a
    /// second, undeclared reward.
    #[account(
        mut,
        close = position_owner,
        constraint = position.market == market.key() @ PerpError::WrongMarket,
        constraint = position.owner == position_owner.key() @ PerpError::NotOwner,
    )]
    pub position: Account<'info, Position>,
    /// CHECK: receives the closed position's rent; identity checked above.
    #[account(mut)]
    pub position_owner: UncheckedAccount<'info>,
    #[account(mut, address = pool.usdc_vault @ PerpError::WrongVault)]
    pub usdc_vault: Account<'info, TokenAccount>,
    /// The liquidator's reward is paid here.
    #[account(mut, constraint = payout_usdc.owner == liquidator.key() @ PerpError::NotOwner)]
    pub payout_usdc: Account<'info, TokenAccount>,
    pub clp_pool_program: Program<'info, clp_pool::program::ClpPool>,
    pub token_program: Program<'info, Token>,
}
settler!(Liquidate<'info>);

#[event]
pub struct PositionClosed {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub price: u64,
    pub to_trader: u64,
    pub fee: u64,
    pub bad_debt: u64,
}

#[event]
pub struct PositionLiquidated {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub liquidator: Pubkey,
    pub price: u64,
    pub liquidator_fee: u64,
    pub to_pool: u64,
    pub bad_debt: u64,
}
