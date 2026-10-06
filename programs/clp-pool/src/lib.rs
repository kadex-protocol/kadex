//! Program `clp-pool` — OWNER: Backend B.
//!
//! The pool is the counterparty to every trade. It carries two sleeves with
//! separate jobs, and one never does the other's work:
//!
//! - USDC sleeve (`usdc_sleeve`): pays winning traders, withdrawals, liquidations
//! - card sleeve (`fraction_balance`): provides the beta and the LP's return
//!
//! The card sleeve never pays a winning trader. That is why the open-interest
//! ceiling looks at `usdc_sleeve` and not at total NAV.
//!
//! Trader margin is held APART from the USDC sleeve (`margin_held`), and so
//! is the protocol's share of fees: the sleeve is the LPs' money only.
//!
//! Withdrawals are ALWAYS proportional across both sleeves. There is no
//! USDC-only path: if there were, the first out would take the liquid side and
//! the last would be left holding the whole illiquid one.
//!
//! # The card sleeve is marked, not stored
//!
//! `fraction_balance` is a token quantity; its *value* is that quantity times
//! the oracle price, computed on read. An earlier version stored the value and
//! it was wrong: a stored value is a price that stopped moving, and every NAV
//! derived from it would drift away from what the sleeve could actually be
//! sold for.
//!
//! Risk policy lives in `slab-risk`; pure arithmetic lives in `slab-math`.
//! This program validates accounts, moves tokens, and stores state.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};
use slab_interface::{
    m, r, read_oracle, seeds, BookSnapshot, MarketState, PoolParams, ORACLE_PROGRAM_ID,
};
use slab_math::{
    assets_for_shares, card_weight, clp_price, mul_div_floor, mul_wad_floor, nav,
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
        p.fraction_mint = ctx.accounts.fraction_mint.key();
        p.fraction_vault = ctx.accounts.fraction_vault.key();
        p.oracle = ctx.accounts.oracle.key();
        p.perp_market = Pubkey::default();
        p.usdc_sleeve = 0;
        p.fraction_balance = 0;
        p.clp_supply = 0;
        p.book = BookSnapshot::default();
        p.bad_debt = 0;
        p.margin_held = 0;
        p.accrued_fees_lp = 0;
        p.accrued_fees_protocol = 0;
        p.params = params;
        p.state = MarketState::Active;
        p.bump = ctx.bumps.pool;
        Ok(())
    }

    /// Deposit USDC and receive CLP, priced at the ISSUE mark.
    pub fn deposit_usdc(ctx: Context<DepositUsdc>, amount: u64) -> Result<()> {
        let marks = ctx.accounts.marks()?;
        let pool = &ctx.accounts.pool;
        require!(pool.state.allows_deposit(), PoolError::StateForbids);
        require!(amount > 0, PoolError::ZeroAmount);

        let shares = pool.shares_for(amount, &marks)?;
        require!(shares > 0, PoolError::DustDeposit);

        ctx.accounts.pull_usdc(amount)?;
        ctx.accounts.mint_clp(shares)?;

        let pool = &mut ctx.accounts.pool;
        pool.usdc_sleeve = pool
            .usdc_sleeve
            .checked_add(amount)
            .ok_or(PoolError::Overflow)?;
        pool.clp_supply = pool.clp_supply.checked_add(shares).ok_or(PoolError::Overflow)?;

        emit!(Deposited {
            pool: pool.key(),
            depositor: ctx.accounts.depositor.key(),
            usdc: amount,
            fractions: 0,
            shares,
        });
        Ok(())
    }

    /// Deposit card fractions and receive CLP, net of the haircut.
    ///
    /// The fractions are credited at the LOW mark and the CLP is priced at
    /// the HIGH one: a deposit can only ever buy in at a discount to the
    /// pool, never at a discount to the depositor.
    pub fn deposit_fractions(ctx: Context<DepositFractions>, amount: u64) -> Result<()> {
        let marks = ctx.accounts.marks()?;
        let pool = &ctx.accounts.pool;
        require!(pool.state.allows_deposit(), PoolError::StateForbids);
        require!(amount > 0, PoolError::ZeroAmount);

        let gross = pool.fraction_value(amount, marks.low)?;
        let net = pool.haircut_value(gross)?;
        let shares = pool.shares_for(net, &marks)?;
        require!(shares > 0, PoolError::DustDeposit);

        // Keeps the pool from becoming a bet on one card, and keeps the
        // illiquid sleeve from swallowing the liquid one.
        let balance_after = pool
            .fraction_balance
            .checked_add(amount)
            .ok_or(PoolError::Overflow)?;
        pool.require_sleeve_within_target(balance_after, marks.high)?;

        ctx.accounts.pull_fractions(amount)?;
        ctx.accounts.mint_clp(shares)?;

        let pool = &mut ctx.accounts.pool;
        pool.fraction_balance = balance_after;
        pool.clp_supply = pool.clp_supply.checked_add(shares).ok_or(PoolError::Overflow)?;

        emit!(Deposited {
            pool: pool.key(),
            depositor: ctx.accounts.depositor.key(),
            usdc: 0,
            fractions: amount,
            shares,
        });
        Ok(())
    }

    /// Burn CLP and receive its value at NAV, as a slice of BOTH sleeves.
    ///
    /// Two things an earlier version got wrong, and a validator test proved:
    ///
    /// - it paid a raw proportional slice of the vaults, ignoring NAV. With
    ///   $25k of trader margin in the vault, depositing $100k and withdrawing
    ///   at once returned $110,416. Now the slice is sized by NAV.
    /// - it let LPs drain the sleeve that open positions were admitted
    ///   against. Now a withdrawal stops at what open interest needs.
    pub fn withdraw(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
        let marks = ctx.accounts.marks()?;
        let pool = &ctx.accounts.pool;
        require!(pool.state.allows_withdraw(), PoolError::StateForbids);
        require!(shares > 0, PoolError::ZeroAmount);

        let (usdc_out, fractions_out) = pool.redeem_split(shares, &marks)?;
        r(risk::check_withdraw(
            pool.book.oi_total(),
            pool.usdc_sleeve.saturating_sub(usdc_out),
            marks.depth,
            &pool.params.risk(),
        ))?;
        ctx.accounts.burn_clp(shares)?;
        ctx.accounts.push_usdc(usdc_out)?;
        ctx.accounts.push_fractions(fractions_out)?;

        let pool = &mut ctx.accounts.pool;
        pool.usdc_sleeve = pool.usdc_sleeve.saturating_sub(usdc_out);
        pool.fraction_balance = pool.fraction_balance.saturating_sub(fractions_out);
        pool.clp_supply = pool.clp_supply.saturating_sub(shares);

        emit!(Withdrawn {
            pool: pool.key(),
            owner: ctx.accounts.owner.key(),
            shares,
            usdc: usdc_out,
            fractions: fractions_out,
            price: marks.low,
        });
        Ok(())
    }

    /// Record a position opening. CPI ONLY, from the registered perp market.
    ///
    /// Margin and fee have already landed in `usdc_vault`. The margin is the
    /// trader's and is held APART from the LP sleeve, so it can neither be
    /// withdrawn by LPs nor counted as capacity. The fee is split now.
    pub fn record_open(ctx: Context<RecordOpen>, margin: u64, fee: u64, book: BookSnapshot) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.margin_held = pool
            .margin_held
            .checked_add(margin)
            .ok_or(PoolError::Overflow)?;
        pool.book_fee(fee)?;
        pool.book = book;
        Ok(())
    }

    /// Settle one position against the pool. CPI ONLY, from the registered
    /// perp market.
    ///
    /// The position's margin comes back out of `margin_held`; `to_recipient`
    /// is paid (to the trader on a close, to the liquidator on a
    /// liquidation); `fee` is carved out and split. Whatever is left of the
    /// margin is the pool's gain, and whatever the payout exceeds it by is
    /// the pool's loss.
    pub fn settle_position(
        ctx: Context<SettlePosition>,
        to_recipient: u64,
        fee: u64,
        bad_debt: u64,
        book: BookSnapshot,
        margin_released: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.pool.state.allows_close(),
            PoolError::StateForbids
        );
        let sleeve_after = ctx.accounts.pool.sleeve_after_settle(margin_released, to_recipient, fee)?;

        if to_recipient > 0 {
            ctx.accounts.pay_trader(to_recipient)?;
        }

        let pool = &mut ctx.accounts.pool;
        pool.usdc_sleeve = sleeve_after;
        pool.margin_held = pool
            .margin_held
            .checked_sub(margin_released)
            .ok_or(PoolError::Overflow)?;
        pool.book_fee(fee)?;
        pool.bad_debt = pool.bad_debt.checked_add(bad_debt).ok_or(PoolError::Overflow)?;
        pool.book = book;

        emit!(PositionSettled {
            pool: pool.key(),
            to_recipient,
            fee,
            bad_debt,
        });
        Ok(())
    }

    /// Burn CLP after the market has settled and take the final slice.
    ///
    /// The same NAV-sized slice as `withdraw`, which is what makes it fair:
    /// when the pool owes more than it holds, NAV is lower than the assets
    /// and every holder is scaled by the same factor. First come, first
    /// served is what a bank run is. No capacity gate: nothing new can open,
    /// and margin is held apart, so traders are not what LPs are leaving with.
    pub fn redeem_settled(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
        let marks = ctx.accounts.marks()?;
        let pool = &ctx.accounts.pool;
        require!(pool.state == MarketState::Settled, PoolError::NotSettled);
        require!(shares > 0, PoolError::ZeroAmount);

        let (usdc_out, fractions_out) = pool.redeem_split(shares, &marks)?;
        ctx.accounts.burn_clp(shares)?;
        ctx.accounts.push_usdc(usdc_out)?;
        ctx.accounts.push_fractions(fractions_out)?;

        let pool = &mut ctx.accounts.pool;
        pool.usdc_sleeve = pool.usdc_sleeve.saturating_sub(usdc_out);
        pool.fraction_balance = pool.fraction_balance.saturating_sub(fractions_out);
        pool.clp_supply = pool.clp_supply.saturating_sub(shares);

        emit!(Redeemed {
            pool: pool.key(),
            owner: ctx.accounts.owner.key(),
            shares,
            usdc: usdc_out,
            fractions: fractions_out,
            price: marks.low,
        });
        Ok(())
    }

    /// Bind the perp market allowed to touch the pool's risk accounting.
    pub fn set_perp_market(ctx: Context<AdminOnly>, market: Pubkey) -> Result<()> {
        ctx.accounts.pool.perp_market = market;
        Ok(())
    }

    /// Pay out the protocol's share of fees. It sits in the vault, outside
    /// the LP sleeve, until claimed.
    pub fn claim_protocol_fees(ctx: Context<ClaimProtocolFees>, amount: u64) -> Result<()> {
        require!(amount > 0, PoolError::ZeroAmount);
        require!(
            amount <= ctx.accounts.pool.accrued_fees_protocol,
            PoolError::InsufficientLiquidity
        );
        ctx.accounts.pay(amount)?;
        let p = &mut ctx.accounts.pool;
        p.accrued_fees_protocol -= amount;
        Ok(())
    }

    /// Change the economic parameters. They live here and nowhere else.
    pub fn set_params(ctx: Context<AdminOnly>, params: PoolParams) -> Result<()> {
        validate_params(&params)?;
        ctx.accounts.pool.params = params;
        Ok(())
    }

    /// Explicit state transition. There is no way back from `Settled`.
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
}

