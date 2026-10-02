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
use slab_interface::{m, r, seeds, MarketState, PoolParams};
use slab_math::{
    assets_for_shares, card_weight, clp_price, mul_wad_floor, nav, proportional_share,
    prorata_haircut, shares_for_deposit, subtract_bps_ceil, to_u64, utilization,
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
        p.trader_pnl = 0;
        p.bad_debt = 0;
        p.accrued_fees_lp = 0;
        p.accrued_fees_protocol = 0;
        p.params = params;
        p.state = MarketState::Active;
        p.bump = ctx.bumps.pool;
        Ok(())
    }

    /// Deposit USDC and receive CLP.
    pub fn deposit_usdc(ctx: Context<DepositUsdc>, amount: u64) -> Result<()> {
        let price = ctx.accounts.price()?;
        let pool = &ctx.accounts.pool;
        require!(pool.state.allows_deposit(), PoolError::StateForbids);
        require!(amount > 0, PoolError::ZeroAmount);

        let shares = pool.shares_for(amount, price)?;
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
    pub fn deposit_fractions(ctx: Context<DepositFractions>, amount: u64) -> Result<()> {
        let price = ctx.accounts.price()?;
        let pool = &ctx.accounts.pool;
        require!(pool.state.allows_deposit(), PoolError::StateForbids);
        require!(amount > 0, PoolError::ZeroAmount);

        let gross = pool.fraction_value(amount, price)?;
        let net = pool.haircut_value(gross)?;
        let shares = pool.shares_for(net, price)?;
        require!(shares > 0, PoolError::DustDeposit);

        // Keeps the pool from becoming a bet on one card, and keeps the
        // illiquid sleeve from swallowing the liquid one.
        let balance_after = pool
            .fraction_balance
            .checked_add(amount)
            .ok_or(PoolError::Overflow)?;
        pool.require_sleeve_within_target(balance_after, price)?;

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

    /// Burn CLP and receive a proportional slice of BOTH sleeves.
    pub fn withdraw(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
        let price = ctx.accounts.price()?;
        let pool = &ctx.accounts.pool;
        require!(pool.state.allows_withdraw(), PoolError::StateForbids);
        require!(shares > 0, PoolError::ZeroAmount);

        let (usdc_out, fractions_out) = pool.withdraw_split(shares)?;
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
            price,
        });
        Ok(())
    }

    /// Settle one position's outcome against the pool. CPI ONLY, from the
    /// registered perp market.
    ///
    /// This is the single door through which value leaves the pool for a
    /// trader. Without it, any program could ask the pool to pay.
    pub fn settle_position(
        ctx: Context<SettlePosition>,
        to_trader: u64,
        fee: u64,
        bad_debt: u64,
        trader_pnl_now: i128,
    ) -> Result<()> {
        require!(
            ctx.accounts.pool.state.allows_close(),
            PoolError::StateForbids
        );
        require!(
            to_trader <= ctx.accounts.pool.usdc_sleeve,
            PoolError::InsufficientLiquidity
        );

        if to_trader > 0 {
            ctx.accounts.pay_trader(to_trader)?;
        }

        let pool = &mut ctx.accounts.pool;
        pool.usdc_sleeve = pool.usdc_sleeve.saturating_sub(to_trader);
        pool.bad_debt = pool.bad_debt.checked_add(bad_debt).ok_or(PoolError::Overflow)?;
        // A SNAPSHOT, not an increment. `perp` recomputes the whole book's
        // unrealized PnL in O(1) and pushes it, so NAV reflects open positions
        // too. An increment would only ever capture realised PnL and would
        // leave NAV wrong for every position still open.
        pool.trader_pnl = trader_pnl_now;
        pool.split_fee(fee)?;

        emit!(PositionSettled {
            pool: pool.key(),
            to_trader,
            fee,
            bad_debt,
            trader_pnl: trader_pnl_now,
        });
        Ok(())
    }

    /// Bind the perp market allowed to touch the pool's risk accounting.
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
    Ok(())
}

// ---------------------------------------------------------------------------
// pool accounting
// ---------------------------------------------------------------------------

impl Pool {
    /// Value of `fractions` at the oracle price, in native USDC.
    pub fn fraction_value(&self, fractions: u64, price: u64) -> Result<u64> {
        m(mul_wad_floor(fractions as u128, price as u128)).and_then(|v| m(to_u64(v)))
    }

