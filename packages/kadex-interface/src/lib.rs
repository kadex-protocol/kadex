//! FROZEN interfaces between Kadex programs.
//!
//! Everything in this crate is a contract between people. Changing anything
//! here breaks someone else's work in flight.
//!
//! Before you change a line of this file:
//!
//! 1. explain why the change is necessary
//! 2. list the affected modules
//! 3. update `docs/frontend-contract.md` and `docs/oracle.md`
//! 4. update the tests
//! 5. tell whoever is blocked by it
//!
//! Who produces what:
//!
//! - [`OracleAccount`] is written by the `oracle` program (Backend A) and only
//!   READ by `perp` and `clp-pool` (Backend B), through [`read_oracle`].
//! - [`PoolParams`] is written by `clp-pool` (Backend B) and read by everyone.
//! - The PDA seeds are used by all three tracks, including the frontend, which
//!   mirrors them in `packages/types`.
//!
//! This crate holds the *serializable* shapes. The decisions that use them live
//! in `kadex-risk`, which deliberately knows nothing about Anchor.

use anchor_lang::prelude::*;
use kadex_math::WAD;
use kadex_risk::RiskParams;

// This crate declares the `oracle` program's ID because [`OracleAccount`]
// belongs to it. That is what makes `#[account]` generate the right owner
// check: when `perp` takes an `Account<'info, OracleAccount>`, Anchor itself
// requires the account to be owned by the `oracle` program, and an account
// forged by any other program is rejected before our logic runs.
//
// FROZEN: must match `programs/oracle/src/lib.rs` and `[programs.localnet]`
// in Anchor.toml.
declare_id!("5288ShBXsFxqXiGm22FZi1ZrMnmet4i1ZR3bccyAguqp");

/// The `oracle` program ID, re-exported for callers that pass it explicitly.
pub const ORACLE_PROGRAM_ID: Pubkey = ID;

/// The perp program. The pool derives its one legitimate market from this,
/// so `set_perp_market` cannot bind anything else.
pub const PERP_PROGRAM_ID: Pubkey = pubkey!("BcVwJ91Jd1k7xUNcGYzRygq2ubaCYn7p5MeUZzy1EyLR");

/// The open book, as the pool needs it to mark NAV at today's price.
///
/// An earlier version had `perp` push a PnL *number*, computed at the price
/// of the last close. Between closes it went stale, and NAV with it: opens
/// and price moves were invisible to every deposit and withdrawal. Storing
/// the book instead lets the pool mark it at whatever the oracle says now.
///
/// CHANGED 9 Oct 2026 (issue #14), per the process at the top of this file.
/// Why: deposit NAV ignored borrow owed but not yet paid, so a depositor
/// bought in cheap at the existing LPs' expense. The book now carries the
/// borrow indices, their accrual time and the per-side borrow units, so the
/// pool can bring the indices to `now` with the same `kadex_risk::accrue`
/// perp uses and read the whole book's unpaid borrow. Affects: the `Pool`
/// account layout (clp-pool), the `Market` account (perp, new borrow-unit
/// fields appended), `record_open` / `settle_position` arguments, and the SDK
/// decoders and `navIssue`. Nothing was deployed when it changed.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct BookSnapshot {
    pub oi_long: u64,
    pub oi_short: u64,
    pub units_long: u128,
    pub units_short: u128,
    pub borrow_idx_long: u128,
    pub borrow_idx_short: u128,
    pub last_accrual_ts: i64,
    pub borrow_units_long: u128,
    pub borrow_units_short: u128,
}

impl BookSnapshot {
    pub fn of(m: &kadex_risk::MarketRisk) -> Self {
        Self {
            oi_long: m.oi_long,
            oi_short: m.oi_short,
            units_long: m.units_long,
            units_short: m.units_short,
            borrow_idx_long: m.borrow_idx_long,
            borrow_idx_short: m.borrow_idx_short,
            last_accrual_ts: m.last_accrual_ts,
            borrow_units_long: m.borrow_units_long,
            borrow_units_short: m.borrow_units_short,
        }
    }

    /// The book back as the plain struct `kadex-risk` works with.
    pub fn risk(&self) -> kadex_risk::MarketRisk {
        kadex_risk::MarketRisk {
            oi_long: self.oi_long,
            oi_short: self.oi_short,
            units_long: self.units_long,
            units_short: self.units_short,
            borrow_idx_long: self.borrow_idx_long,
            borrow_idx_short: self.borrow_idx_short,
            last_accrual_ts: self.last_accrual_ts,
            borrow_units_long: self.borrow_units_long,
            borrow_units_short: self.borrow_units_short,
        }
    }

