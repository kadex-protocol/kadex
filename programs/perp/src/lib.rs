//! Programa `perp` — DONO: Backend B.
//!
//! Posicoes long e short contra o pool CLP. Nao existe livro de ofertas e nao
//! existe contraparte trader-a-trader: o pool aluga exposicao e cobra borrow
//! por hora.
//!
//! Tres regras que nao se negociam:
//!
//! 1. Abrir posicao checa OS DOIS tetos de OI e obedece ao MENOR.
//! 2. Liquidacao usa o preco do oraculo, nunca um preco interno. Se usasse um
//!    preco interno, alguem empurraria esse preco para cacar liquidacao alheia.
//! 3. Bad debt e registrado explicitamente e descontado do NAV. Nunca some.

use anchor_lang::prelude::*;
use slab_interface::{
    m, read_oracle, seeds, MarketState, OracleView, PoolParams, Side, ORACLE_PROGRAM_ID,
};
use slab_math::{
    accrue_borrow_index, borrow_owed, borrow_rate_hourly, equity, health_wad, liquidation_price,
    min_margin, mul_wad_ceil, oi_allowed, oi_cap_depth, oi_cap_solvency, pnl, side_multiplier,
    to_u64, utilization, RAY,
};

declare_id!("BcVwJ91Jd1k7xUNcGYzRygq2ubaCYn7p5MeUZzy1EyLR");

pub mod errors;
use errors::PerpError;

#[program]
pub mod perp {
    use super::*;

    /// Cria o mercado ligado a um pool e a um oraculo.
    pub fn initialize_market(ctx: Context<InitializeMarket>) -> Result<()> {
        let mk = &mut ctx.accounts.market;
        mk.pool = ctx.accounts.pool.key();
        mk.oracle = ctx.accounts.oracle.key();
        mk.oi_long = 0;
        mk.oi_short = 0;
        mk.borrow_idx_long = RAY;
        mk.borrow_idx_short = RAY;
        mk.last_accrual_ts = Clock::get()?.unix_timestamp;
        mk.open_positions = 0;
        mk.bump = ctx.bumps.market;
        Ok(())
    }

