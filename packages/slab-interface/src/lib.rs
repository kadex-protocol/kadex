//! Interfaces CONGELADAS entre os programas do SLAB.
//!
//! Tudo neste crate e contrato entre times. Mudar qualquer coisa aqui quebra
//! trabalho paralelo de outra pessoa.
//!
//! Antes de alterar algo neste arquivo:
//!
//! 1. explique por que a mudanca e necessaria
//! 2. liste os modulos afetados
//! 3. atualize `docs/frontend-contract.md` e `docs/oracle.md`
//! 4. atualize os testes
//! 5. avise quem esta bloqueado
//!
//! Quem produz o que:
//!
//! - [`OracleAccount`] e escrita pelo programa `oracle` (Backend A) e apenas
//!   LIDA por `perp` e `clp-pool` (Backend B), via [`read_oracle`].
//! - [`PoolParams`] e escrita pelo programa `clp-pool` (Backend B) e lida pelo
//!   frontend.
//! - Os seeds de PDA sao usados pelos tres times, inclusive pelo frontend para
//!   derivar enderecos sem chamar o programa.

use anchor_lang::prelude::*;
use slab_math::WAD;

// O crate declara o ID do programa `oracle` porque [`OracleAccount`] pertence
// a ele. E isso que faz `#[account]` gerar a checagem de dono correta: quando
// `perp` recebe um `Account<'info, OracleAccount>`, o Anchor exige sozinho que
// a conta seja de propriedade do programa `oracle`, e uma conta forjada por
// outro programa e rejeitada antes de qualquer logica rodar.
//
// CONGELADO: tem que bater com `programs/oracle/src/lib.rs` e com
// `[programs.localnet].oracle` no Anchor.toml.
declare_id!("5288ShBXsFxqXiGm22FZi1ZrMnmet4i1ZR3bccyAguqp");

/// ID do programa `oracle`. Reexportado para quem precisa passar explicito.
pub const ORACLE_PROGRAM_ID: Pubkey = ID;

// ---------------------------------------------------------------------------
// seeds de PDA — CONGELADO
// ---------------------------------------------------------------------------

/// Todos os PDAs do projeto derivam com estes seeds. O frontend reproduz
/// exatamente as mesmas derivacoes em TypeScript (`packages/types`).
pub mod seeds {
    /// card-vault: `["registry"]`
    pub const REGISTRY: &[u8] = b"registry";
    /// card-vault: `["card", nft_mint]`
    pub const CARD: &[u8] = b"card";
    /// card-vault: `["vault", nft_mint]`
    pub const VAULT: &[u8] = b"vault";
    /// card-vault: `["fraction_mint", nft_mint]`
    pub const FRACTION_MINT: &[u8] = b"fraction_mint";
    /// card-vault: `["nft_escrow", nft_mint]`
    pub const NFT_ESCROW: &[u8] = b"nft_escrow";
    /// oracle: `["oracle", basket]`
    pub const ORACLE: &[u8] = b"oracle";
    /// clp-pool: `["pool", usdc_mint]`
    pub const POOL: &[u8] = b"pool";
    /// clp-pool: `["clp_mint", pool]`
    pub const CLP_MINT: &[u8] = b"clp_mint";
    /// clp-pool: `["usdc_vault", pool]`
    pub const USDC_VAULT: &[u8] = b"usdc_vault";
    /// clp-pool: `["card_sleeve", pool, fraction_mint]`
    pub const CARD_SLEEVE: &[u8] = b"card_sleeve";
    /// perp: `["market", pool]`
    pub const MARKET: &[u8] = b"market";
    /// perp: `["position", market, owner, nonce_le]`
    pub const POSITION: &[u8] = b"position";
}

// ---------------------------------------------------------------------------
// estados — CONGELADO
// ---------------------------------------------------------------------------

/// Os tres estados do mercado. Nao existe um quarto.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum MarketState {
    /// Abrir, fechar, liquidar, depositar, resgatar.
    Active,
    /// Somente fechar e liquidar. Resgate de CLP tambem trava.
    ReduceOnly,
    /// Mercado encerrado. Somente resgate final com haircut pro-rata.
    Settled,
}

