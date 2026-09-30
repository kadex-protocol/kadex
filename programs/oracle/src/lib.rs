//! Programa `oracle` — DONO: Backend A.
//!
//! Le as reservas de um pool AMM externo de fracoes/USDC, calcula TWAP,
//! aplica clamp por tick, confere profundidade e divergencia, e publica um
//! preco unico que o resto do protocolo consome.
//!
//! O que este programa NAO faz, de proposito:
//!
//! - nao assina nada com chave off-chain: `refresh_price` e permissionless e
//!   recalcula a partir de estado on-chain, entao nao existe "chave do
//!   oraculo" para ser roubada
//! - nao usa fills externos como fonte de preco: eles entram so como limite
//!   de sanidade (`external_median`), conforme o spec
//!
//! A conta publicada (`slab_interface::OracleAccount`) e a INTERFACE
//! CONGELADA com o Backend B.

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

    /// Cria o oraculo de uma cesta. So o admin chama, uma vez.
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

    /// Le o AMM e republica o preco. PERMISSIONLESS: qualquer um pode chamar,
    /// e e por isso que nao existe uma chave privilegiada de oraculo aqui.
    ///
    /// Ordem das defesas (cada uma barra um ataque diferente):
    ///
    /// 1. le reservas -> spot
    /// 2. grava observacao -> TWAP da janela
    /// 3. clamp por tick sobre o preco anterior -> barra salto de bloco unico
    /// 4. profundidade minima -> barra sacar liquidez pra deixar o oraculo barato
    /// 5. divergencia contra mediana externa -> barra manipulacao sustentada
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

        // ---- observacao + TWAP ----
        push_observation(o, spot, now);
        let twap = compute_twap(o, now)?;
        o.twap = twap;

        // ---- clamp por tick ----
        // O preco oficial nunca anda mais que `max_tick_move` por atualizacao.
        // Isso nao impede manipulacao lenta; encarece e mata a versao
        // instantanea e lucrativa dela.
        let previous = o.price;
        o.price = if previous == 0 {
            twap // primeira publicacao: nada de que se defender ainda
        } else {
            clamp_move(previous, twap, o.params.max_tick_move)?
        };

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

    /// Publica a mediana de fills externos, que e apenas o limite de sanidade.
    ///
    /// Se esta alimentacao falhar, o mercado perde UMA defesa e continua
    /// funcionando com preco do AMM. Ela nunca vira fonte de preco.
    pub fn set_external_median(ctx: Context<SetExternal>, median: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let o = &mut ctx.accounts.oracle;
        o.external_median = median;
        o.external_ts = now;
        o.state = evaluate_state(o, now)?;
        Ok(())
    }

    /// Troca parametros de risco do oraculo. So o admin.
    pub fn set_params(ctx: Context<SetParams>, params: OracleParams) -> Result<()> {
        require!(params.twap_window_secs > 0, OracleError::BadParams);
        require!(params.max_tick_move > 0, OracleError::BadParams);
        require!(params.max_staleness_secs > 0, OracleError::BadParams);
        ctx.accounts.oracle.params = params;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// logica pura — testavel sem validador
// ---------------------------------------------------------------------------

/// Guarda a leitura no buffer circular.
pub fn push_observation(o: &mut OracleAccount, price: u64, ts: i64) {
    let head = o.obs_head as usize % ORACLE_OBSERVATIONS;
    o.observations[head] = Observation { price, ts };
    o.obs_head = ((head + 1) % ORACLE_OBSERVATIONS) as u8;
    if (o.obs_len as usize) < ORACLE_OBSERVATIONS {
        o.obs_len += 1;
    }
}

/// Media das observacoes dentro da janela. Se nenhuma observacao estiver na
/// janela, cai para a mais recente — nunca retorna zero com dados presentes.
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

/// Limita o movimento do preco publicado a `max_move_wad` por atualizacao.
pub fn clamp_move(previous: u64, target: u64, max_move_wad: u64) -> Result<u64> {
    let delta = m(mul_wad_floor(previous as u128, max_move_wad as u128))?;
    let hi = (previous as u128).saturating_add(delta);
    let lo = (previous as u128).saturating_sub(delta);
    let clamped = (target as u128).clamp(lo, hi);
    u64::try_from(clamped).map_err(|_| error!(OracleError::PriceOverflow))
}

/// Decide o estado do oraculo a partir das tres defesas.
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
    // Divergencia so vale se existe uma mediana externa recente. Sem ela, o
    // mercado segue com uma defesa a menos, nao parado.
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
// contas
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: identificador da cesta; serve so como seed e rotulo.
    pub basket: UncheckedAccount<'info>,
    /// CHECK: pool AMM externo. Validado pelo adaptador em `refresh_price`.
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
    /// Permissionless de proposito: qualquer keeper serve, e se o nosso cair
    /// outra pessoa mantem o preco vivo.
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [seeds::ORACLE, oracle.basket.as_ref()],
        bump = oracle.bump,
        has_one = amm_pool @ OracleError::WrongAmmPool,
    )]
    pub oracle: Account<'info, OracleAccount>,
    /// CHECK: desserializado pelo adaptador conforme `oracle.adapter`.
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
// testes de logica pura (sem validador, rodam em `cargo test`)
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
        // alvo 50% acima, clamp de 5% -> so anda 5%
        assert_eq!(clamp_move(prev, prev * 3 / 2, 50_000).unwrap(), 1_050_000);
        // para baixo tambem
        assert_eq!(clamp_move(prev, prev / 2, 50_000).unwrap(), 950_000);
        // movimento pequeno passa inteiro
        assert_eq!(clamp_move(prev, 1_010_000, 50_000).unwrap(), 1_010_000);
    }

    #[test]
    fn clamp_reaches_the_target_over_repeated_updates() {
        // manipulacao nao fica impossivel, fica cara: sao varias atualizacoes
        let mut p = WAD as u64;
        let target = (WAD as u64) * 3 / 2;
        let mut steps = 0;
        while p < target && steps < 100 {
            p = clamp_move(p, target, 50_000).unwrap();
            steps += 1;
        }
        assert!(steps >= 8, "deveria exigir varias atualizacoes, foram {steps}");
        assert!(p >= target - 1);
    }

    #[test]
    fn twap_averages_only_inside_the_window() {
        let mut o = fresh();
        let now = 10_000i64;
        push_observation(&mut o, 1_000_000, now - 100);
        push_observation(&mut o, 1_200_000, now - 200);
        // fora da janela de 1800s: nao entra na media
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

        // 10% de diferenca: dentro do limite de 15%
        o.external_median = 909_091;
        assert_eq!(evaluate_state(&o, 1_010).unwrap(), OracleState::Ok);

        // 25% de diferenca: estoura
        o.external_median = 800_000;
        assert_eq!(evaluate_state(&o, 1_010).unwrap(), OracleState::Diverged);
    }

    #[test]
    fn missing_external_feed_degrades_instead_of_halting() {
        let mut o = fresh();
        o.price = WAD as u64;
        o.last_update_ts = 1_000;
        o.external_median = 0; // nunca alimentado
        assert_eq!(
            evaluate_state(&o, 1_010).unwrap(),
            OracleState::Ok,
            "sem feed externo o mercado perde uma defesa, nao para"
        );
    }

    #[test]
    fn uninitialized_until_the_first_price() {
        assert_eq!(evaluate_state(&fresh(), 1).unwrap(), OracleState::Uninitialized);
    }
}