    /// Unrealized trader PnL at `price`. Positive: traders ahead, pool behind.
    pub fn unrealized_pnl(&self, price: u64) -> core::result::Result<i128, kadex_risk::RiskError> {
        self.risk().unrealized_pnl(price)
    }

    /// Borrow the open book owes and has not paid, brought to `now` at `cap`.
    /// An empty book (indices never stamped) owes nothing.
    pub fn borrow_owed_at(&self, now: i64, cap: u64, p: &RiskParams) -> core::result::Result<u64, kadex_risk::RiskError> {
        if self.oi_total() == 0 || self.borrow_idx_long == 0 || self.borrow_idx_short == 0 {
            return Ok(0);
        }
        kadex_risk::borrow_owed_at(&self.risk(), now, cap, p)
    }

    pub fn oi_total(&self) -> u64 {
        self.oi_long.saturating_add(self.oi_short)
    }
}

// ---------------------------------------------------------------------------
// PDA seeds — FROZEN
// ---------------------------------------------------------------------------

/// Every PDA in the project derives from these. The frontend reproduces the
/// same derivations in TypeScript; if they drift, it derives addresses that do
/// not exist.
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
// states — FROZEN
// ---------------------------------------------------------------------------

/// The three market states. There is no fourth.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum MarketState {
    /// Open, close, liquidate, deposit, withdraw.
    Active,
    /// Close and liquidate only. CLP withdrawals are frozen too, so an LP
    /// cannot pull out exactly when the pool most needs the buffer.
    ReduceOnly,
    /// Market is over. It still UNWINDS — positions close, liquidations
    /// clear, LPs redeem — but nothing new is opened and no money comes in.
    Settled,
}

impl MarketState {
    /// Open a new position, or otherwise add risk.
    pub fn allows_open(&self) -> bool {
        matches!(self, MarketState::Active)
    }
    /// Close a position. Allowed in `Settled` too.
    ///
    /// CHANGED 2 Oct: `Settled` used to forbid this, which stranded every
    /// open position's margin permanently — and because `margin_held` is a
    /// pool liability, it also haircut the LPs forever for money nobody could
    /// ever collect. A settled market has to be able to unwind.
    pub fn allows_close(&self) -> bool {
        true
    }
    /// Liquidate. Allowed outside `Active` as well: blocking liquidation
    /// would leave rotten positions accumulating, and in `Settled` it is the
    /// only way to clear a position whose owner never comes back.
    pub fn allows_liquidate(&self) -> bool {
        true
    }
    /// Deposit into the pool.
    pub fn allows_deposit(&self) -> bool {
        matches!(self, MarketState::Active)
    }
    /// Ordinary proportional withdrawal. In `Settled` the path is the final
    /// redemption, which is a different instruction.
    pub fn allows_withdraw(&self) -> bool {
        matches!(self, MarketState::Active)
    }
}

/// Why the oracle is or is not healthy. `Ok` is the only state that allows a
/// position to be opened.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum OracleState {
    Ok,
    /// Last update is too old.
    Stale,
    /// AMM reserve below `min_pool_depth`: the oracle has become cheap to push.
    ShallowDepth,
    /// Pool price diverged from the external sanity bound.
    Diverged,
    /// Never updated.
    Uninitialized,
    /// The clamp is holding the published price away from the TWAP: the
    /// market moved faster than the oracle is allowed to follow. Positions
    /// mark and close; nothing new opens at a price known to be behind.
    CatchingUp,
}

impl OracleState {
    pub fn is_tradeable(&self) -> bool {
        matches!(self, OracleState::Ok)
    }
}

// ---------------------------------------------------------------------------
// oracle — FROZEN (produced by Backend A, consumed by Backend B)
// ---------------------------------------------------------------------------

