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

## Blocker #1 — the real AMM layout

**The on-chain layout of the real fraction/USDC pool is not yet confirmed.**

The `Meteora`, `Orca` and `Raydium` adapters return an error in Rust
(`AdapterUnsupported`) and throw in TypeScript. This is deliberate: returning
zero, or a plausible number, would be worse, because the market would open on
an invented price.

The `Mock` adapter reads its own layout (8 discriminator bytes + two
little-endian u64) and covers devnet and tests.

When the real layout is confirmed, **only** these change:

- `programs/oracle/src/adapter.rs`
- `packages/oracle/src/index.ts`

Nothing in `perp`, `clp-pool` or the frontend is touched.