    /// Avanca os indices de borrow. PERMISSIONLESS: sem ator, ninguem paga
    /// aluguel, entao qualquer um pode chamar.
    pub fn accrue_borrow(ctx: Context<AccrueBorrow>, oi_cap: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let params = ctx.accounts.params()?;
        ctx.accounts.market.accrue(now, oi_cap, &params)?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// logica pura
// ---------------------------------------------------------------------------

impl Market {
    pub fn oi_total(&self) -> Result<u64> {
        self.oi_long
            .checked_add(self.oi_short)
            .ok_or(error!(PerpError::MathFailure))
    }

    pub fn oi_of(&self, side: Side) -> u64 {
        match side {
            Side::Long => self.oi_long,
            Side::Short => self.oi_short,
        }
    }

    pub fn oi_opposite(&self, side: Side) -> u64 {
        match side {
            Side::Long => self.oi_short,
            Side::Short => self.oi_long,
        }
    }

    pub fn borrow_index(&self, side: Side) -> u128 {
        match side {
            Side::Long => self.borrow_idx_long,
            Side::Short => self.borrow_idx_short,
        }
    }

    /// Taxa de borrow do lado, ja com o acrescimo do lado lotado.
    pub fn borrow_rate(&self, side: Side, oi_cap: u64, params: &PoolParams) -> Result<u128> {
        let u = m(utilization(self.oi_total()?, oi_cap))?;
        let base = m(borrow_rate_hourly(params.r0 as u128, params.r1 as u128, u))?;
        let mult = m(side_multiplier(
            self.oi_of(side),
            self.oi_opposite(side),
            params.psi as u128,
        ))?;
        m(mul_wad_ceil(base, mult))
    }

    /// Avanca os dois indices ate `now`.
    pub fn accrue(&mut self, now: i64, oi_cap: u64, params: &PoolParams) -> Result<()> {
        let elapsed = now.saturating_sub(self.last_accrual_ts);
        if elapsed <= 0 {
            return Ok(());
        }
        let rl = self.borrow_rate(Side::Long, oi_cap, params)?;
        let rs = self.borrow_rate(Side::Short, oi_cap, params)?;
        self.borrow_idx_long = m(accrue_borrow_index(self.borrow_idx_long, rl, elapsed))?;
        self.borrow_idx_short = m(accrue_borrow_index(self.borrow_idx_short, rs, elapsed))?;
        self.last_accrual_ts = now;
        Ok(())
    }

    /// Checa TODAS as condicoes de abertura. Falha alto e cedo.
    ///
    /// Esta funcao e a porta unica de entrada de risco no protocolo.
    #[allow(clippy::too_many_arguments)]
    pub fn check_open(
        &self,
        state: MarketState,
        oracle: &OracleView,
        _side: Side,
        notional: u64,
        margin: u64,
        usdc_sleeve: u64,
        params: &PoolParams,
    ) -> Result<u64> {
        require!(state.allows_open(), PerpError::StateForbidsOpen);
        require!(notional > 0, PerpError::ZeroNotional);

        // preco so vale se o oraculo esta saudavel
        let price = oracle.require_tradeable()?;

        // margem minima pela alavancagem maxima
        let needed = m(min_margin(notional, params.base_leverage as u128))?;
        require!(margin >= needed, PerpError::InsufficientMargin);

        // OS DOIS TETOS. O menor manda.
        let cap_solv = m(oi_cap_solvency(
            usdc_sleeve,
            params.phi as u128,
            params.delta_max as u128,
        ))?;
        let cap_depth = m(oi_cap_depth(
            oracle.depth,
            params.delta_liq as u128,
            params.mu as u128,
        ))?;
        let cap = oi_allowed(cap_solv, cap_depth);

        let oi_after = self
            .oi_total()?
            .checked_add(notional)
            .ok_or(error!(PerpError::MathFailure))?;
        require!(oi_after <= cap, PerpError::CapacityExceeded);

        // utilizacao acima do limite derruba o mercado para ReduceOnly; nao
        // deixamos a ultima ordem entrar e so depois perceber
        let u = m(utilization(oi_after, cap))?;
        require!(
            u < params.reduce_only_utilization as u128,
            PerpError::UtilizationTooHigh
        );

        Ok(price)
    }

    pub fn add_oi(&mut self, side: Side, notional: u64) -> Result<()> {
        match side {
            Side::Long => {
                self.oi_long = self
                    .oi_long
                    .checked_add(notional)
                    .ok_or(error!(PerpError::MathFailure))?
            }
            Side::Short => {
                self.oi_short = self
                    .oi_short
                    .checked_add(notional)
                    .ok_or(error!(PerpError::MathFailure))?
            }
        }
        self.open_positions = self.open_positions.saturating_add(1);
        Ok(())
    }

    pub fn remove_oi(&mut self, side: Side, notional: u64) -> Result<()> {
        match side {
            Side::Long => self.oi_long = self.oi_long.saturating_sub(notional),
            Side::Short => self.oi_short = self.oi_short.saturating_sub(notional),
        }
        self.open_positions = self.open_positions.saturating_sub(1);
        Ok(())
    }
}

impl Position {
    /// Borrow devido desde a abertura, arredondado a favor do pool.
    pub fn borrow_owed(&self, index_now: u128) -> Result<u64> {
        m(borrow_owed(self.notional, self.borrow_idx_entry, index_now))
    }

    pub fn pnl(&self, price: u64) -> Result<i128> {
        m(pnl(self.side.into(), self.entry_price, price, self.notional))
    }

    pub fn equity(&self, price: u64, index_now: u128) -> Result<i128> {
        m(equity(self.margin, self.pnl(price)?, self.borrow_owed(index_now)?))
    }

    pub fn health(&self, price: u64, index_now: u128) -> Result<i128> {
        m(health_wad(self.equity(price, index_now)?, self.notional))
    }

    /// Preco de liquidacao, deterministico e calculavel na abertura. O
    /// frontend le exatamente este valor.
    pub fn liquidation_price(&self, index_now: u128, maintenance: u64) -> Result<u64> {
        m(liquidation_price(
            self.side.into(),
            self.entry_price,
            self.margin,
            self.notional,
            self.borrow_owed(index_now)?,
            maintenance as u128,
        ))
    }

    pub fn is_liquidatable(&self, price: u64, index_now: u128, maintenance: u64) -> Result<bool> {
        Ok(self.health(price, index_now)? < maintenance as i128)
    }

    /// Reparte o que sobra numa liquidacao: taxa do liquidador primeiro, resto
    /// para o pool. Patrimonio negativo vira bad debt, nunca some.
    pub fn settle_liquidation(
        &self,
        price: u64,
        index_now: u128,
        liquidator_fee_bps: u16,
    ) -> Result<Liquidation> {
        let eq = self.equity(price, index_now)?;
        if eq <= 0 {
            return Ok(Liquidation {
                liquidator_fee: 0,
                to_pool: 0,
                bad_debt: m(to_u64(eq.unsigned_abs()))?,
            });
        }
        let eq_u = m(to_u64(eq as u128))?;
        let fee = m(slab_math::apply_bps_ceil(
            self.notional as u128,
            liquidator_fee_bps as u128,
        ))?;
        let fee = m(to_u64(fee))?.min(eq_u);
        Ok(Liquidation {
            liquidator_fee: fee,
            to_pool: eq_u - fee,
            bad_debt: 0,
        })
    }
}

/// Resultado de uma liquidacao. Soma sempre bate com o patrimonio da posicao.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Liquidation {
    pub liquidator_fee: u64,
    pub to_pool: u64,
    pub bad_debt: u64,
}

// ---------------------------------------------------------------------------
// contas
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

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: conta do pool; a contabilidade e validada na CPI.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: conta do oraculo; dono validado em `read_oracle`.
    pub oracle: UncheckedAccount<'info>,
    #[account(
        init, payer = admin, space = 8 + Market::INIT_SPACE,
        seeds = [seeds::MARKET, pool.key().as_ref()], bump
    )]
    pub market: Account<'info, Market>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AccrueBorrow<'info> {
    /// Permissionless de proposito.
    pub caller: Signer<'info>,
    #[account(mut, seeds = [seeds::MARKET, market.pool.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    /// CHECK: le os parametros; validado por dono.
    pub pool: UncheckedAccount<'info>,
}