pub fn validate_params(p: &PoolParams) -> Result<()> {
    require!(p.phi > 0, PoolError::BadParams);
    require!(p.delta_max > 0, PoolError::BadParams);
    require!(p.mu > 0, PoolError::BadParams);
    require!(p.base_leverage > 0, PoolError::BadParams);
    require!(p.maintenance_margin > 0, PoolError::BadParams);
    require!(p.lp_fee_share_bps <= 10_000, PoolError::BadParams);
    require!(p.deposit_haircut_bps < 10_000, PoolError::BadParams);
    require!(p.card_sleeve_target > 0, PoolError::BadParams);
    // A zero safety factor makes the effective mu zero, and the depth ceiling
    // then divides by zero. Catching it here turns a confusing MathFailure at
    // open time into a clear rejection at setup time.
    require!(p.attack_safety > 0, PoolError::BadParams);
    Ok(())
}

// ---------------------------------------------------------------------------
// pool accounting
// ---------------------------------------------------------------------------

/// The three prices the pool needs, read once from a fresh oracle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Marks {
    /// The trading price. Marks the open book.
    pub trade: u64,
    /// `min(price, slow)`. Values the card sleeve when value LEAVES.
    pub low: u64,
    /// `max(price, slow)`. Values the card sleeve when CLP is ISSUED.
    pub high: u64,
    /// Window-minimum AMM depth.
    pub depth: u64,
}