    /// The card sleeve marked to the oracle. Never a stored number.
    pub fn card_sleeve_value(&self, price: u64) -> Result<u64> {
        self.fraction_value(self.fraction_balance, price)
    }

    /// `NAV = U + card sleeve - trader PnL - bad debt`
    pub fn nav(&self, price: u64) -> Result<u64> {
        m(nav(
            self.usdc_sleeve,
            self.card_sleeve_value(price)?,
            self.trader_pnl,
            self.bad_debt,
        ))
    }

    pub fn clp_price(&self, price: u64) -> Result<u128> {
        m(clp_price(self.nav(price)?, self.clp_supply))
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

    /// CLP minted for a deposit of `value`. Rounds down.
    pub fn shares_for(&self, value: u64, price: u64) -> Result<u64> {
        m(shares_for_deposit(value, self.nav(price)?, self.clp_supply))
    }

    /// Total value returned for a redemption. Rounds down.
    pub fn assets_for(&self, shares: u64, price: u64) -> Result<u64> {
        m(assets_for_shares(shares, self.nav(price)?, self.clp_supply))
    }

    /// PROPORTIONAL slice of each sleeve. Both sides always leave together.
    pub fn withdraw_split(&self, shares: u64) -> Result<(u64, u64)> {
        let usdc = m(proportional_share(self.usdc_sleeve, shares, self.clp_supply))?;
        let fractions = m(proportional_share(
            self.fraction_balance,
            shares,
            self.clp_supply,
        ))?;
        Ok((usdc, fractions))
    }

    /// Final redemption in `Settled`, with an equal pro-rata haircut.
    pub fn settlement_payout(&self, shares: u64, total_claims: u64, price: u64) -> Result<u64> {
        let claim = self.assets_for(shares, price)?;
        m(prorata_haircut(claim, total_claims, self.usdc_sleeve))
    }

    /// Split a fee between LPs and the protocol. LPs' share stays in the
    /// sleeve, which is what makes CLP appreciate.
    pub fn split_fee(&mut self, fee: u64) -> Result<()> {
        if fee == 0 {
            return Ok(());
        }
        let lp = m(slab_math::mul_div_floor(
            fee as u128,
            self.params.lp_fee_share_bps as u128,
            10_000,
        ))
        .and_then(|v| m(to_u64(v)))?;
        let protocol = fee.saturating_sub(lp);
        self.accrued_fees_lp = self.accrued_fees_lp.checked_add(lp).ok_or(PoolError::Overflow)?;
        self.accrued_fees_protocol = self
            .accrued_fees_protocol
            .checked_add(protocol)
            .ok_or(PoolError::Overflow)?;
        self.usdc_sleeve = self.usdc_sleeve.checked_add(lp).ok_or(PoolError::Overflow)?;
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
    /// The basket's fraction mint. v1 launches a single basket.
    pub fraction_mint: Pubkey,
    pub fraction_vault: Pubkey,
    pub oracle: Pubkey,
    /// The perp market allowed to touch risk accounting.
    pub perp_market: Pubkey,

    /// Liquid sleeve `U`, in native USDC. Winners are paid from here.
    pub usdc_sleeve: u64,
    /// Card sleeve as a TOKEN QUANTITY. Its value is marked at read time.
    pub fraction_balance: u64,
    pub clp_supply: u64,

    /// Net trader PnL, signed. Positive means traders are winning and NAV is
    /// falling. Written by `perp` through `settle_position`.
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

/// Shared account set for anything that has to mark the card sleeve.
macro_rules! oracle_reader {
    ($t:ty) => {
        impl<'info> $t {
            /// Price for marking. Not `require_tradeable`: an LP must be able
            /// to leave even when the market has stopped accepting new risk.
            pub fn price(&self) -> Result<u64> {
                let view = slab_interface::read_oracle(
                    &self.oracle.to_account_info(),
                    &slab_interface::ORACLE_PROGRAM_ID,
                )?;
                let now = Clock::get()?.unix_timestamp;
                view.require_markable(now, 900)
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
pub struct PositionSettled {
    pub pool: Pubkey,
    pub to_trader: u64,
    pub fee: u64,
    pub bad_debt: u64,
    pub trader_pnl: i128,
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
        assert_eq!(p.nav(PAR).unwrap(), 200_000 * USDC);
        assert_eq!(p.clp_price(PAR).unwrap(), WAD);
    }

    #[test]
    fn the_card_sleeve_is_marked_not_stored() {
        // The bug this guards: caching the sleeve's value means every NAV
        // after the next price move is wrong.
        let p = pool();
        let at_par = p.nav(PAR).unwrap();
        let after_drop = p.nav(PAR * 80 / 100).unwrap();
        assert_eq!(at_par - after_drop, 12_000 * USDC, "30% sleeve, 20% drop");
    }

    #[test]
    fn trader_profit_reduces_nav_one_for_one() {
        let mut p = pool();
        let before = p.nav(PAR).unwrap();
        p.trader_pnl = 640 * USDC as i128;
        assert_eq!(before - p.nav(PAR).unwrap(), 640 * USDC);
    }

    #[test]
    fn bad_debt_is_deducted_and_stays_visible() {
        let mut p = pool();
        p.bad_debt = 1_000 * USDC;
        assert_eq!(p.nav(PAR).unwrap(), 199_000 * USDC);
    }

    #[test]
    fn the_depth_ceiling_binds_long_before_solvency_does() {
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
        let (usdc, fractions) = p.withdraw_split(shares).unwrap();
        assert_eq!(usdc, 14_000 * USDC);
        assert_eq!(fractions, 6_000 * USDC);
        // neither sleeve alone covers the claim: that is what stops a run
        assert!(usdc < p.assets_for(shares, PAR).unwrap());
        assert_eq!(
            usdc + p.fraction_value(fractions, PAR).unwrap(),
            p.assets_for(shares, PAR).unwrap()
        );
    }

    #[test]
    fn deposit_then_withdraw_never_prints_value() {
        let mut p = pool();
        let dep = 5_000 * USDC;
        let shares = p.shares_for(dep, PAR).unwrap();
        p.usdc_sleeve += dep;
        p.clp_supply += shares;
        let back = p.assets_for(shares, PAR).unwrap();
        assert!(back <= dep);
        assert!(dep - back <= 1);
    }

    #[test]
    fn card_deposits_take_the_haircut() {
        assert_eq!(pool().haircut_value(1_000 * USDC).unwrap(), 970 * USDC);
    }

    #[test]
    fn the_illiquid_sleeve_cannot_grow_past_its_target() {
        let p = pool();
        // already at 30% of 200k; a further 10k of fractions breaches it
        assert!(p.require_sleeve_within_target(60_000 * USDC, PAR).is_ok());
        assert!(p.require_sleeve_within_target(70_000 * USDC, PAR).is_err());
    }

    #[test]
    fn fees_mostly_go_to_the_lps_and_land_in_the_sleeve() {
        let mut p = pool();
        let before = p.usdc_sleeve;
        p.split_fee(1_000).unwrap();
        assert_eq!(p.accrued_fees_lp, 750);
        assert_eq!(p.accrued_fees_protocol, 250);
        assert_eq!(p.usdc_sleeve - before, 750, "the LP share grows the sleeve");
    }

    #[test]
    fn the_settlement_haircut_is_equal_for_everyone() {
        let mut p = pool();
        p.usdc_sleeve = 70_000 * USDC; // pool holds only 70% of what it owes
        p.fraction_balance = 0;
        let total_claims = 100_000 * USDC;
        let a = p.settlement_payout(p.clp_supply / 2, total_claims, PAR).unwrap();
        let b = p.settlement_payout(p.clp_supply / 4, total_claims, PAR).unwrap();
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
        for mutate in [
            (|p: &mut PoolParams| p.phi = 0) as fn(&mut PoolParams),
            |p: &mut PoolParams| p.delta_max = 0,
            |p: &mut PoolParams| p.mu = 0,
            |p: &mut PoolParams| p.deposit_haircut_bps = 10_000,
            |p: &mut PoolParams| p.card_sleeve_target = 0,
        ] {
            let mut bad = PoolParams::default();
            mutate(&mut bad);
            assert!(validate_params(&bad).is_err());
        }
        assert!(validate_params(&PoolParams::default()).is_ok());
    }
}