impl MarketState {
    /// Abrir posicao nova ou aumentar risco.
    pub fn allows_open(&self) -> bool {
        matches!(self, MarketState::Active)
    }
    /// Fechar posicao.
    pub fn allows_close(&self) -> bool {
        matches!(self, MarketState::Active | MarketState::ReduceOnly)
    }
    /// Liquidar. Permitido em Active e ReduceOnly: travar liquidacao seria
    /// deixar posicao podre acumulando.
    pub fn allows_liquidate(&self) -> bool {
        matches!(self, MarketState::Active | MarketState::ReduceOnly)
    }
    /// Depositar no pool.
    pub fn allows_deposit(&self) -> bool {
        matches!(self, MarketState::Active)
    }
    /// Resgate normal (proporcional). Em `Settled` o caminho e o resgate
    /// final com haircut, que e outra instrucao.
    pub fn allows_withdraw(&self) -> bool {
        matches!(self, MarketState::Active)
    }
}

/// Por que o oraculo nao esta saudavel. `Ok` e a unica condicao que libera
/// abertura de posicao.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum OracleState {
    Ok,
    /// Ultima atualizacao velha demais.
    Stale,
    /// Reserva do AMM abaixo de `min_pool_depth`: o oraculo ficou barato de
    /// empurrar.
    ShallowDepth,
    /// Preco do pool divergiu do limite de sanidade externo.
    Diverged,
    /// Nunca foi atualizado.
    Uninitialized,
}

impl OracleState {
    pub fn is_tradeable(&self) -> bool {
        matches!(self, OracleState::Ok)
    }
}

// ---------------------------------------------------------------------------
// oracle — CONGELADO (produzido por Backend A, consumido por Backend B)
// ---------------------------------------------------------------------------

/// Parametros do oraculo. Escala WAD, exceto onde dito.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace)]
pub struct OracleParams {
    /// Janela do TWAP em segundos. Spec: 1800 (30 min).
    pub twap_window_secs: u32,
    /// Variacao maxima aceita entre duas leituras. WAD. Spec: 0.05.
    pub max_tick_move: u64,
    /// Idade maxima antes de virar `Stale`, em segundos. Spec: 900.
    pub max_staleness_secs: u32,
    /// Profundidade minima em USDC nativo. Spec: 25_000_000_000 ($25k).
    pub min_pool_depth: u64,
    /// Divergencia maxima contra a mediana externa. WAD. Spec: 0.15.
    pub max_divergence: u64,
}

impl Default for OracleParams {
    fn default() -> Self {
        Self {
            twap_window_secs: 1_800,
            max_tick_move: 50_000,          // 5%
            max_staleness_secs: 900,        // 15 min
            min_pool_depth: 25_000_000_000, // $25k em USDC nativo
            max_divergence: 150_000,        // 15%
        }
    }
}

/// Quantas observacoes o buffer circular do TWAP guarda.
pub const ORACLE_OBSERVATIONS: usize = 32;

/// Uma leitura do preco spot do AMM.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, InitSpace)]
pub struct Observation {
    /// Preco spot em WAD no momento da leitura.
    pub price: u64,
    /// Unix timestamp da leitura.
    pub ts: i64,
}

/// Qual AMM externo o oraculo le. `Mock` existe porque, no dia 1, o formato
/// on-chain real do pool de fracoes ainda nao esta confirmado — ver
/// `docs/oracle.md`, secao "Blocker #1".
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum AmmAdapter {
    /// Pool constant-product local, so para devnet e testes.
    Mock,
    Meteora,
    Orca,
    Raydium,
}

/// Conta do oraculo. ESCRITA apenas pelo programa `oracle`.
///
/// `perp` e `clp-pool` leem via [`read_oracle`], nunca desserializando na mao
/// e nunca assumindo como o preco foi calculado.
#[account]
#[derive(InitSpace)]
pub struct OracleAccount {
    /// Cesta que este oraculo precifica.
    pub basket: Pubkey,
    /// Conta do pool AMM externo de onde as reservas sao lidas.
    pub amm_pool: Pubkey,
    /// Qual adaptador sabe ler `amm_pool`.
    pub adapter: AmmAdapter,
    /// Autoridade que pode trocar parametros. Nao pode escrever preco.
    pub admin: Pubkey,

    /// PRECO OFICIAL, em WAD. Ja passou por TWAP e clamp. E este que
    /// liquidacao e PnL usam. Nunca o spot.
    pub price: u64,
    /// TWAP puro da janela, antes do clamp. Exposto para diagnostico.
    pub twap: u64,
    /// Ultimo spot lido do AMM, sem suavizacao. Diagnostico apenas.
    pub spot: u64,
    /// Reserva em USDC do pool AMM. E o `R` do teto de profundidade.
    pub depth_usdc: u64,

