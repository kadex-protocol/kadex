//! Program `card-vault` — OWNER: Backend A.
//!
//! Locks the NFT of a tokenized graded card and mints fungible SPL fractions
//! against it. Redeeming requires returning ALL of that card's fractions.
//!
//! Core invariant: `fractions_outstanding == fractions_per_card` while the NFT
//! is locked, and `0` after redemption. Supply never leaves that.
//!
//! This program knows nothing about price, pools or positions. It only
//! converts an NFT into fractions and back.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};
use slab_interface::seeds;

declare_id!("J8Tef8N4YSfVwAxpBemCZrz3qCxehTeb2cd1jTwoBczW");

pub mod errors;
use errors::VaultError;

/// Decimal places of the fractions.
///
/// A DAY-1 CHOICE, and irreversible after the first mint: 6 places, same as
/// USDC. That makes `price = usdc_reserve / fraction_reserve` land directly
/// in WAD with no conversion, which is exactly what the oracle assumes.
/// Changing this breaks the oracle silently.
pub const FRACTION_DECIMALS: u8 = 6;

/// How many fractions a card is worth per dollar of reference value.
/// 1 fraction = $1 at deposit time, so a $1,420 card becomes
/// 1,420 * 10^6 native units.
pub const FRACTIONS_PER_USD: u64 = 1_000_000;

#[program]
pub mod card_vault {
    use super::*;

    /// Create the global registry. Once, by the admin.
    pub fn initialize_registry(ctx: Context<InitializeRegistry>) -> Result<()> {
        let r = &mut ctx.accounts.registry;
        r.admin = ctx.accounts.admin.key();
        r.card_count = 0;
        r.bump = ctx.bumps.registry;
        Ok(())
    }

    /// Whitelist an NFT mint and fix how many fractions it produces.
    ///
    /// The whitelist is a defence, not paperwork: without it anyone could
    /// deposit the least sellable card they own and withdraw liquid CLP.
    pub fn whitelist_card(
        ctx: Context<WhitelistCard>,
        fractions_per_card: u64,
        weight_bps: u16,
    ) -> Result<()> {
        require!(fractions_per_card > 0, VaultError::ZeroFractions);
        require!(weight_bps > 0 && weight_bps <= 10_000, VaultError::BadWeight);

        let c = &mut ctx.accounts.card;
        c.nft_mint = ctx.accounts.nft_mint.key();
        c.fraction_mint = ctx.accounts.fraction_mint.key();
        c.fractions_per_card = fractions_per_card;
        c.weight_bps = weight_bps;
        c.enabled = true;
        c.bump = ctx.bumps.card;

        // The vault account is created here, so it is filled in here. Leaving
        // it zeroed until `fractionalize` meant `vault.bump` was 0, and every
        // later `bump = vault.bump` constraint re-derived a DIFFERENT address
        // — so no card could ever be deposited. Identity and bump belong to
        // the account from birth; only custody state changes later.
        let v = &mut ctx.accounts.vault;
        v.nft_mint = ctx.accounts.nft_mint.key();
        v.fraction_mint = ctx.accounts.fraction_mint.key();
        v.fractions_minted = 0;
        v.locked = false;
        v.bump = ctx.bumps.vault;

        ctx.accounts.registry.card_count =
            ctx.accounts.registry.card_count.saturating_add(1);
        Ok(())
    }

    /// Lock the NFT and mint the fractions to the depositor.
    pub fn fractionalize(ctx: Context<Fractionalize>) -> Result<()> {
        let card = &ctx.accounts.card;
        require!(card.enabled, VaultError::CardDisabled);

        let vault = &mut ctx.accounts.vault;
        require!(!vault.locked, VaultError::AlreadyLocked);

        // 1) depositor's NFT -> program escrow
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.depositor_nft.to_account_info(),
                    to: ctx.accounts.nft_escrow.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            1,
        )?;