impl Marks {
    /// One price for everything. Tests and quiet markets.
    pub fn flat(price: u64) -> Self {
        Self { trade: price, low: price, high: price, depth: 0 }
    }
}

impl Pool {
    /// Value of `fractions` at `price`, in native USDC.
    pub fn fraction_value(&self, fractions: u64, price: u64) -> Result<u64> {
        m(mul_wad_floor(fractions as u128, price as u128)).and_then(|v| m(to_u64(v)))
    }

    /// The card sleeve marked at `price`. Never a stored number.
    pub fn card_sleeve_value(&self, price: u64) -> Result<u64> {
        self.fraction_value(self.fraction_balance, price)
    }

    /// What the LPs physically hold: the sleeve plus the cards at `card_price`.
    /// Trader margin and the protocol's fees are in the vault but not here.
    pub fn assets(&self, card_price: u64) -> Result<u64> {
        self.usdc_sleeve
            .checked_add(self.card_sleeve_value(card_price)?)
            .ok_or(error!(PoolError::Overflow))
    }

    /// Unrealized trader PnL, marked at today's price.
    pub fn trader_pnl(&self, trade_price: u64) -> Result<i128> {
        r(self.book.unrealized_pnl(trade_price))
    }

    /// NAV for value LEAVING: cards at the low mark, and traders' unrealized
    /// gains owed in full while their unrealized losses are not counted
    /// until realised. An LP cannot leave with money traders have not lost yet.
    pub fn nav_redeem(&self, marks: &Marks) -> Result<u64> {
        let pnl = self.trader_pnl(marks.trade)?.max(0);
        m(nav(self.usdc_sleeve, self.card_sleeve_value(marks.low)?, pnl, 0))
    }

    /// NAV for CLP being ISSUED: cards at the high mark, and the whole open
    /// book at today's price. Never below `nav_redeem`, so a deposit followed
    /// by a withdrawal cannot come out ahead.
    pub fn nav_issue(&self, marks: &Marks) -> Result<u64> {
        let pnl = self.trader_pnl(marks.trade)?;
        m(nav(self.usdc_sleeve, self.card_sleeve_value(marks.high)?, pnl, 0))
    }

    /// The NAV shown to LPs: the conservative one.
    pub fn nav(&self, marks: &Marks) -> Result<u64> {
        self.nav_redeem(marks)
    }

