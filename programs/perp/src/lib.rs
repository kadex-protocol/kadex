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
        r(state.add_oi(side.into(), notional))?;
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

    // D6-D8 (Backend B): close_position, liquidate.
    //
    // Both follow the shape above. The decisions already exist and are tested:
    // `risk::settle_close` and `risk::settle_liquidation`. What is missing is
    // only the payout, which needs a CPI into `clp-pool` signed by the market
    // PDA — see Blocker #4 in docs/implementation-plan.md.
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
            borrow_idx_long: self.borrow_idx_long,
            borrow_idx_short: self.borrow_idx_short,
            last_accrual_ts: self.last_accrual_ts,
        }
    }

    pub fn set_risk(&mut self, r: MarketRisk) {
        self.oi_long = r.oi_long;
        self.oi_short = r.oi_short;
        self.borrow_idx_long = r.borrow_idx_long;
        self.borrow_idx_short = r.borrow_idx_short;
        self.last_accrual_ts = r.last_accrual_ts;
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