/// Oracle configuration. WAD scale unless stated otherwise.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace)]
pub struct OracleParams {
    /// TWAP window in seconds. Spec: 1800 (30 min).
    pub twap_window_secs: u32,
    /// Largest move accepted per `clamp_period_secs` of elapsed time. WAD.
    /// Spec: 0.05.
    ///
    /// Scaled by TIME, not by update. An earlier version allowed this much
    /// per call, and `refresh_price` is permissionless: twelve calls in one
    /// transaction moved the price 79.6%.
    pub max_tick_move: u64,
    /// Age at which the oracle goes `Stale`, in seconds. Spec: 900.
    pub max_staleness_secs: u32,
    /// Minimum AMM depth, in native USDC. Spec: 25_000_000_000 ($25k).
    pub min_pool_depth: u64,
    /// Largest divergence tolerated against the external median. WAD. Spec: 0.15.
    pub max_divergence: u64,
    /// EMA coefficient for [`OracleAccount::slow_twap`]. WAD.
    ///
    /// Small on purpose. At 0.01 and a 30s refresh the slow price takes about
    /// fifty minutes to follow a step change, which is the point: see
    /// [`OracleView::mark_price`].
    ///
    /// Applied per `clamp_period_secs` of elapsed time, never per call, so
    /// refreshing more often does not drag it faster.
    pub slow_alpha: u64,
    /// The period `max_tick_move` and `slow_alpha` are expressed over, in
    /// seconds. Spec: 15.
    pub clamp_period_secs: u32,
}

impl Default for OracleParams {
    fn default() -> Self {
        Self {
            twap_window_secs: 1_800,
            max_tick_move: 50_000,          // 5%
            max_staleness_secs: 900,        // 15 min
            min_pool_depth: 25_000_000_000, // $25k in native USDC
            max_divergence: 150_000,        // 15%
            slow_alpha: 5_000,              // 0.005 per 15s -> ~50min to follow a step
            clamp_period_secs: 15,
        }
    }
}

/// How many observations the TWAP ring buffer keeps.
pub const ORACLE_OBSERVATIONS: usize = 32;

/// A checkpoint of the running price integral.
///
/// The TWAP is `(cumulative_now - cumulative_then) / (now - then)`: every
/// spot price counts for exactly as long as it was in force. Averaging the
/// raw readings instead let one caller stuff the buffer with copies of a
/// pushed price. Checkpoints are spaced at least `window / 31` apart, so the
/// buffer always reaches back a full window however often anyone refreshes.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, InitSpace)]
pub struct Observation {
    /// Unix timestamp of the checkpoint.
    pub ts: i64,
    /// Sum of `spot * seconds` up to `ts`.
    pub cumulative: u128,
    /// Lowest AMM USDC reserve seen from `ts` until the next checkpoint. The
    /// published depth is the minimum over the window, so liquidity added for
    /// one transaction cannot buy open interest.
    pub depth: u64,
}

/// Which external AMM the oracle reads. `Mock` exists because, as of day 1,
/// the on-chain layout of the real fraction pool is not confirmed — see
/// `docs/oracle.md`, "Blocker #1".
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum AmmAdapter {
    /// Local constant-product pool, devnet and tests only.
    Mock,
    Meteora,
    Orca,
    Raydium,
}

/// The oracle account. WRITTEN only by the `oracle` program.
///
/// `perp` and `clp-pool` read it through [`read_oracle`], never deserializing
/// by hand and never assuming how the price was computed.
#[account]
#[derive(InitSpace)]
pub struct OracleAccount {
    /// The basket this oracle prices.
    pub basket: Pubkey,
    /// External AMM pool account the reserves are read from.
    pub amm_pool: Pubkey,
    /// Which adapter knows how to read `amm_pool`.
    pub adapter: AmmAdapter,
    /// Authority allowed to change parameters. Cannot write a price.
    pub admin: Pubkey,

    /// THE OFFICIAL PRICE, in WAD. Already through TWAP and clamp. This is
    /// what liquidation and PnL use. Never the spot.
    pub price: u64,
    /// Raw window TWAP, before the clamp. Diagnostics only.
    pub twap: u64,
    /// Last spot read from the AMM, unsmoothed. It enters the TWAP only for
    /// the time it stays in force, starting at the NEXT refresh: a price
    /// pushed for one transaction counts for the seconds until somebody
    /// refreshes again, which is almost nothing.
    pub spot: u64,
    /// Running integral of `spot * seconds`. See [`Observation`].
    pub cumulative: u128,
    /// A deliberately sluggish EMA of the price, used ONLY to mark the pool's
    /// card sleeve. See [`OracleView::mark_price`] for why it exists.
    pub slow_twap: u64,
    /// AMM USDC reserve, as the MINIMUM over the TWAP window. This is the
    /// `R` in the depth ceiling. Liquidity counts once it has stayed.
    pub depth_usdc: u64,

    pub last_update_ts: i64,
    pub last_update_slot: u64,

    /// Median of external fills. SECONDARY DEFENCE: a sanity bound only, never
    /// a price source.
    pub external_median: u64,
    pub external_ts: i64,

    pub params: OracleParams,
    pub state: OracleState,