        // 2) mint exactly `fractions_per_card`, never another number
        let nft_key = ctx.accounts.nft_mint.key();
        let signer_seeds: &[&[&[u8]]] =
            &[&[seeds::VAULT, nft_key.as_ref(), &[vault.bump]]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.fraction_mint.to_account_info(),
                    to: ctx.accounts.depositor_fractions.to_account_info(),
                    authority: vault.to_account_info(),
                },
                signer_seeds,
            ),
            card.fractions_per_card,
        )?;

        vault.nft_mint = nft_key;
        vault.fraction_mint = ctx.accounts.fraction_mint.key();
        vault.depositor = ctx.accounts.depositor.key();
        vault.fractions_minted = card.fractions_per_card;
        vault.locked = true;

        emit!(CardFractionalized {
            nft_mint: nft_key,
            depositor: vault.depositor,
            fractions: vault.fractions_minted,
        });
        Ok(())
    }

    /// Burn ALL fractions and return the NFT.
    ///
    /// There is no partial redemption: half the fractions do not buy half a card.
    pub fn redeem_card(ctx: Context<RedeemCard>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(vault.locked, VaultError::NotLocked);
        require!(
            ctx.accounts.redeemer_fractions.amount >= vault.fractions_minted,
            VaultError::InsufficientFractions
        );

        // 1) burn the entire supply
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.fraction_mint.to_account_info(),
                    from: ctx.accounts.redeemer_fractions.to_account_info(),
                    authority: ctx.accounts.redeemer.to_account_info(),
                },
            ),
            vault.fractions_minted,
        )?;

        // 2) return the NFT
        let nft_key = ctx.accounts.nft_mint.key();
        let signer_seeds: &[&[&[u8]]] =
            &[&[seeds::VAULT, nft_key.as_ref(), &[vault.bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.nft_escrow.to_account_info(),
                    to: ctx.accounts.redeemer_nft.to_account_info(),
                    authority: vault.to_account_info(),
                },
                signer_seeds,
            ),
            1,
        )?;

        vault.fractions_minted = 0;
        vault.locked = false;

        emit!(CardRedeemed {
            nft_mint: nft_key,
            redeemer: ctx.accounts.redeemer.key(),
        });
        Ok(())
    }

    /// Disable a card without deleting its record. A disabled card accepts no
    /// new `fractionalize`, but existing holders can still redeem.
    pub fn set_card_enabled(ctx: Context<SetCardEnabled>, enabled: bool) -> Result<()> {
        ctx.accounts.card.enabled = enabled;
        Ok(())
    }
}