    pub last_update_ts: i64,
    pub last_update_slot: u64,

    /// Mediana de fills externos. DEFESA SECUNDARIA: serve so como limite de
    /// sanidade, nunca como fonte de preco.
    pub external_median: u64,
    pub external_ts: i64,

    pub params: OracleParams,
    pub state: OracleState,

    pub observations: [Observation; ORACLE_OBSERVATIONS],
    pub obs_head: u8,
    pub obs_len: u8,
    pub bump: u8,
}

/// Visao somente-leitura que Backend B consome. NAO expoe como o preco foi
/// calculado: se amanha o adaptador mudar de Meteora para Orca, nada em `perp`
/// muda.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OracleView {
    /// Preco oficial em WAD (ja com TWAP e clamp).
    pub price: u64,
    /// TWAP bruto em WAD.
    pub twap: u64,
    /// Timestamp da ultima atualizacao.
    pub ts: i64,
    /// Profundidade do AMM em USDC nativo. Entra no teto de OI.
    pub depth: u64,
    pub state: OracleState,
}

impl OracleView {
    /// Preco utilizavel para abrir risco. Falha se o oraculo nao esta `Ok`.
    pub fn require_tradeable(&self) -> Result<u64> {
        require!(self.state.is_tradeable(), InterfaceError::OracleNotTradeable);
        require!(self.price > 0, InterfaceError::OraclePriceZero);
        Ok(self.price)
    }

    /// Preco para liquidacao e marcacao. Permitido mesmo fora de `Ok`, desde
    /// que nao esteja velho: travar liquidacao seria deixar posicao podre
    /// acumulando. Nunca aceita preco zero.
    pub fn require_markable(&self, now: i64, max_staleness: u32) -> Result<u64> {
        require!(self.price > 0, InterfaceError::OraclePriceZero);
        require!(
            now.saturating_sub(self.ts) <= max_staleness as i64,
            InterfaceError::OracleStale
        );
        Ok(self.price)
    }
}

/// Le a conta do oraculo a partir de um `AccountInfo`, conferindo que ela
/// pertence mesmo ao programa `oracle`.
///
/// Esta e a UNICA porta pela qual Backend B toca o oraculo.
pub fn read_oracle(ai: &AccountInfo, oracle_program_id: &Pubkey) -> Result<OracleView> {
    require_keys_eq!(
        *ai.owner,
        *oracle_program_id,
        InterfaceError::OracleWrongOwner
    );
    let data = ai.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    let acc = OracleAccount::try_deserialize(&mut slice)?;
    Ok(OracleView {
        price: acc.price,
        twap: acc.twap,
        ts: acc.last_update_ts,
        depth: acc.depth_usdc,
        state: acc.state,
    })
}

// ---------------------------------------------------------------------------
// parametros do pool — CONGELADO
// ---------------------------------------------------------------------------

/// Toda a configuracao economica vive aqui, dentro da conta `Pool`.
///
/// Nao espalhe estes numeros pelo codigo. Se um valor precisa mudar, muda no
/// `Pool` e todo mundo enxerga a mesma coisa.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace)]
pub struct PoolParams {
    /// Alvo da manga de cards. WAD. Spec: 0.30.
    pub card_sleeve_target: u64,
    /// Fracao do USDC compromissavel com traders. WAD. Spec: 0.50.
    pub phi: u64,
    /// Movimento adverso que a manga liquida aguenta. WAD. Spec: 0.30.
    pub delta_max: u64,
    /// Fracao do OI capturavel numa cascata. WAD. Spec: 0.30.
    pub mu: u64,
    /// Movimento que leva uma posicao alavancada a liquidacao. WAD.
    /// Spec: 0.1875 (5x com manutencao de 6.25%).
    pub delta_liq: u64,
    /// Alavancagem maxima base. WAD. Spec: 5.0.
    pub base_leverage: u64,
    /// Margem de manutencao. WAD. Spec: 0.0625.
    pub maintenance_margin: u64,
    /// Borrow base por hora. WAD. Spec: 0.00005 (0.005%).
    pub r0: u64,
    /// Coeficiente quadratico do borrow. WAD. Spec: 0.0005 (0.05%).
    pub r1: u64,
    /// Acrescimo de borrow no lado lotado. WAD. Spec: 0.5.
    pub psi: u64,
    /// Taxa de abertura e fechamento, em bps. Spec: 10.
    pub open_close_fee_bps: u16,
    /// Taxa paga ao liquidador, em bps do notional. Spec: 100.
    pub liquidator_fee_bps: u16,
    /// Haircut no deposito de fracao de card, em bps. Spec: 300.
    pub deposit_haircut_bps: u16,
    /// Teto de peso de um card dentro da manga. WAD. Spec: 0.15.
    pub max_card_weight: u64,
    /// Fatia da taxa que vai para os LPs, em bps. Spec: 7500 (75%).
    pub lp_fee_share_bps: u16,
    /// Utilizacao a partir da qual o mercado entra em `ReduceOnly`. WAD.
    /// Spec: 0.95.
    pub reduce_only_utilization: u64,
}

