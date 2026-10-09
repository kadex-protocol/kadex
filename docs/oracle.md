# Oracle

> Owner: Backend A. Consumed by Backend B only through `OracleView`.

## The design

```
external AMM reserves
        │
        ▼  spot = usdc_reserve / fraction_reserve        (at most once per slot)
   running integral  Σ spot × seconds_in_force
        │
        ▼  TWAP = Δintegral / Δt over a 30-minute window  (time-weighted)
   clamp: 5% per 15 seconds of ELAPSED TIME against the previous price
        │
        ▼
   OFFICIAL PRICE  ──> perp (PnL, liquidation), clp-pool (book and sleeve marking)
```

External fills are **not a price source**. They arrive as `external_median`
and serve only as a sanity bound. If that feed fails, the market loses one
defence and keeps working.

## Why there is no oracle key

`refresh_price` is permissionless and recomputes everything from on-chain
state. There is no off-chain signature to steal, and if our keeper goes down
anyone can keep the price alive.

Permissionless has a cost the first version did not pay: **anyone can call it
as often as they like.** Every defence below is therefore expressed in time,
never in calls. The audit of 6 Oct 2026 measured what happens otherwise: twelve
refreshes in one transaction moved the price **+79.6%** against a 5%-per-update
clamp, with the state still `Ok`.

## The defences

| Defence | Parameter | Attack it blocks |
|---|---|---|
| One update per slot | — | stacking refreshes in a transaction; a repeat is a successful no-op |
| Time-weighted TWAP | `twap_window_secs` = 1800 | a price pushed for one transaction: it counts only for the seconds it stays in force, starting at the *next* refresh |
| Checkpoint spacing | window / 31 | refreshing every slot to shorten the history |
| Time-scaled clamp | `max_tick_move` = 5% per `clamp_period_secs` = 15 | outrunning the clock; one full step at most after any gap |
| Minimum depth over the window | `min_pool_depth` = $25k | adding liquidity for one transaction to buy open interest; pulling it counts at once |
| External divergence | `max_divergence` = 15% | sustained manipulation of the pool |
| `CatchingUp` state | — | opening at a price the clamp is known to be holding behind the market |

Plus `max_staleness_secs` = 900. Freshness is judged **at read time** by every
consumer (`OracleView::is_fresh`), not only by the stored state: the state is
only rewritten by a refresh, so when every keeper stops it keeps saying `Ok`.

The clamp **does not prevent slow manipulation**. It makes it slow and
expensive: holding a pushed price for minutes in a pool arbitrageurs can trade
against. `the_clamp_follows_the_clock_not_the_caller` proves a 15-second burst
of refreshes in every slot moves the price at most one step.

**What the clamp costs.** Liquidations lag a fast fall by the same mechanism.
A 5x position liquidates after a 13.75% move, about 45 seconds of clamp at
5% per 15s; bad debt comes from moves faster than that. Maintenance margin is
the lever if that is too slow.

## The frozen interface

```rust
pub struct OracleView {
    pub price: u64,      // WAD, TWAP and clamp applied — use this one
    pub twap: u64,       // WAD, raw, diagnostics only
    pub ts: i64,
    pub depth: u64,      // native USDC, window minimum, feeds the OI ceiling
    pub slow_twap: u64,  // collateral marking only
    pub state: OracleState,
    pub max_staleness_secs: u32,
}

impl OracleView {
    fn require_tradeable(&self, now) -> Result<u64>;  // fresh AND Ok
    fn require_markable(&self, now) -> Result<u64>;   // fresh, any state
    fn mark_price(&self) -> u64;   // min(price, slow): value leaving the pool
    fn issue_price(&self) -> u64;  // max(price, slow): CLP being issued
    fn risk_input(&self) -> kadex_risk::PriceInput;
}
```

`require_tradeable` is for opening risk. `require_markable` is for closing,
liquidating and LP flows — allowed outside `Ok`, because blocking liquidation
would leave rotten positions accumulating. Both refuse a stale price; a caller
prepends `refresh_price` to the same transaction, which is a no-op if somebody
already refreshed in that slot.

Backend B calls `OpenPosition::oracle_view()` and never deserializes by hand.

## Who can create an oracle

Only the oracle program's upgrade authority (`require_deployer`). The oracle
PDA is per basket and the market binds to it, so a permissionless `initialize`
let the first caller choose the AMM account and the parameters. The `Mock`
adapter additionally refuses any account the mock AMM program does not own.

## The Raydium CPMM adapter

Blocker #1 is closed for one venue. The index token trades in a **Raydium
CPMM** pool (`raydium-io/raydium-cp-swap`), a plain two-reserve
constant-product AMM, so `usdc_reserve / index_reserve` is the exact spot and
every defence above applies unchanged. Concentrated-liquidity and bin pools
(Orca Whirlpools, Raydium CLMM, Meteora DLMM) were ruled out: their reserves do
not give the price directly. Meteora DAMM routes liquidity through lending
vaults, so its token accounts are not its reserves either.

| Check | Rejects |
|---|---|
| owner is Raydium CPMM (mainnet `CPMMoo8L…` or devnet `DRaycpLY…`) | a pool from any other program |
| 637 bytes, `PoolState` discriminator | any other account |
| both token programs classic SPL Token | Token-2022 sides |
| both mints 6 decimals | anything that would need rescaling — refused, not rescaled |
| swaps enabled (status bit 2 clear) | a frozen pool whose reserves nobody can trade |
| the oracle's `basket` is exactly one of the two mints | an unpaired or self-paired pool |
| each vault is the one the pool records, an initialized SPL account of that side's mint, owned by Raydium's authority PDA (`vault_and_lp_mint_auth_seed` + the pool's bump) | swapped, substituted, look-alike or frozen vaults |
| fees owed ≤ vault balance; fee counters do not overflow | wrapped arithmetic |

**Reserves are not the vault balances.** Each vault also holds protocol, fund
and creator fees the pool owes and has not paid out; usable reserves are the
balance minus those, exactly Raydium's `vault_amount_without_fee`. A devnet
pool found while building this held 800,001 units of which 800,000 were fees.

**Orientation comes from the basket.** For a real pool the oracle's `basket` is
the index token's mint. The side whose mint is the basket is the index; the
other is USDC. `initialize` refuses a pool that does not pair the basket.

**The vaults arrive as remaining accounts.** `refresh_price` takes the pool
account as before and, for Raydium, its two vaults after it, in order. The
program trusts none of them; `refreshAccountsFor` in `@kadex/sdk` finds them
for callers (keeper, liquidator, web app).

Rust: `programs/oracle/src/adapter.rs`. TypeScript twin:
`packages/oracle/src/raydium.ts`. Both are tested on the same Raydium pool
captured from devnet (`tests/fixtures/raydium_cpmm_pool.json`), with the same
expected numbers, and the on-chain suite (`tests/integration/raydium.test.mjs`)
runs against Raydium's real devnet binary.

`Meteora` and `Orca` still return `AdapterUnsupported` / throw.

### Not checked by the oracle

- **That the pool's quote mint is the CLP pool's USDC.** The oracle knows the
  index mint (its basket); `clp-pool` binds its own `usdc_mint` and
  `fraction_mint` and does not compare them with the oracle's pool. Both are
  created by the upgrade authority, so this is a deployment invariant
  (`scripts/devnet.mjs` creates them together), not a runtime check. Adding it
  touches `clp-pool`.
- **Liquidity depth beyond the existing floor.** Thin pools are handled by
  `min_pool_depth` ($25k, window minimum) and the depth ceiling on open
  interest, unchanged.