    pub fn clp_price(&self, marks: &Marks) -> Result<u128> {
        m(clp_price(self.nav(marks)?, self.clp_supply))
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

    /// Refuse a deposit that would push the illiquid sleeve past its target.
    ///
    /// The liquid sleeve is what pays winning traders; letting the card side
    /// grow unchecked would quietly shrink the capacity that backs every open
    /// position.
    pub fn require_sleeve_within_target(&self, fraction_balance: u64, price: u64) -> Result<()> {
        let cards = self.fraction_value(fraction_balance, price)?;
        let total = cards
            .checked_add(self.usdc_sleeve)
            .ok_or(PoolError::Overflow)?;
        let w = m(card_weight(cards, total))?;
        require!(
            w <= self.params.card_sleeve_target as u128,
            PoolError::SleeveTargetExceeded
        );
        Ok(())
    }

    /// CLP minted for a deposit of `value`, at the issue NAV. Rounds down.
    ///
    /// A pool whose NAV is zero takes no deposits: the old 1:1 fallback
    /// handed a new depositor shares in a pool that owed more than it held.
    pub fn shares_for(&self, value: u64, marks: &Marks) -> Result<u64> {
        if self.clp_supply == 0 {
            return Ok(value);
        }
        let nav = self.nav_issue(marks)?;
        require!(nav > 0, PoolError::Insolvent);
        m(shares_for_deposit(value, nav, self.clp_supply))
    }

    /// The slice of each sleeve that `shares` are worth at the redeem NAV.
    ///
    /// Value first, then split in the proportion the sleeves are held in, so
    /// both always leave together — there is no USDC-only path, or the first
    /// out would take the liquid side and leave the rest the illiquid one.
    pub fn redeem_split(&self, shares: u64, marks: &Marks) -> Result<(u64, u64)> {
        require!(self.clp_supply > 0, PoolError::ZeroAmount);
        require!(shares <= self.clp_supply, PoolError::Overflow);
        let value = m(assets_for_shares(shares, self.nav_redeem(marks)?, self.clp_supply))?;
        let assets = self.assets(marks.low)?;
        if assets == 0 || value == 0 {
            return Ok((0, 0));
        }
        let usdc = m(mul_div_floor(self.usdc_sleeve as u128, value as u128, assets as u128))
            .and_then(|v| m(to_u64(v)))?;
        let fractions = m(mul_div_floor(self.fraction_balance as u128, value as u128, assets as u128))
            .and_then(|v| m(to_u64(v)))?;
        Ok((usdc, fractions))
    }

    /// The sleeve after a position settles: margin back in, payout and fee
    /// out. Refuses rather than pay what the sleeve does not have.
    pub fn sleeve_after_settle(&self, margin_released: u64, to_recipient: u64, fee: u64) -> Result<u64> {
        let available = self
            .usdc_sleeve
            .checked_add(margin_released)
            .ok_or(PoolError::Overflow)?;
        let out = to_recipient.checked_add(fee).ok_or(PoolError::Overflow)?;
        available
            .checked_sub(out)
            .ok_or(error!(PoolError::InsufficientLiquidity))
    }

    /// Split a fee that is in the vault but not yet in the sleeve. The LPs'
    /// share joins the sleeve, which is what makes CLP appreciate; the
    /// protocol's share stays outside it, owed, until claimed.
    pub fn book_fee(&mut self, fee: u64) -> Result<()> {
        if fee == 0 {
            return Ok(());
        }
        let lp = m(mul_div_floor(
            fee as u128,
            self.params.lp_fee_share_bps as u128,
            10_000,
        ))
        .and_then(|v| m(to_u64(v)))?;
        self.usdc_sleeve = self.usdc_sleeve.checked_add(lp).ok_or(PoolError::Overflow)?;
        self.accrued_fees_lp = self.accrued_fees_lp.checked_add(lp).ok_or(PoolError::Overflow)?;
        self.accrued_fees_protocol = self
            .accrued_fees_protocol
            .checked_add(fee - lp)
            .ok_or(PoolError::Overflow)?;
        Ok(())
    }

    pub fn signer_seeds<'a>(&'a self, usdc_mint: &'a Pubkey) -> [&'a [u8]; 3] {
        [seeds::POOL, usdc_mint.as_ref(), core::slice::from_ref(&self.bump)]
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
    /// The basket's fraction mint, bound at `initialize_pool` and never
    /// changed.
    ///
    /// Issue #10 — fragmentation — is handled by this field rather than by a
    /// convention: a `Pool` has exactly one fraction mint, its PDA is derived
    /// from the USDC mint, and there is no instruction that rebinds it.
    pub fraction_mint: Pubkey,
    pub fraction_vault: Pubkey,
    pub oracle: Pubkey,
    /// The perp market allowed to touch risk accounting.
    pub perp_market: Pubkey,

    /// Liquid sleeve `U`, in native USDC: the LPs' money and nothing else.
    /// Winners are paid from here.
    ///
    /// `usdc_vault` holds `usdc_sleeve + margin_held + accrued_fees_protocol`.
    pub usdc_sleeve: u64,
    /// Card sleeve as a TOKEN QUANTITY. Its value is marked at read time.
    pub fraction_balance: u64,
    pub clp_supply: u64,

    /// The open book, pushed by `perp` on every open and settle, marked at
    /// read time. See [`BookSnapshot`].
    pub book: BookSnapshot,
    /// Losses past a position's margin, recorded for visibility.
    ///
    /// NOT subtracted from NAV: the pool never received that money, so the
    /// sleeve already reflects it. Subtracting it again counted it twice.
    pub bad_debt: u64,
    /// Trader margin sitting in `usdc_vault`, held apart from the sleeve.
    pub margin_held: u64,

    /// Running total of the LPs' fee share, already in the sleeve. Display.
    pub accrued_fees_lp: u64,
    /// The protocol's fee share, in the vault but not the sleeve, until
    /// `claim_protocol_fees`.
    pub accrued_fees_protocol: u64,

    pub params: PoolParams,
    pub state: MarketState,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub usdc_mint: Account<'info, Mint>,
    /// CHECK: CLP mint, authority handed to the pool PDA by the admin.
    pub clp_mint: UncheckedAccount<'info>,
    /// CHECK: token account holding the liquid sleeve.
    pub usdc_vault: UncheckedAccount<'info>,
    /// CHECK: the basket's fraction mint.
    pub fraction_mint: UncheckedAccount<'info>,
    /// CHECK: token account holding the card sleeve.
    pub fraction_vault: UncheckedAccount<'info>,
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

#[derive(Accounts)]
pub struct ClaimProtocolFees<'info> {
    #[account(address = pool.admin @ PoolError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(
        mut, seeds = [seeds::POOL, pool.usdc_mint.as_ref()], bump = pool.bump,
        has_one = usdc_vault @ PoolError::WrongVault,
    )]
    pub pool: Account<'info, Pool>,
    #[account(mut)]
    pub usdc_vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = destination.mint == pool.usdc_mint @ PoolError::WrongMint)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