impl Default for PoolParams {
    fn default() -> Self {
        Self {
            card_sleeve_target: 300_000,     // 30%
            phi: 500_000,                    // 0.50
            delta_max: 300_000,              // 0.30
            mu: 300_000,                     // 0.30
            delta_liq: 187_500,              // 0.1875
            base_leverage: (5 * WAD) as u64, // 5x
            maintenance_margin: 62_500,      // 6.25%
            r0: 50,                          // 0.005%/h
            r1: 500,                         // 0.05%/h
            psi: 500_000,                    // 0.5
            open_close_fee_bps: 10,
            liquidator_fee_bps: 100,
            deposit_haircut_bps: 300,
            max_card_weight: 150_000,   // 15%
            lp_fee_share_bps: 7_500,    // 75%
            reduce_only_utilization: 950_000, // 95%
        }
    }
}

/// Lado da posicao. Espelha [`slab_math::Side`], mas serializavel por Anchor.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Side {
    Long,
    Short,
}

impl From<Side> for slab_math::Side {
    fn from(s: Side) -> Self {
        match s {
            Side::Long => slab_math::Side::Long,
            Side::Short => slab_math::Side::Short,
        }
    }
}

// ---------------------------------------------------------------------------
// erros compartilhados
// ---------------------------------------------------------------------------

#[error_code]
pub enum InterfaceError {
    #[msg("A conta de oraculo nao pertence ao programa oracle")]
    OracleWrongOwner,
    #[msg("Oraculo nao esta em estado negociavel")]
    OracleNotTradeable,
    #[msg("Oraculo desatualizado")]
    OracleStale,
    #[msg("Preco do oraculo e zero")]
    OraclePriceZero,
    #[msg("Falha de aritmetica de ponto fixo")]
    MathFailure,
}

/// Converte um [`slab_math::MathError`] em erro Anchor. Toda aritmetica nos
/// programas passa por aqui, entao nenhum overflow vira numero errado.
pub fn m<T>(r: core::result::Result<T, slab_math::MathError>) -> Result<T> {
    r.map_err(|_| error!(InterfaceError::MathFailure))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_machine_permissions_match_the_spec() {
        use MarketState::*;
        assert!(Active.allows_open() && Active.allows_close() && Active.allows_deposit());
        assert!(!ReduceOnly.allows_open(), "ReduceOnly nao abre risco novo");
        assert!(ReduceOnly.allows_close() && ReduceOnly.allows_liquidate());
        assert!(!ReduceOnly.allows_withdraw(), "resgate trava em ReduceOnly");
        assert!(!Settled.allows_open() && !Settled.allows_close());
        assert!(!Settled.allows_liquidate());
    }

    #[test]
    fn only_ok_oracle_is_tradeable() {
        use OracleState::*;
        assert!(Ok.is_tradeable());
        for s in [Stale, ShallowDepth, Diverged, Uninitialized] {
            assert!(!s.is_tradeable(), "{s:?} nao deveria liberar abertura");
        }
    }

    #[test]
    fn default_params_match_the_spec_table() {
        let p = PoolParams::default();
        assert_eq!(p.phi, 500_000);
        assert_eq!(p.delta_max, 300_000);
        assert_eq!(p.mu, 300_000);
        assert_eq!(p.maintenance_margin, 62_500);
        assert_eq!(p.max_card_weight, 150_000);
        assert_eq!(p.base_leverage, 5_000_000);
        let o = OracleParams::default();
        assert_eq!(o.twap_window_secs, 1_800);
        assert_eq!(o.max_tick_move, 50_000);
        assert_eq!(o.min_pool_depth, 25_000_000_000);
    }
}