    pub observations: [Observation; ORACLE_OBSERVATIONS],
    pub obs_head: u8,
    pub obs_len: u8,
    pub bump: u8,
}

/// The read-only view Backend B consumes. It deliberately does not expose how
/// the price was produced: if the adapter changes from Meteora to Orca
/// tomorrow, nothing in `perp` moves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OracleView {
    /// Official price in WAD (TWAP and clamp already applied).
    pub price: u64,
    /// Raw TWAP in WAD.
    pub twap: u64,
    /// Timestamp of the last update.
    pub ts: i64,
    /// AMM depth in native USDC. Feeds the open-interest ceiling.
    pub depth: u64,
    /// Sluggish EMA, for marking collateral rather than trading it.
    pub slow_twap: u64,
    /// State as of the last refresh. Says nothing about freshness on its own:
    /// it only changes when someone refreshes, so every consumer checks `ts`
    /// against `max_staleness_secs` as well.
    pub state: OracleState,
    /// The oracle's own staleness limit. Consumers use this rather than a
    /// number of their own, so there is one limit to reason about.
    pub max_staleness_secs: u32,
}

impl OracleView {
    /// Was the price refreshed within the oracle's own staleness limit?
    ///
    /// `state` cannot answer this: it is written by `refresh_price`, so when
    /// every keeper stops it stays `Ok` forever. Freshness has to be judged
    /// at read time, against the clock.
    pub fn is_fresh(&self, now: i64) -> bool {
        self.ts > 0 && now.saturating_sub(self.ts) <= self.max_staleness_secs as i64
    }

    /// Price usable for opening risk: state `Ok` AND fresh. A stale price
    /// must never admit new risk, whatever the stored state says.
    pub fn require_tradeable(&self, now: i64) -> Result<u64> {
        require!(self.is_fresh(now), InterfaceError::OracleStale);
        require!(self.state.is_tradeable(), InterfaceError::OracleNotTradeable);
        require!(self.price > 0, InterfaceError::OraclePriceZero);
        Ok(self.price)
    }

    /// Price for liquidation and marking. Allowed outside `Ok`, as long as it
    /// is not stale: blocking liquidation would leave rotten positions
    /// accumulating. Never accepts a zero price.
    ///
    /// A stale oracle is not a dead end: `refresh_price` is permissionless,
    /// so a closing trader prepends it to the same transaction.
    pub fn require_markable(&self, now: i64) -> Result<u64> {
        require!(self.price > 0, InterfaceError::OraclePriceZero);
        require!(self.is_fresh(now), InterfaceError::OracleStale);
        Ok(self.price)
    }

    /// The HIGH mark of the card sleeve, `max(price, slow_twap)`.
    ///
    /// Used only to price CLP being ISSUED. A deposit buys in at the high
    /// mark and a withdrawal leaves at the low one (`mark_price`), so no
    /// round trip through the pool can come out ahead of where it went in.
    pub fn issue_price(&self) -> u64 {
        self.price.max(self.slow_twap)
    }

    /// Price for marking the pool's CARD SLEEVE. Never for PnL.
    ///
    /// The circularity this exists to blunt: the same AMM prices the perp and
    /// the collateral behind it, so one push used to move a trader's PnL and
    /// inflate the pool backing that same position, in one transaction.
    ///
    /// Taking `min(price, slow_twap)` breaks the symmetry. A push upward is
    /// ignored for hours because the slow EMA lags; a fall is taken
    /// immediately because the fast price is lower. Collateral marks DOWN fast
    /// and UP slowly, which is the only direction a pool should ever be wrong
    /// in.
    ///
    /// It does not eliminate the circularity. An attacker willing to hold a
    /// pushed price for hours still moves both. It removes the single-
    /// transaction version, which is the one that pays.
    pub fn mark_price(&self) -> u64 {
        if self.slow_twap == 0 {
            return self.price;
        }
        self.price.min(self.slow_twap)
    }

    /// Shape this view takes when handed to `kadex-risk`.
    pub fn risk_input(&self) -> kadex_risk::PriceInput {
        kadex_risk::PriceInput {
            price: self.price,
            depth: self.depth,
        }
    }
}

/// Read the oracle account from an `AccountInfo`, checking that it really is
/// owned by the `oracle` program.
///
/// This is the only door through which Backend B touches the oracle.
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
        slow_twap: acc.slow_twap,
        state: acc.state,
        max_staleness_secs: acc.params.max_staleness_secs,
    })
}

// ---------------------------------------------------------------------------
// who may initialize
// ---------------------------------------------------------------------------