/// Convert a dollar value (6 decimals) into a fraction amount.
pub fn fractions_for_value(value_usdc: u64) -> Option<u64> {
    // 1 fraction = $1, both with 6 decimals -> 1:1 in native units
    Some(value_usdc)
}

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Registry {
    pub admin: Pubkey,
    pub card_count: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct WhitelistedCard {
    pub nft_mint: Pubkey,
    pub fraction_mint: Pubkey,
    /// Fixed fraction supply for this card. Chosen at whitelist time, immutable.
    pub fractions_per_card: u64,
    /// The card's weight in the basket index, in bps.
    pub weight_bps: u16,
    pub enabled: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct VaultedCard {
    pub nft_mint: Pubkey,
    pub fraction_mint: Pubkey,
    pub depositor: Pubkey,
    pub fractions_minted: u64,
    pub locked: bool,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitializeRegistry<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init, payer = admin, space = 8 + Registry::INIT_SPACE,
        seeds = [seeds::REGISTRY], bump
    )]
    pub registry: Account<'info, Registry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WhitelistCard<'info> {
    #[account(mut, address = registry.admin @ VaultError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [seeds::REGISTRY], bump = registry.bump)]
    pub registry: Account<'info, Registry>,
    pub nft_mint: Account<'info, Mint>,
    #[account(
        init, payer = admin,
        seeds = [seeds::FRACTION_MINT, nft_mint.key().as_ref()], bump,
        mint::decimals = FRACTION_DECIMALS,
        mint::authority = vault,
    )]
    pub fraction_mint: Account<'info, Mint>,
    #[account(
        init, payer = admin, space = 8 + VaultedCard::INIT_SPACE,
        seeds = [seeds::VAULT, nft_mint.key().as_ref()], bump
    )]
    pub vault: Account<'info, VaultedCard>,
    #[account(
        init, payer = admin, space = 8 + WhitelistedCard::INIT_SPACE,
        seeds = [seeds::CARD, nft_mint.key().as_ref()], bump
    )]
    pub card: Account<'info, WhitelistedCard>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Fractionalize<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    pub nft_mint: Account<'info, Mint>,
    #[account(
        seeds = [seeds::CARD, nft_mint.key().as_ref()], bump = card.bump,
        has_one = nft_mint @ VaultError::WrongCard,
        has_one = fraction_mint @ VaultError::WrongFractionMint,
    )]
    pub card: Account<'info, WhitelistedCard>,
    #[account(
        mut,
        seeds = [seeds::VAULT, nft_mint.key().as_ref()], bump = vault.bump,
    )]
    pub vault: Account<'info, VaultedCard>,
    #[account(mut)]
    pub fraction_mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = depositor_nft.mint == nft_mint.key() @ VaultError::WrongCard,
        constraint = depositor_nft.owner == depositor.key() @ VaultError::NotOwner,
        constraint = depositor_nft.amount == 1 @ VaultError::NotAnNft,
    )]
    pub depositor_nft: Account<'info, TokenAccount>,
    #[account(
        init_if_needed, payer = depositor,
        seeds = [seeds::NFT_ESCROW, nft_mint.key().as_ref()], bump,
        token::mint = nft_mint,
        token::authority = vault,
    )]
    pub nft_escrow: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = depositor_fractions.mint == fraction_mint.key() @ VaultError::WrongFractionMint,
        constraint = depositor_fractions.owner == depositor.key() @ VaultError::NotOwner,
    )]
    pub depositor_fractions: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct RedeemCard<'info> {
    #[account(mut)]
    pub redeemer: Signer<'info>,
    pub nft_mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [seeds::VAULT, nft_mint.key().as_ref()], bump = vault.bump,
        has_one = nft_mint @ VaultError::WrongCard,
        has_one = fraction_mint @ VaultError::WrongFractionMint,
    )]
    pub vault: Account<'info, VaultedCard>,
    #[account(mut)]
    pub fraction_mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = redeemer_fractions.mint == fraction_mint.key() @ VaultError::WrongFractionMint,
        constraint = redeemer_fractions.owner == redeemer.key() @ VaultError::NotOwner,
    )]
    pub redeemer_fractions: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [seeds::NFT_ESCROW, nft_mint.key().as_ref()], bump,
    )]
    pub nft_escrow: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = redeemer_nft.mint == nft_mint.key() @ VaultError::WrongCard,
    )]
    pub redeemer_nft: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetCardEnabled<'info> {
    #[account(address = registry.admin @ VaultError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(seeds = [seeds::REGISTRY], bump = registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(mut, seeds = [seeds::CARD, card.nft_mint.as_ref()], bump = card.bump)]
    pub card: Account<'info, WhitelistedCard>,
}

#[event]
pub struct CardFractionalized {
    pub nft_mint: Pubkey,
    pub depositor: Pubkey,
    pub fractions: u64,
}

#[event]
pub struct CardRedeemed {
    pub nft_mint: Pubkey,
    pub redeemer: Pubkey,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fraction_decimals_must_match_usdc_or_the_oracle_breaks() {
        // The oracle computes price = usdc_reserve / fraction_reserve and
        // expects WAD (1e6). That only holds with both sides at 6 decimals.
        assert_eq!(FRACTION_DECIMALS, 6);
        assert_eq!(FRACTIONS_PER_USD, slab_math::WAD as u64);
    }

    #[test]
    fn value_maps_one_to_one_into_fractions() {
        // a $1,420 card -> 1,420 fractions, both at 6 decimals
        assert_eq!(fractions_for_value(1_420_000_000).unwrap(), 1_420_000_000);
    }
}