impl<'info> ClaimProtocolFees<'info> {
    pub fn pay(&self, amount: u64) -> Result<()> {
        let mint = self.pool.usdc_mint;
        let seeds = self.pool.signer_seeds(&mint);
        token::transfer(
            CpiContext::new_with_signer(
                self.token_program.key(),
                Transfer {
                    from: self.usdc_vault.to_account_info(),
                    to: self.destination.to_account_info(),
                    authority: self.pool.to_account_info(),
                },
                &[&seeds],
            ),
            amount,
        )
    }
}

/// Shared account set for anything that has to mark the pool.
macro_rules! oracle_reader {
    ($t:ty) => {
        impl<'info> $t {
            /// The pool's prices, from a FRESH oracle. Not `require_tradeable`:
            /// an LP must be able to leave even when the market has stopped
            /// accepting new risk. A stale oracle is refreshed in the same
            /// transaction — `refresh_price` is permissionless.
            pub fn marks(&self) -> Result<Marks> {
                let view = read_oracle(&self.oracle.to_account_info(), &ORACLE_PROGRAM_ID)?;
                let now = Clock::get()?.unix_timestamp;
                let trade = view.require_markable(now)?;
                Ok(Marks {
                    trade,
                    low: view.mark_price(),
                    high: view.issue_price(),
                    depth: view.depth,
                })
            }
        }
    };
}

#[derive(Accounts)]
pub struct DepositUsdc<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(
        mut, seeds = [seeds::POOL, pool.usdc_mint.as_ref()], bump = pool.bump,
        has_one = oracle @ PoolError::WrongOracle,
        has_one = clp_mint @ PoolError::WrongMint,
        has_one = usdc_vault @ PoolError::WrongVault,
    )]
    pub pool: Account<'info, Pool>,
    /// CHECK: read through `read_oracle`.
    pub oracle: UncheckedAccount<'info>,
    #[account(mut)]
    pub clp_mint: Account<'info, Mint>,
    #[account(mut)]
    pub usdc_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = depositor_usdc.mint == pool.usdc_mint @ PoolError::WrongMint,
        constraint = depositor_usdc.owner == depositor.key() @ PoolError::NotOwner,
    )]
    pub depositor_usdc: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = depositor_clp.mint == pool.clp_mint @ PoolError::WrongMint,
    )]
    pub depositor_clp: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
oracle_reader!(DepositUsdc<'info>);

impl<'info> DepositUsdc<'info> {
    pub fn pull_usdc(&self, amount: u64) -> Result<()> {
        token::transfer(
            CpiContext::new(
                self.token_program.key(),
                Transfer {
                    from: self.depositor_usdc.to_account_info(),
                    to: self.usdc_vault.to_account_info(),
                    authority: self.depositor.to_account_info(),
                },
            ),
            amount,
        )
    }

    pub fn mint_clp(&self, shares: u64) -> Result<()> {
        let mint = self.pool.usdc_mint;
        let seeds = self.pool.signer_seeds(&mint);
        token::mint_to(
            CpiContext::new_with_signer(
                self.token_program.key(),
                MintTo {
                    mint: self.clp_mint.to_account_info(),
                    to: self.depositor_clp.to_account_info(),
                    authority: self.pool.to_account_info(),
                },
                &[&seeds],
            ),
            shares,
        )
    }
}

#[derive(Accounts)]
pub struct DepositFractions<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(
        mut, seeds = [seeds::POOL, pool.usdc_mint.as_ref()], bump = pool.bump,
        has_one = oracle @ PoolError::WrongOracle,
        has_one = clp_mint @ PoolError::WrongMint,
        has_one = fraction_vault @ PoolError::WrongVault,
    )]
    pub pool: Account<'info, Pool>,
    /// CHECK: read through `read_oracle`.
    pub oracle: UncheckedAccount<'info>,
    #[account(mut)]
    pub clp_mint: Account<'info, Mint>,
    #[account(mut)]
    pub fraction_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = depositor_fractions.mint == pool.fraction_mint @ PoolError::WrongMint,
        constraint = depositor_fractions.owner == depositor.key() @ PoolError::NotOwner,
    )]
    pub depositor_fractions: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = depositor_clp.mint == pool.clp_mint @ PoolError::WrongMint,
    )]
    pub depositor_clp: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