/// BPF loader v4, which `solana program-v4 deploy` uses.
pub const LOADER_V4_ID: Pubkey = pubkey!("LoaderV411111111111111111111111111111111111");
/// The upgradeable (v3) loader, which `solana program deploy` uses.
pub const LOADER_V3_ID: Pubkey = pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");

/// The key allowed to upgrade `program`, read from the loader itself.
///
/// Every `initialize_*` in Kadex creates an account at a fixed PDA, so the
/// first caller wins it forever. Without this check that caller is whoever
/// gets there first after deployment, and they choose the vaults, the oracle
/// and the admin. Tying initialization to the upgrade authority means the
/// only person who can create these accounts is the person who could have
/// rewritten the program anyway: no new trust is introduced.
///
/// `program_data` is needed for the v3 loader only, where the authority lives
/// in a separate account; loader v4 keeps it in the program account's header.
pub fn upgrade_authority(program: &AccountInfo, program_data: Option<&AccountInfo>) -> Result<Pubkey> {
    let data = program.try_borrow_data()?;
    if *program.owner == LOADER_V4_ID {
        // LoaderV4State { slot: u64, authority_or_next_version: Pubkey, status: u64 }
        require!(data.len() >= 48, InterfaceError::NotDeployer);
        let status = u64::from_le_bytes(data[40..48].try_into().unwrap());
        // 2 = Finalized: the field holds the next version, not an authority.
        require!(status != 2, InterfaceError::NotDeployer);
        return Ok(Pubkey::new_from_array(data[8..40].try_into().unwrap()));
    }
    if *program.owner == LOADER_V3_ID {
        // UpgradeableLoaderState::Program { programdata_address } = tag 2 + key
        require!(data.len() >= 36, InterfaceError::NotDeployer);
        require!(u32::from_le_bytes(data[0..4].try_into().unwrap()) == 2, InterfaceError::NotDeployer);
        let expected = Pubkey::new_from_array(data[4..36].try_into().unwrap());
        let pd = program_data.ok_or(error!(InterfaceError::NotDeployer))?;
        require_keys_eq!(pd.key(), expected, InterfaceError::NotDeployer);
        let pdata = pd.try_borrow_data()?;
        // ProgramData { slot: u64, upgrade_authority: Option<Pubkey> } = tag 3
        require!(pdata.len() >= 45, InterfaceError::NotDeployer);
        require!(u32::from_le_bytes(pdata[0..4].try_into().unwrap()) == 3, InterfaceError::NotDeployer);
        require!(pdata[12] == 1, InterfaceError::NotDeployer);
        return Ok(Pubkey::new_from_array(pdata[13..45].try_into().unwrap()));
    }
    err!(InterfaceError::NotDeployer)
}

/// Fail unless `signer` is the upgrade authority of `program`.
pub fn require_deployer(
    program: &AccountInfo,
    program_data: Option<&AccountInfo>,
    expected_program_id: &Pubkey,
    signer: &Pubkey,
) -> Result<()> {
    require_keys_eq!(program.key(), *expected_program_id, InterfaceError::NotDeployer);
    require_keys_eq!(upgrade_authority(program, program_data)?, *signer, InterfaceError::NotDeployer);
    Ok(())
}

// ---------------------------------------------------------------------------
// pool parameters — FROZEN
// ---------------------------------------------------------------------------

/// All economic configuration lives here, inside the `Pool` account.
///
/// Do not scatter these numbers through the codebase. If a value has to
/// change, it changes on the `Pool` and everyone sees the same thing.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace)]
pub struct PoolParams {
    /// Card sleeve target. WAD. Spec: 0.30.
    pub card_sleeve_target: u64,
    /// Share of the USDC sleeve committable to traders. WAD. Spec: 0.50.
    pub phi: u64,
    /// Adverse move the liquid sleeve must absorb. WAD. Spec: 0.30.
    pub delta_max: u64,
    /// Share of open interest captured in a cascade. WAD. Spec: 0.30.
    pub mu: u64,
    /// Move that takes a max-leverage position to liquidation. WAD.
    /// Spec: 0.1875 (5x with 6.25% maintenance).
    pub delta_liq: u64,
    /// Maximum leverage. WAD. Spec: 5.0.
    pub base_leverage: u64,
    /// Maintenance margin. WAD. Spec: 0.0625.
    pub maintenance_margin: u64,
    /// Base hourly borrow rate. WAD. Spec: 0.00005 (0.005%).
    pub r0: u64,
    /// Quadratic borrow coefficient. WAD. Spec: 0.0005 (0.05%).
    pub r1: u64,
    /// Crowded-side borrow surcharge. WAD. Spec: 0.5.
    pub psi: u64,
    /// Open and close fee, in basis points. Spec: 10.
    pub open_close_fee_bps: u16,
    /// Liquidator reward, in basis points of notional. Spec: 100.
    pub liquidator_fee_bps: u16,
    /// Haircut on card-fraction deposits, in basis points. Spec: 300.
    pub deposit_haircut_bps: u16,
    /// Weight ceiling for a single card inside the sleeve. WAD. Spec: 0.15.
    pub max_card_weight: u64,
    /// Share of fees going to LPs, in basis points. Spec: 7500 (75%).
    pub lp_fee_share_bps: u16,
    /// Utilization at which the market goes `ReduceOnly`. WAD. Spec: 0.95.
    pub reduce_only_utilization: u64,
    /// How many times attacking must cost what it pays, at the depth ceiling.
    /// WAD. Default 2.0 — without it the ceiling has no margin at all.
    pub attack_safety: u64,
}