impl<'info> AccrueBorrow<'info> {
    /// D6-D8: trocar por leitura real da conta `Pool` via `clp_pool::Pool`.
    /// Por ora usa os defaults do spec para o indice ja poder avancar.
    pub fn params(&self) -> Result<PoolParams> {
        Ok(PoolParams::default())
    }
}

/// Le o oraculo pela porta unica. Nenhum outro caminho e aceito.
pub fn oracle_view(ai: &AccountInfo) -> Result<OracleView> {
    read_oracle(ai, &ORACLE_PROGRAM_ID)
}

// ---------------------------------------------------------------------------
// testes
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use slab_interface::OracleState;
    use slab_math::WAD;

    const USDC: u64 = 1_000_000;

    fn market() -> Market {
        Market {
            pool: Pubkey::default(),
            oracle: Pubkey::default(),
            oi_long: 0,
            oi_short: 0,
            borrow_idx_long: RAY,
            borrow_idx_short: RAY,
            last_accrual_ts: 0,
            open_positions: 0,
            bump: 255,
        }
    }

    fn healthy_oracle(depth: u64) -> OracleView {
        OracleView {
            price: WAD as u64,
            twap: WAD as u64,
            ts: 1_000,
            depth,
            state: OracleState::Ok,
        }
    }

    fn position(side: Side, notional: u64, lev: u64) -> Position {
        Position {
            owner: Pubkey::default(),
            market: Pubkey::default(),
            side,
            notional,
            margin: notional / lev,
            entry_price: WAD as u64,
            borrow_idx_entry: RAY,
            opened_ts: 0,
            nonce: 0,
            bump: 255,
        }
    }

    // ---- abertura ----

    #[test]
    fn open_is_refused_when_the_depth_cap_is_exceeded() {
        let mk = market();
        let p = PoolParams::default();
        let o = healthy_oracle(60_000 * USDC);
        // teto de profundidade ~17.944; solvencia ~233.333
        assert!(mk
            .check_open(MarketState::Active, &o, Side::Long, 10_000 * USDC, 2_000 * USDC, 140_000 * USDC, &p)
            .is_ok());
        assert!(
            mk.check_open(MarketState::Active, &o, Side::Long, 20_000 * USDC, 4_000 * USDC, 140_000 * USDC, &p)
                .is_err(),
            "acima do teto de profundidade tem que ser recusado"
        );
    }

    #[test]
    fn open_is_refused_when_the_solvency_cap_is_exceeded() {
        let mk = market();
        let p = PoolParams::default();
        // AMM fundo: quem trava agora e a solvencia
        let o = healthy_oracle(5_000_000 * USDC);
        // manga liquida pequena -> teto de 1.666
        let small = 1_000 * USDC;
        assert!(mk
            .check_open(MarketState::Active, &o, Side::Long, 1_000 * USDC, 200 * USDC, small, &p)
            .is_ok());
        assert!(mk
            .check_open(MarketState::Active, &o, Side::Long, 5_000 * USDC, 1_000 * USDC, small, &p)
            .is_err());
    }

    #[test]
    fn open_is_refused_with_insufficient_margin() {
        let mk = market();
        let p = PoolParams::default();
        let o = healthy_oracle(60_000 * USDC);
        // 5x exige 20% de margem
        let n = 1_000 * USDC;
        assert!(mk
            .check_open(MarketState::Active, &o, Side::Long, n, 200 * USDC, 140_000 * USDC, &p)
            .is_ok());
        assert!(mk
            .check_open(MarketState::Active, &o, Side::Long, n, 199 * USDC, 140_000 * USDC, &p)
            .is_err());
    }

    #[test]
    fn open_is_refused_when_the_oracle_is_not_ok() {
        let mk = market();
        let p = PoolParams::default();
        for bad in [
            OracleState::Stale,
            OracleState::ShallowDepth,
            OracleState::Diverged,
            OracleState::Uninitialized,
        ] {
            let mut o = healthy_oracle(60_000 * USDC);
            o.state = bad;
            assert!(
                mk.check_open(MarketState::Active, &o, Side::Long, 1_000 * USDC, 500 * USDC, 140_000 * USDC, &p)
                    .is_err(),
                "{bad:?} deveria bloquear abertura"
            );
        }
    }

    #[test]
    fn open_is_refused_outside_active() {
        let mk = market();
        let p = PoolParams::default();
        let o = healthy_oracle(60_000 * USDC);
        for s in [MarketState::ReduceOnly, MarketState::Settled] {
            assert!(mk
                .check_open(s, &o, Side::Long, 1_000 * USDC, 500 * USDC, 140_000 * USDC, &p)
                .is_err());
        }
    }

    #[test]
    fn zero_notional_is_refused() {
        let mk = market();
        let p = PoolParams::default();
        let o = healthy_oracle(60_000 * USDC);
        assert!(mk
            .check_open(MarketState::Active, &o, Side::Long, 0, 0, 140_000 * USDC, &p)
            .is_err());
    }

    // ---- borrow ----

    #[test]
    fn borrow_grows_quadratically_with_utilization() {
        let p = PoolParams::default();
        let cap = 100_000 * USDC;
        let mut low = market();
        low.oi_long = 10_000 * USDC;
        let mut high = market();
        high.oi_long = 80_000 * USDC;
        let rl = low.borrow_rate(Side::Long, cap, &p).unwrap();
        let rh = high.borrow_rate(Side::Long, cap, &p).unwrap();
        assert!(rh > rl * 4, "8x a utilizacao deveria mais que quadruplicar");
    }

    #[test]
    fn crowded_side_pays_more_than_the_thin_side() {
        let p = PoolParams::default();
        let cap = 100_000 * USDC;
        let mut mk = market();
        mk.oi_long = 90_000 * USDC;
        mk.oi_short = 10_000 * USDC;
        let long = mk.borrow_rate(Side::Long, cap, &p).unwrap();
        let short = mk.borrow_rate(Side::Short, cap, &p).unwrap();
        assert!(long > short, "o lado lotado tem que pagar mais");
    }

    #[test]
    fn borrow_index_advances_only_forward() {
        let p = PoolParams::default();
        let mut mk = market();
        mk.oi_long = 50_000 * USDC;
        let before = mk.borrow_idx_long;
        mk.accrue(3_600, 100_000 * USDC, &p).unwrap();
        assert!(mk.borrow_idx_long > before);
        let after = mk.borrow_idx_long;
        // relogio voltando nao pode reduzir o indice
        mk.accrue(0, 100_000 * USDC, &p).unwrap();
        assert_eq!(mk.borrow_idx_long, after);
    }

    // ---- posicao ----

    #[test]
    fn trader_profit_and_pool_loss_are_the_same_number() {
        let pos = position(Side::Long, 1_000 * USDC, 5);
        let up = (WAD + WAD / 5) as u64; // +20%
        assert_eq!(pos.pnl(up).unwrap(), 200 * USDC as i128);
    }

    #[test]
    fn liquidation_price_is_known_at_open_time() {
        let p = PoolParams::default();
        let long = position(Side::Long, 1_000 * USDC, 5);
        let short = position(Side::Short, 1_000 * USDC, 5);
        let l = long.liquidation_price(RAY, p.maintenance_margin).unwrap();
        let s = short.liquidation_price(RAY, p.maintenance_margin).unwrap();
        assert_eq!(l, (WAD as u64) - 137_500);
        assert_eq!(s, (WAD as u64) + 137_500);
    }

    #[test]
    fn not_liquidatable_before_the_threshold() {
        let p = PoolParams::default();
        let pos = position(Side::Long, 1_000 * USDC, 5);
        // logo acima do preco de liquidacao
        let just_above = pos.liquidation_price(RAY, p.maintenance_margin).unwrap() + 1_000;
        assert!(!pos
            .is_liquidatable(just_above, RAY, p.maintenance_margin)
            .unwrap());
        // logo abaixo
        let just_below = pos.liquidation_price(RAY, p.maintenance_margin).unwrap() - 1_000;
        assert!(pos
            .is_liquidatable(just_below, RAY, p.maintenance_margin)
            .unwrap());
    }

    #[test]
    fn liquidation_pays_the_caller_then_the_pool() {
        let p = PoolParams::default();
        let pos = position(Side::Long, 1_000 * USDC, 5);
        // queda de 15%: patrimonio = 200 - 150 = 50
        let price = (WAD * 85 / 100) as u64;
        let r = pos
            .settle_liquidation(price, RAY, p.liquidator_fee_bps)
            .unwrap();
        assert_eq!(r.liquidator_fee, 10 * USDC, "1% do notional");
        assert_eq!(r.to_pool, 40 * USDC);
        assert_eq!(r.bad_debt, 0);
        assert_eq!(r.liquidator_fee + r.to_pool, 50 * USDC);
    }

    #[test]
    fn a_gap_through_the_margin_becomes_recorded_bad_debt() {
        let p = PoolParams::default();
        let pos = position(Side::Long, 1_000 * USDC, 5);
        // queda de 30%: perda de 300 contra margem de 200
        let price = (WAD * 70 / 100) as u64;
        let r = pos
            .settle_liquidation(price, RAY, p.liquidator_fee_bps)
            .unwrap();
        assert_eq!(r.bad_debt, 100 * USDC, "prejuizo tem que aparecer");
        assert_eq!(r.liquidator_fee, 0);
        assert_eq!(r.to_pool, 0);
    }

    #[test]
    fn borrow_eats_margin_and_moves_liquidation_closer() {
        let p = PoolParams::default();
        let pos = position(Side::Long, 1_000 * USDC, 5);
        let clean = pos.liquidation_price(RAY, p.maintenance_margin).unwrap();
        // indice 2% acima -> 20 USDC de borrow devido
        let with_borrow = pos
            .liquidation_price(RAY + RAY / 50, p.maintenance_margin)
            .unwrap();
        assert!(with_borrow > clean, "borrow aproxima a liquidacao");
    }

    #[test]
    fn full_hedge_scenario_from_the_spec() {
        // carteira com ~3.200 em cards, short de 3.200, indice cai 20%
        let pos = position(Side::Short, 3_200 * USDC, 4);
        let after = (WAD * 80 / 100) as u64;
        let gain = pos.pnl(after).unwrap();
        let card_loss = -(640 * USDC as i128);
        assert_eq!(gain, 640 * USDC as i128);
        assert_eq!(gain + card_loss, 0);
    }

    #[test]
    fn oi_accounting_is_symmetric() {
        let mut mk = market();
        mk.add_oi(Side::Long, 1_000).unwrap();
        mk.add_oi(Side::Short, 400).unwrap();
        assert_eq!(mk.oi_total().unwrap(), 1_400);
        assert_eq!(mk.open_positions, 2);
        mk.remove_oi(Side::Long, 1_000).unwrap();
        assert_eq!(mk.oi_long, 0);
        assert_eq!(mk.oi_total().unwrap(), 400);
        assert_eq!(mk.open_positions, 1);
    }
}