oracle_reader!(DepositFractions<'info>);

impl<'info> DepositFractions<'info> {
    pub fn pull_fractions(&self, amount: u64) -> Result<()> {
        token::transfer(
            CpiContext::new(
                self.token_program.key(),
                Transfer {
                    from: self.depositor_fractions.to_account_info(),
                    to: self.fraction_vault.to_account_info(),
                    authority: self.depositor.to_account_info(),
                },
            ),
            amount,
        )
    }

    pub fn mint_clp(&self, shares: u64) -> Result<()> {
        let mint = self.pool.usdc_mint;
        let seeds = self.pool.signer_seeds(&mint);
        token::mint_to(
            CpiContext::new_with_signer(
                self.token_program.key(),
                MintTo {
                    mint: self.clp_mint.to_account_info(),
                    to: self.depositor_clp.to_account_info(),
                    authority: self.pool.to_account_info(),
                },
                &[&seeds],
            ),
            shares,
        )
    }
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut, seeds = [seeds::POOL, pool.usdc_mint.as_ref()], bump = pool.bump,
        has_one = oracle @ PoolError::WrongOracle,
        has_one = clp_mint @ PoolError::WrongMint,
        has_one = usdc_vault @ PoolError::WrongVault,
        has_one = fraction_vault @ PoolError::WrongVault,
    )]
    pub pool: Account<'info, Pool>,
    /// CHECK: read through `read_oracle`.
    pub oracle: UncheckedAccount<'info>,
    #[account(mut)]
    pub clp_mint: Account<'info, Mint>,
    #[account(mut)]
    pub usdc_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub fraction_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = owner_clp.mint == pool.clp_mint @ PoolError::WrongMint,
        constraint = owner_clp.owner == owner.key() @ PoolError::NotOwner,
    )]
    pub owner_clp: Account<'info, TokenAccount>,
    #[account(mut, constraint = owner_usdc.mint == pool.usdc_mint @ PoolError::WrongMint)]
    pub owner_usdc: Account<'info, TokenAccount>,
    #[account(mut, constraint = owner_fractions.mint == pool.fraction_mint @ PoolError::WrongMint)]
    pub owner_fractions: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
oracle_reader!(Withdraw<'info>);

impl<'info> Withdraw<'info> {
    pub fn burn_clp(&self, shares: u64) -> Result<()> {
        token::burn(
            CpiContext::new(
                self.token_program.key(),
                Burn {
                    mint: self.clp_mint.to_account_info(),
                    from: self.owner_clp.to_account_info(),
                    authority: self.owner.to_account_info(),
                },
            ),
            shares,
        )
    }

    pub fn push_usdc(&self, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        let mint = self.pool.usdc_mint;
        let seeds = self.pool.signer_seeds(&mint);
        token::transfer(
            CpiContext::new_with_signer(
                self.token_program.key(),
                Transfer {
                    from: self.usdc_vault.to_account_info(),
                    to: self.owner_usdc.to_account_info(),
                    authority: self.pool.to_account_info(),
                },
                &[&seeds],
            ),
            amount,
        )
    }

    pub fn push_fractions(&self, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        let mint = self.pool.usdc_mint;
        let seeds = self.pool.signer_seeds(&mint);
        token::transfer(
            CpiContext::new_with_signer(
                self.token_program.key(),
                Transfer {
                    from: self.fraction_vault.to_account_info(),
                    to: self.owner_fractions.to_account_info(),
                    authority: self.pool.to_account_info(),
                },
                &[&seeds],
            ),
            amount,
        )
    }
}

#[derive(Accounts)]
pub struct RecordOpen<'info> {
    /// The perp market PDA, signing through CPI.
    #[account(address = pool.perp_market @ PoolError::NotPerpMarket)]
    pub market: Signer<'info>,
    #[account(
        mut, seeds = [seeds::POOL, pool.usdc_mint.as_ref()], bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct SettlePosition<'info> {
    /// The perp market PDA, signing through CPI. This single constraint is
    /// what stops any other program from asking the pool to pay out.
    #[account(address = pool.perp_market @ PoolError::NotPerpMarket)]
    pub market: Signer<'info>,
    #[account(
        mut, seeds = [seeds::POOL, pool.usdc_mint.as_ref()], bump = pool.bump,
        has_one = usdc_vault @ PoolError::WrongVault,
    )]
    pub pool: Account<'info, Pool>,
    #[account(mut)]
    pub usdc_vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = trader_usdc.mint == pool.usdc_mint @ PoolError::WrongMint)]
    pub trader_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

impl<'info> SettlePosition<'info> {
    pub fn pay_trader(&self, amount: u64) -> Result<()> {
        let mint = self.pool.usdc_mint;
        let seeds = self.pool.signer_seeds(&mint);
        token::transfer(
            CpiContext::new_with_signer(
                self.token_program.key(),
                Transfer {
                    from: self.usdc_vault.to_account_info(),
                    to: self.trader_usdc.to_account_info(),
                    authority: self.pool.to_account_info(),
                },
                &[&seeds],
            ),
            amount,
        )
    }
}

#[event]
pub struct Deposited {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub usdc: u64,
    pub fractions: u64,
    pub shares: u64,
}

#[event]
pub struct Withdrawn {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub shares: u64,
    pub usdc: u64,
    pub fractions: u64,
    pub price: u64,
}

#[event]
pub struct Redeemed {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub shares: u64,
    pub usdc: u64,
    pub fractions: u64,
    pub price: u64,
}