impl PoolParams {
    /// Project onto the plain struct `kadex-risk` works with.
    ///
    /// This mapping is the only place the two representations meet, and
    /// `params_projection_is_faithful` guards it.
    pub fn risk(&self) -> RiskParams {
        RiskParams {
            phi: self.phi,
            delta_max: self.delta_max,
            mu: self.mu,
            delta_liq: self.delta_liq,
            base_leverage: self.base_leverage,
            maintenance_margin: self.maintenance_margin,
            r0: self.r0,
            r1: self.r1,
            psi: self.psi,
            reduce_only_utilization: self.reduce_only_utilization,
            liquidator_fee_bps: self.liquidator_fee_bps,
            attack_safety: self.attack_safety,
        }
    }
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
            max_card_weight: 150_000,         // 15%
            lp_fee_share_bps: 7_500,          // 75%
            reduce_only_utilization: 950_000, // 95%
            attack_safety: 2_000_000,         // 2x
        }
    }
}

/// Position side. Mirrors [`kadex_math::Side`], but Anchor-serializable.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Side {
    Long,
    Short,
}

impl From<Side> for kadex_math::Side {
    fn from(s: Side) -> Self {
        match s {
            Side::Long => kadex_math::Side::Long,
            Side::Short => kadex_math::Side::Short,
        }
    }
}

impl From<kadex_math::Side> for Side {
    fn from(s: kadex_math::Side) -> Self {
        match s {
            kadex_math::Side::Long => Side::Long,
            kadex_math::Side::Short => Side::Short,
        }
    }
}

// ---------------------------------------------------------------------------
// shared errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum InterfaceError {
    #[msg("Oracle account is not owned by the oracle program")]
    OracleWrongOwner,
    #[msg("Oracle is not in a tradeable state")]
    OracleNotTradeable,
    #[msg("Oracle data is stale")]
    OracleStale,
    #[msg("Oracle price is zero")]
    OraclePriceZero,
    #[msg("Fixed-point arithmetic failed")]
    MathFailure,
    #[msg("Market state forbids opening new risk")]
    StateForbidsOpen,
    #[msg("Notional is zero")]
    ZeroNotional,
    #[msg("Margin is below the minimum for maximum leverage")]
    InsufficientMargin,
    #[msg("Open-interest capacity exceeded: the lower of the two ceilings was breached")]
    CapacityExceeded,
    #[msg("Utilization too high to open new risk")]
    UtilizationTooHigh,
    #[msg("Position is not liquidatable yet")]
    NotLiquidatable,
    #[msg("Only the program's upgrade authority may initialize this")]
    NotDeployer,
    #[msg("Withdrawal would leave open interest above the pool's capacity")]
    WithdrawBreachesCapacity,
}

/// Convert a [`kadex_math::MathError`] into an Anchor error. All program
/// arithmetic goes through here, so no overflow becomes a wrong number.
pub fn m<T>(r: core::result::Result<T, kadex_math::MathError>) -> Result<T> {
    r.map_err(|_| error!(InterfaceError::MathFailure))
}

