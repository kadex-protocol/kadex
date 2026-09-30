//! Programa `clp-pool` — DONO: Backend B.
//!
//! O pool e a contraparte de todo trade. Ele carrega duas mangas com funcoes
//! separadas, e uma NUNCA faz o trabalho da outra:
//!
//! - manga USDC (`usdc_sleeve`): paga trader vencedor, saque e liquidacao
//! - manga de cards (`card_sleeve_value`): da o beta e o retorno do LP
//!
//! A manga de cards nunca paga trader vencedor. E por isso que o teto de OI
//! olha para `usdc_sleeve`, e nao para o NAV total.
//!
//! Saque e SEMPRE proporcional nas duas mangas. Nao existe caminho de saque so
//! em USDC: se existisse, os primeiros levariam o liquido e os ultimos
//! ficariam com a manga iliquida inteira.

use anchor_lang::prelude::*;
use slab_interface::{m, seeds, MarketState, PoolParams};
use slab_math::{
    assets_for_shares, card_weight, clp_price, nav, oi_allowed, oi_cap_depth, oi_cap_solvency,
    proportional_share, prorata_haircut, shares_for_deposit, subtract_bps_ceil, utilization,
};

declare_id!("3XZkAqLeQDoNXD6Bb9YoGSEdnvqk9r7UMgrKsN5x3L9v");

pub mod errors;
use errors::PoolError;

#[program]
pub mod clp_pool {
    use super::*;

    /// Cria o pool. Uma vez, pelo admin.
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

    /// Amarra o mercado de perp que pode mexer na contabilidade do pool.
    /// Depois disso, so esse PDA assina movimentos de risco.
    pub fn set_perp_market(ctx: Context<AdminOnly>, market: Pubkey) -> Result<()> {
        ctx.accounts.pool.perp_market = market;
        Ok(())
    }

    /// Troca os parametros economicos. Eles vivem SO aqui.
    pub fn set_params(ctx: Context<AdminOnly>, params: PoolParams) -> Result<()> {
        validate_params(&params)?;
        ctx.accounts.pool.params = params;
        Ok(())
    }