#[event]
pub struct PositionSettled {
    pub pool: Pubkey,
    pub to_recipient: u64,
    pub fee: u64,
    pub bad_debt: u64,
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
    use slab_risk::{Binding, MarketRisk, RiskSide as Side};

    const USDC: u64 = 1_000_000;
    const PAR: u64 = WAD as u64;

    fn pool() -> Pool {
        Pool {
            admin: Pubkey::default(),
            usdc_mint: Pubkey::default(),
            clp_mint: Pubkey::default(),
            usdc_vault: Pubkey::default(),
            fraction_mint: Pubkey::default(),
            fraction_vault: Pubkey::default(),
            oracle: Pubkey::default(),
            perp_market: Pubkey::default(),
            usdc_sleeve: 140_000 * USDC,
            fraction_balance: 60_000 * USDC, // 60k fractions at $1.00
            clp_supply: 200_000 * USDC,
            book: BookSnapshot::default(),
            bad_debt: 0,
            margin_held: 0,
            accrued_fees_lp: 0,
            accrued_fees_protocol: 0,
            params: PoolParams::default(),
            state: MarketState::Active,
            bump: 255,
        }
    }

    /// A pool with one long open at $1.
    fn with_long(notional: u64, margin: u64) -> Pool {
        let mut p = pool();
        let mut mk = MarketRisk::new(0);
        mk.add_position(Side::Long, notional, PAR).unwrap();
        p.book = BookSnapshot::of(&mk);
        p.margin_held = margin;
        p
    }

    fn flat() -> Marks {
        Marks::flat(PAR)
    }

    /// Deposit `amount` USDC, then redeem every share it bought, without
    /// anything else happening in between. Returns USDC-equivalent out.
    fn round_trip(mut p: Pool, amount: u64, marks: &Marks) -> u64 {
        let shares = p.shares_for(amount, marks).unwrap();
        p.usdc_sleeve += amount;
        p.clp_supply += shares;
        let (usdc, frac) = p.redeem_split(shares, marks).unwrap();
        usdc + p.fraction_value(frac, marks.trade).unwrap()
    }

    #[test]
    fn nav_and_clp_price_start_at_parity() {
        let p = pool();
        assert_eq!(p.nav(&flat()).unwrap(), 200_000 * USDC);
        assert_eq!(p.clp_price(&flat()).unwrap(), WAD);
    }

    #[test]
    fn the_card_sleeve_is_marked_not_stored() {
        let p = pool();
        let up = Marks::flat(PAR * 11 / 10);
        assert_eq!(p.nav(&up).unwrap(), 206_000 * USDC);
    }

    #[test]
    fn deposit_then_withdraw_with_trader_margin_in_the_vault_prints_nothing() {
        // The validator-proven exploit: $25k margin held, $100k in, $110,416
        // out. Margin now sits outside the sleeve and redemption is NAV-sized.
        let p = with_long(2_000 * USDC, 25_000 * USDC);
        assert!(round_trip(p, 100_000 * USDC, &flat()) <= 100_000 * USDC);
    }

    #[test]
    fn deposit_then_withdraw_with_traders_ahead_prints_nothing() {
        let p = with_long(50_000 * USDC, 10_000 * USDC);
        let up = Marks::flat(PAR * 12 / 10); // traders up $10k
        assert!(round_trip(p, 100_000 * USDC, &up) <= 100_000 * USDC);
    }

    #[test]
    fn deposit_then_withdraw_with_traders_behind_prints_nothing() {
        let p = with_long(50_000 * USDC, 10_000 * USDC);
        let down = Marks::flat(PAR * 9 / 10); // traders down $5k, unrealised
        assert!(round_trip(p, 100_000 * USDC, &down) <= 100_000 * USDC);
    }

    #[test]
    fn deposit_then_withdraw_across_the_slow_mark_gap_prints_nothing() {
        // fast price above the slow one: cards issue high, redeem low
        let p = pool();
        let m = Marks { trade: PAR * 13 / 10, low: PAR, high: PAR * 13 / 10, depth: 0 };
        assert!(round_trip(p, 100_000 * USDC, &m) <= 100_000 * USDC * 13 / 10);
        let out = {
            let mut p = pool();
            let s = p.shares_for(100_000 * USDC, &m).unwrap();
            p.usdc_sleeve += 100_000 * USDC;
            p.clp_supply += s;
            let (u, f) = p.redeem_split(s, &m).unwrap();
            u + p.fraction_value(f, m.trade).unwrap()
        };
        assert!(out <= 100_000 * USDC, "round trip returned {out}");
    }

    #[test]
    fn trader_gains_are_owed_now_and_trader_losses_only_once_realised() {
        let p = with_long(50_000 * USDC, 10_000 * USDC);
        let up = Marks::flat(PAR * 12 / 10);
        let base = p.assets(up.low).unwrap();
        assert_eq!(p.nav_redeem(&up).unwrap(), base - 10_000 * USDC);
        let down = Marks::flat(PAR * 9 / 10);
        assert_eq!(p.nav_redeem(&down).unwrap(), p.assets(down.low).unwrap());
        assert_eq!(p.nav_issue(&down).unwrap(), p.assets(down.high).unwrap() + 5_000 * USDC);
    }