/// Convert a [`kadex_risk::RiskError`] into an Anchor error.
///
/// This is the whole adapter between the pure risk crate and the programs:
/// `kadex-risk` never constructs an Anchor error, and the programs never
/// reimplement a rule.
pub fn r<T>(res: core::result::Result<T, kadex_risk::RiskError>) -> Result<T> {
    use kadex_risk::RiskError as E;
    res.map_err(|e| match e {
        E::StateForbidsOpen => error!(InterfaceError::StateForbidsOpen),
        E::OracleNotTradeable => error!(InterfaceError::OracleNotTradeable),
        E::ZeroNotional => error!(InterfaceError::ZeroNotional),
        E::InsufficientMargin => error!(InterfaceError::InsufficientMargin),
        E::CapacityExceeded => error!(InterfaceError::CapacityExceeded),
        E::UtilizationTooHigh => error!(InterfaceError::UtilizationTooHigh),
        E::NotLiquidatable => error!(InterfaceError::NotLiquidatable),
        E::WithdrawBreachesCapacity => error!(InterfaceError::WithdrawBreachesCapacity),
        E::Math => error!(InterfaceError::MathFailure),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_machine_permissions_match_the_spec() {
        use MarketState::*;
        assert!(Active.allows_open() && Active.allows_close() && Active.allows_deposit());
        assert!(!ReduceOnly.allows_open(), "ReduceOnly must not add risk");
        assert!(ReduceOnly.allows_close() && ReduceOnly.allows_liquidate());
        assert!(!ReduceOnly.allows_withdraw(), "withdrawals freeze in ReduceOnly");
        // Settled unwinds, it does not trade: closing and liquidating stay
        // open so margin can come home and stale positions can be cleared.
        assert!(!Settled.allows_open());
        assert!(!Settled.allows_deposit() && !Settled.allows_withdraw());
        assert!(Settled.allows_close() && Settled.allows_liquidate());
    }

    #[test]
    fn only_an_ok_oracle_is_tradeable() {
        use OracleState::*;
        assert!(Ok.is_tradeable());
        for s in [Stale, ShallowDepth, Diverged, Uninitialized] {
            assert!(!s.is_tradeable(), "{s:?} must not allow opening");
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

    #[test]
    fn params_projection_is_faithful() {
        // Guards the one place the serializable params and the pure params
        // meet. If someone adds a field to one and forgets the other, the
        // risk engine silently runs on a default — this catches that.
        let p = PoolParams::default();
        let r = p.risk();
        assert_eq!(r.phi, p.phi);
        assert_eq!(r.delta_max, p.delta_max);
        assert_eq!(r.mu, p.mu);
        assert_eq!(r.delta_liq, p.delta_liq);
        assert_eq!(r.base_leverage, p.base_leverage);
        assert_eq!(r.maintenance_margin, p.maintenance_margin);
        assert_eq!(r.r0, p.r0);
        assert_eq!(r.r1, p.r1);
        assert_eq!(r.psi, p.psi);
        assert_eq!(r.reduce_only_utilization, p.reduce_only_utilization);
        assert_eq!(r.liquidator_fee_bps, p.liquidator_fee_bps);
        assert_eq!(r.attack_safety, p.attack_safety);
    }

    #[test]
    fn every_risk_error_maps_to_a_distinct_anchor_error() {
        use kadex_risk::RiskError as E;
        let all = [
            E::StateForbidsOpen,
            E::OracleNotTradeable,
            E::ZeroNotional,
            E::InsufficientMargin,
            E::CapacityExceeded,
            E::UtilizationTooHigh,
            E::NotLiquidatable,
            E::WithdrawBreachesCapacity,
            E::Math,
        ];
        let codes: Vec<String> = all
            .iter()
            .map(|e| format!("{:?}", r::<()>(Err(*e)).unwrap_err()))
            .collect();
        for (i, a) in codes.iter().enumerate() {
            for b in codes.iter().skip(i + 1) {
                assert_ne!(a, b, "two risk errors collapsed onto the same code");
            }
        }
    }

    #[test]
    fn collateral_marks_down_fast_and_up_slowly() {
        let view = |price, slow| OracleView {
            price,
            twap: price,
            ts: 0,
            depth: 0,
            slow_twap: slow,
            state: OracleState::Ok,
            max_staleness_secs: 900,
        };
        let par = WAD as u64;

        // a push upward is ignored until the slow price catches up
        assert_eq!(view(par * 2, par).mark_price(), par);
        // a fall is taken immediately
        assert_eq!(view(par / 2, par).mark_price(), par / 2);
        // agreement means no effect
        assert_eq!(view(par, par).mark_price(), par);
        // before the first slow sample, fall back rather than mark to zero
        assert_eq!(view(par, 0).mark_price(), par);
    }

    #[test]
    fn marking_never_exceeds_the_tradeable_price() {
        // If it could, the pool would value collateral above what the market
        // it is quoted against would pay for it.
        let par = WAD as u64;
        for (p, s) in [(par, par * 3), (par * 3, par), (par, par), (1, par)] {
            let v = OracleView { price: p, twap: p, ts: 0, depth: 0, slow_twap: s, state: OracleState::Ok, max_staleness_secs: 900 };
            assert!(v.mark_price() <= v.price);
        }
    }

    fn view_at(ts: i64, state: OracleState) -> OracleView {
        OracleView { price: WAD as u64, twap: WAD as u64, ts, depth: 0, slow_twap: WAD as u64, state, max_staleness_secs: 900 }
    }

    #[test]
    fn a_stored_ok_state_does_not_make_an_old_price_tradeable() {
        // The bug this guards: state is only rewritten by refresh_price, so
        // when every keeper stops it reads Ok forever. Freshness must be
        // judged against the clock at the moment of use.
        let v = view_at(1_000, OracleState::Ok);
        assert!(v.require_tradeable(1_000 + 900).is_ok());
        assert!(v.require_tradeable(1_000 + 901).is_err(), "stale price admitted new risk");
        assert!(v.require_markable(1_000 + 901).is_err());
    }

    #[test]
    fn a_never_refreshed_oracle_is_not_fresh() {
        assert!(!view_at(0, OracleState::Ok).is_fresh(100));
    }

    #[test]
    fn issuing_marks_high_and_redeeming_marks_low() {
        let par = WAD as u64;
        for (p, s) in [(par, par * 2), (par * 2, par), (par, par)] {
            let v = OracleView { slow_twap: s, price: p, ..view_at(1, OracleState::Ok) };
            assert!(v.issue_price() >= v.mark_price());
        }
    }

    fn loader_account(owner: Pubkey, data: Vec<u8>) -> (Pubkey, u64, Vec<u8>, Pubkey) {
        (crate::ID, 0, data, owner)
    }

    #[test]
    fn upgrade_authority_reads_loader_v4_header() {
        let auth = Pubkey::new_unique();
        let mut data = vec![0u8; 48];
        data[8..40].copy_from_slice(auth.as_ref());
        data[40..48].copy_from_slice(&1u64.to_le_bytes()); // Deployed
        let (key, mut lamports, mut data, owner) = loader_account(LOADER_V4_ID, data);
        let ai = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, true);
        assert_eq!(upgrade_authority(&ai, None).unwrap(), auth);
        assert!(require_deployer(&ai, None, &crate::ID, &auth).is_ok());
        assert!(require_deployer(&ai, None, &crate::ID, &Pubkey::new_unique()).is_err());
    }

    #[test]
    fn a_finalized_program_has_no_deployer() {
        let mut data = vec![0u8; 48];
        data[40..48].copy_from_slice(&2u64.to_le_bytes());
        let (key, mut lamports, mut data, owner) = loader_account(LOADER_V4_ID, data);
        let ai = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, true);
        assert!(upgrade_authority(&ai, None).is_err());
    }

    #[test]
    fn upgrade_authority_reads_loader_v3_program_data() {
        let auth = Pubkey::new_unique();
        let pd_key = Pubkey::new_unique();
        let mut prog = vec![0u8; 36];
        prog[0..4].copy_from_slice(&2u32.to_le_bytes());
        prog[4..36].copy_from_slice(pd_key.as_ref());
        let mut pd = vec![0u8; 45];
        pd[0..4].copy_from_slice(&3u32.to_le_bytes());
        pd[12] = 1;
        pd[13..45].copy_from_slice(auth.as_ref());
        let (key, mut l1, mut prog, owner) = loader_account(LOADER_V3_ID, prog);
        let mut l2 = 0u64;
        let prog_ai = AccountInfo::new(&key, false, false, &mut l1, &mut prog, &owner, true);
        let pd_ai = AccountInfo::new(&pd_key, false, false, &mut l2, &mut pd, &owner, false);
        assert_eq!(upgrade_authority(&prog_ai, Some(&pd_ai)).unwrap(), auth);
        assert!(upgrade_authority(&prog_ai, None).is_err(), "v3 needs program data");
    }

    #[test]
    fn the_perp_id_here_matches_the_perp_program() {
        // perp's declare_id! cannot be imported here without a cycle, so the
        // string is pinned in both places and checked in perp's tests too.
        assert_eq!(PERP_PROGRAM_ID.to_string(), "BcVwJ91Jd1k7xUNcGYzRygq2ubaCYn7p5MeUZzy1EyLR");
    }

    #[test]
    fn side_round_trips_between_representations() {
        for s in [Side::Long, Side::Short] {
            let back: Side = kadex_math::Side::from(s).into();
            assert_eq!(back, s);
        }
    }
}