    /// Transicao explicita de estado. Deterministica e testavel.
    ///
    /// Nao permite voltar de `Settled`: uma vez encerrado, encerrado.
    pub fn set_state(ctx: Context<AdminOnly>, next: MarketState) -> Result<()> {
        let p = &mut ctx.accounts.pool;
        require!(p.state != MarketState::Settled, PoolError::AlreadySettled);
        p.state = next;
        emit!(StateChanged { pool: p.key(), state: next });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// logica pura — o coracao das invariantes, testavel sem validador
// ---------------------------------------------------------------------------

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

impl Pool {
    /// NAV = U + valor_da_manga_de_cards - PnL_dos_traders - bad_debt
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

    /// Teto de OI pela solvencia da manga liquida.
    pub fn cap_solvency(&self) -> Result<u64> {
        m(oi_cap_solvency(
            self.usdc_sleeve,
            self.params.phi as u128,
            self.params.delta_max as u128,
        ))
    }

    /// Teto de OI pela profundidade do AMM, vinda do oraculo.
    pub fn cap_depth(&self, oracle_depth: u64) -> Result<u64> {
        m(oi_cap_depth(
            oracle_depth,
            self.params.delta_liq as u128,
            self.params.mu as u128,
        ))
    }

    /// O TETO QUE VALE. Sempre o menor dos dois, nunca a media, nunca o maior.
    pub fn oi_allowed(&self, oracle_depth: u64) -> Result<u64> {
        Ok(oi_allowed(self.cap_solvency()?, self.cap_depth(oracle_depth)?))
    }

    /// Checa a invariante de solvencia antes de aceitar risco novo.
    pub fn require_capacity(&self, oi_after: u64, oracle_depth: u64) -> Result<()> {
        let cap = self.oi_allowed(oracle_depth)?;
        require!(oi_after <= cap, PoolError::CapacityExceeded);
        Ok(())
    }

    /// Utilizacao em WAD contra o teto vigente.
    pub fn utilization(&self, oi_total: u64, oracle_depth: u64) -> Result<u128> {
        m(utilization(oi_total, self.oi_allowed(oracle_depth)?))
    }

    /// Valor efetivo de um deposito de fracao depois do haircut.
    pub fn haircut_value(&self, gross_value: u64) -> Result<u64> {
        let net = m(subtract_bps_ceil(
            gross_value as u128,
            self.params.deposit_haircut_bps as u128,
        ))?;
        m(slab_math::to_u64(net))
    }

    /// Teto de peso de um card dentro da manga. Impede o pool virar aposta
    /// num card so.
    pub fn require_card_weight(&self, card_value_after: u64, sleeve_after: u64) -> Result<()> {
        let w = m(card_weight(card_value_after, sleeve_after))?;
        require!(
            w <= self.params.max_card_weight as u128,
            PoolError::CardWeightExceeded
        );
        Ok(())
    }

    /// CLP mintado por um deposito. Arredonda para baixo.
    pub fn shares_for(&self, value: u64) -> Result<u64> {
        m(shares_for_deposit(value, self.nav()?, self.clp_supply))
    }

    /// Valor total devolvido por um resgate.
    pub fn assets_for(&self, shares: u64) -> Result<u64> {
        m(assets_for_shares(shares, self.nav()?, self.clp_supply))
    }

    /// Fatia PROPORCIONAL de cada manga num resgate. As duas pontas saem
    /// juntas, sempre.
    pub fn withdraw_split(&self, shares: u64) -> Result<(u64, u64)> {
        let usdc = m(proportional_share(self.usdc_sleeve, shares, self.clp_supply))?;
        let cards = m(proportional_share(
            self.card_sleeve_value,
            shares,
            self.clp_supply,
        ))?;
        Ok((usdc, cards))
    }

    /// Resgate final em `Settled`, com haircut pro-rata igual para todos.
    pub fn settlement_payout(&self, shares: u64, total_claims: u64) -> Result<u64> {
        let claim = self.assets_for(shares)?;
        m(prorata_haircut(claim, total_claims, self.usdc_sleeve))
    }
}

// ---------------------------------------------------------------------------
// contas
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub clp_mint: Pubkey,
    pub usdc_vault: Pubkey,
    pub oracle: Pubkey,
    /// Mercado de perp autorizado a mexer na contabilidade de risco.
    pub perp_market: Pubkey,

    /// Manga liquida `U`, em USDC nativo. E dela que sai pagamento a trader.
    pub usdc_sleeve: u64,
    /// Valor marcado da manga de cards, em USDC nativo.
    pub card_sleeve_value: u64,
    pub clp_supply: u64,

    /// PnL liquido dos traders, com sinal. Positivo = traders ganhando =
    /// NAV caindo. Atualizado pelo programa `perp`.
    pub trader_pnl: i128,
    /// Prejuizo ja realizado que o pool absorveu. VISIVEL de proposito.
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
    /// CHECK: mint de USDC, validado fora do escopo do dia 1.
    pub usdc_mint: UncheckedAccount<'info>,
    /// CHECK: mint do CLP, criado pelo admin.
    pub clp_mint: UncheckedAccount<'info>,
    /// CHECK: conta de token que guarda a manga liquida.
    pub usdc_vault: UncheckedAccount<'info>,
    /// CHECK: conta do oraculo; validada por dono em cada leitura.
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
// testes
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use slab_math::WAD;

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
    fn bad_debt_is_deducted_and_visible() {
        let mut p = pool();
        p.bad_debt = 1_000 * USDC;
        assert_eq!(p.nav().unwrap(), 199_000 * USDC);
    }

    #[test]
    fn depth_cap_binds_far_before_solvency_cap() {
        // Este e o achado que o simulador mostrou: com os parametros do spec,
        // e a profundidade do AMM que define o tamanho do mercado, nao o CLP.
        let p = pool();
        let depth = 60_000 * USDC;
        let solv = p.cap_solvency().unwrap();
        let dep = p.cap_depth(depth).unwrap();
        assert_eq!(solv / USDC, 233_333);
        assert_eq!(dep / USDC, 17_944);
        assert_eq!(p.oi_allowed(depth).unwrap(), dep, "o menor teto manda");
    }

    #[test]
    fn solvency_cap_binds_when_the_amm_is_deep() {
        let p = pool();
        let deep = 5_000_000 * USDC;
        assert_eq!(p.oi_allowed(deep).unwrap(), p.cap_solvency().unwrap());
    }

    #[test]
    fn opening_beyond_the_lower_cap_is_refused() {
        let p = pool();
        let depth = 60_000 * USDC;
        let cap = p.oi_allowed(depth).unwrap();
        assert!(p.require_capacity(cap, depth).is_ok(), "no teto ainda passa");
        assert!(
            p.require_capacity(cap + 1, depth).is_err(),
            "um centavo acima do teto tem que ser recusado"
        );
    }

    #[test]
    fn withdraw_is_proportional_and_never_usdc_only() {
        let p = pool();
        let shares = p.clp_supply / 10;
        let (usdc, cards) = p.withdraw_split(shares).unwrap();
        assert_eq!(usdc, 14_000 * USDC);
        assert_eq!(cards, 6_000 * USDC);
        // nenhuma manga sozinha cobre o resgate: e isso que impede corrida
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
    fn haircut_is_applied_to_card_deposits() {
        let p = pool();
        // 3% sobre 1000 USDC
        assert_eq!(p.haircut_value(1_000 * USDC).unwrap(), 970 * USDC);
    }

    #[test]
    fn a_single_card_cannot_dominate_the_sleeve() {
        let p = pool();
        // 15% exatos passam
        assert!(p.require_card_weight(15, 100).is_ok());
        // 16% estoura
        assert!(p.require_card_weight(16, 100).is_err());
    }

    #[test]
    fn settlement_haircut_is_equal_for_everyone() {
        let mut p = pool();
        // pool so tem 70% do que deve
        p.usdc_sleeve = 70_000 * USDC;
        p.card_sleeve_value = 0;
        let total_claims = 100_000 * USDC;
        let a = p.settlement_payout(p.clp_supply / 2, total_claims).unwrap();
        let b = p.settlement_payout(p.clp_supply / 4, total_claims).unwrap();
        // quem tem o dobro de cotas recebe o dobro, ambos com o mesmo corte
        assert!(a > 0 && b > 0);
        assert!((a as i128 - 2 * b as i128).abs() <= 2);
    }

    #[test]
    fn state_machine_gates_match_the_spec() {
        let mut p = pool();
        assert!(p.state.allows_open() && p.state.allows_withdraw());
        p.state = MarketState::ReduceOnly;
        assert!(!p.state.allows_open(), "ReduceOnly nao abre risco");
        assert!(!p.state.allows_withdraw(), "resgate trava em ReduceOnly");
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
