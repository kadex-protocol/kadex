//! Programa `card-vault` — DONO: Backend A.
//!
//! Trava o NFT de um card graded tokenizado e minta fracoes SPL fungiveis
//! contra ele. Resgatar exige devolver TODAS as fracoes daquele card.
//!
//! Invariante central: `fracoes_em_circulacao == fractions_per_card` enquanto
//! o NFT estiver travado, e `0` depois do resgate. O supply nunca sai disso.
//!
//! Este programa NAO sabe o que e preco, pool ou posicao. Ele so converte
//! NFT em fracao e de volta.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};
use slab_interface::seeds;

declare_id!("J8Tef8N4YSfVwAxpBemCZrz3qCxehTeb2cd1jTwoBczW");

pub mod errors;
use errors::VaultError;

/// Casas decimais das fracoes.
///
/// ESCOLHA DO DIA 1, e ela e irreversivel depois do primeiro mint: 6 casas,
/// igual ao USDC. Isso faz `preco = reserva_usdc / reserva_fracao` cair
/// direto em WAD sem conversao, que e exatamente o que o oraculo assume.
/// Mudar aqui quebra o oraculo silenciosamente.
pub const FRACTION_DECIMALS: u8 = 6;

/// Quantas fracoes um card vale por dolar de valor de referencia.
/// 1 fracao = $1 no momento do deposito, entao um card de $1.420 vira
/// 1.420 * 10^6 unidades nativas.
pub const FRACTIONS_PER_USD: u64 = 1_000_000;

#[program]
pub mod card_vault {
    use super::*;

    /// Cria o registro global. Uma vez, pelo admin.
    pub fn initialize_registry(ctx: Context<InitializeRegistry>) -> Result<()> {
        let r = &mut ctx.accounts.registry;
        r.admin = ctx.accounts.admin.key();
        r.card_count = 0;
        r.bump = ctx.bumps.registry;
        Ok(())
    }

    /// Coloca um mint de NFT na whitelist e fixa quantas fracoes ele gera.
    ///
    /// Whitelist e defesa, nao burocracia: sem ela qualquer um deposita o card
    /// mais ilegal de vender e saca CLP liquido.
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

        ctx.accounts.registry.card_count =
            ctx.accounts.registry.card_count.saturating_add(1);
        Ok(())
    }

    /// Trava o NFT e minta as fracoes para o depositante.
    pub fn fractionalize(ctx: Context<Fractionalize>) -> Result<()> {
        let card = &ctx.accounts.card;
        require!(card.enabled, VaultError::CardDisabled);

        let vault = &mut ctx.accounts.vault;
        require!(!vault.locked, VaultError::AlreadyLocked);

        // 1) NFT do depositante -> escrow do programa
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

        // 2) minta exatamente `fractions_per_card`, nunca outro numero
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

    /// Queima TODAS as fracoes e devolve o NFT.
    ///
    /// Nao existe resgate parcial: metade das fracoes nao te da meio card.
    pub fn redeem_card(ctx: Context<RedeemCard>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(vault.locked, VaultError::NotLocked);
        require!(
            ctx.accounts.redeemer_fractions.amount >= vault.fractions_minted,
            VaultError::InsufficientFractions
        );

        // 1) queima o supply inteiro
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

        // 2) devolve o NFT
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

    /// Desliga um card sem apagar o registro. Card desligado nao aceita novo
    /// `fractionalize`, mas quem ja tem fracao continua podendo resgatar.
    pub fn set_card_enabled(ctx: Context<SetCardEnabled>, enabled: bool) -> Result<()> {
        ctx.accounts.card.enabled = enabled;
        Ok(())
    }
}

/// Converte valor em dolares (6 casas) para quantidade de fracoes.
pub fn fractions_for_value(value_usdc: u64) -> Option<u64> {
    // 1 fracao = $1, ambos com 6 casas -> relacao 1:1 em unidades nativas
    Some(value_usdc)
}

// ---------------------------------------------------------------------------
// contas
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
    /// Supply fixo de fracoes deste card. Escolhido no whitelist e imutavel.
    pub fractions_per_card: u64,
    /// Peso do card no indice da cesta, em bps.
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
        // O oraculo calcula preco = reserva_usdc / reserva_fracao e espera o
        // resultado em WAD (1e6). Isso so vale com as duas pontas em 6 casas.
        assert_eq!(FRACTION_DECIMALS, 6);
        assert_eq!(FRACTIONS_PER_USD, slab_math::WAD as u64);
    }

    #[test]
    fn value_maps_one_to_one_into_fractions() {
        // card de $1.420 -> 1.420 fracoes, ambos com 6 casas
        assert_eq!(fractions_for_value(1_420_000_000).unwrap(), 1_420_000_000);
    }
}