    #[test]
    fn margin_is_not_lp_money() {
        let mut p = pool();
        let before = p.nav(&flat()).unwrap();
        p.margin_held += 5_000 * USDC; // landed in the vault, not the sleeve
        assert_eq!(p.nav(&flat()).unwrap(), before);
        assert_eq!(p.capacity(0).unwrap().cap_solvency, pool().capacity(0).unwrap().cap_solvency);
    }

    #[test]
    fn bad_debt_is_recorded_but_not_counted_twice() {
        let mut p = pool();
        let before = p.nav(&flat()).unwrap();
        p.bad_debt = 640 * USDC;
        assert_eq!(p.nav(&flat()).unwrap(), before);
    }

    #[test]
    fn protocol_fees_are_not_lp_equity() {
        let mut p = pool();
        p.book_fee(1_000 * USDC).unwrap();
        assert_eq!(p.accrued_fees_lp, 750 * USDC);
        assert_eq!(p.accrued_fees_protocol, 250 * USDC);
        assert_eq!(p.usdc_sleeve, 140_750 * USDC, "only the LP share joins the sleeve");
    }

    #[test]
    fn settlement_moves_value_between_margin_sleeve_and_recipient_exactly() {
        let p = with_long(1_000 * USDC, 200 * USDC);
        // close in profit: equity 300, fee 1, paid 299
        let after = p.sleeve_after_settle(200 * USDC, 299 * USDC, USDC).unwrap();
        assert_eq!(after, p.usdc_sleeve - 100 * USDC);
        // close at a loss: equity 50, fee 1, paid 49
        let after = p.sleeve_after_settle(200 * USDC, 49 * USDC, USDC).unwrap();
        assert_eq!(after, p.usdc_sleeve + 150 * USDC);
    }

    #[test]
    fn settlement_refuses_to_pay_what_the_sleeve_lacks() {
        let mut p = pool();
        p.usdc_sleeve = 10 * USDC;
        assert!(p.sleeve_after_settle(0, 11 * USDC, 0).is_err());
    }

    #[test]
    fn an_insolvent_pool_takes_no_deposits() {
        let mut p = with_long(1_000_000 * USDC, 0);
        p.usdc_sleeve = 0;
        p.fraction_balance = 0;
        let crash = Marks::flat(PAR * 2);
        assert!(p.shares_for(1_000 * USDC, &crash).is_err());
    }

    #[test]
    fn the_depth_ceiling_binds_long_before_solvency_does() {
        let p = pool();
        let c = p.capacity(60_000 * USDC).unwrap();
        assert_eq!(c.binding, Binding::Depth);
        assert!(c.cap_depth < c.cap_solvency / 10);
    }

    #[test]
    fn solvency_binds_once_the_amm_is_deep() {
        let p = pool();
        let c = p.capacity(5_000_000 * USDC).unwrap();
        assert_eq!(c.binding, Binding::Solvency);
    }

    #[test]
    fn withdrawals_are_proportional_and_never_usdc_only() {
        let p = pool();
        let shares = p.clp_supply / 10;
        let (usdc, fractions) = p.redeem_split(shares, &flat()).unwrap();
        assert_eq!(usdc, 14_000 * USDC);
        assert_eq!(fractions, 6_000 * USDC);
    }

    #[test]
    fn card_deposits_take_the_haircut() {
        let p = pool();
        assert_eq!(p.haircut_value(1_000 * USDC).unwrap(), 970 * USDC);
    }

    #[test]
    fn the_illiquid_sleeve_cannot_grow_past_its_target() {
        let p = pool();
        assert!(p.require_sleeve_within_target(60_000 * USDC, PAR).is_ok());
        assert!(p.require_sleeve_within_target(70_000 * USDC, PAR).is_err());
    }

    #[test]
    fn the_settlement_haircut_is_equal_for_everyone() {
        // traders up $40k against a $200k pool: everybody leaves with 80%
        let p = with_long(200_000 * USDC, 0);
        let m = Marks::flat(PAR * 12 / 10);
        let (big_usdc, _) = p.redeem_split(p.clp_supply / 2, &m).unwrap();
        let (small_usdc, _) = p.redeem_split(p.clp_supply / 4, &m).unwrap();
        assert!(big_usdc.abs_diff(small_usdc * 2) <= 1);
    }

    #[test]
    fn redeeming_everything_never_pays_out_more_than_exists() {
        let p = pool();
        let (usdc, frac) = p.redeem_split(p.clp_supply, &flat()).unwrap();
        assert!(usdc <= p.usdc_sleeve);
        assert!(frac <= p.fraction_balance);
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
        assert!(!p.state.allows_open() && !p.state.allows_deposit());
        assert!(!p.state.allows_withdraw(), "the normal exit is barred");
        assert!(p.state.allows_close() && p.state.allows_liquidate());
    }

    #[test]
    fn bad_params_are_refused() {
        for mutate in [
            (|p: &mut PoolParams| p.phi = 0) as fn(&mut PoolParams),
            |p: &mut PoolParams| p.delta_max = 0,
            |p: &mut PoolParams| p.mu = 0,
            |p: &mut PoolParams| p.deposit_haircut_bps = 10_000,
            |p: &mut PoolParams| p.card_sleeve_target = 0,
            |p: &mut PoolParams| p.attack_safety = 0,
        ] {
            let mut bad = PoolParams::default();
            mutate(&mut bad);
            assert!(validate_params(&bad).is_err());
        }
        assert!(validate_params(&PoolParams::default()).is_ok());
    }
}
