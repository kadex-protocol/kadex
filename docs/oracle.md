# Oracle

> Owner: Backend A. Consumed by Backend B only through `OracleView`.

## The design

```
external AMM reserves
        │
        ▼  spot = usdc_reserve / fraction_reserve
   observation in the ring buffer (32 slots)
        │
        ▼  TWAP over a 30-minute window
   5% clamp per update against the previous price
        │
        ▼
   OFFICIAL PRICE  ──> perp (PnL, liquidation), clp-pool (sleeve marking)
```

External fills are **not a price source**. They arrive as `external_median`
and serve only as a sanity bound. If that feed fails, the market loses one
defence and keeps working.

## Why there is no oracle key

`refresh_price` is permissionless and recomputes everything from on-chain
state. There is no off-chain signature to steal, and if our keeper goes down
anyone can keep the price alive.

This is an improvement over the earlier version of the spec, which had a
signed oracle with a single key listed as a risk.

## The four defences

| Defence | Parameter | Attack it blocks |
|---|---|---|
| TWAP | `twap_window_secs` = 1800 | single-block manipulation |
| Per-tick clamp | `max_tick_move` = 5% | a jump to hunt liquidations |
| Minimum depth | `min_pool_depth` = $25k | pulling liquidity to make the oracle cheap |
| External divergence | `max_divergence` = 15% | sustained manipulation of the pool |

Plus `max_staleness_secs` = 900, which drops the oracle to `Stale`.

The clamp **does not prevent slow manipulation**. It makes it expensive and
kills the instantaneous, profitable version. A test measures this:
`clamp_reaches_the_target_over_repeated_updates` proves that moving the price
50% takes at least 8 consecutive updates.

## The frozen interface

```rust
pub struct OracleView {
    pub price: u64,   // WAD, TWAP and clamp applied — use this one
    pub twap: u64,    // WAD, raw, diagnostics only
    pub ts: i64,
    pub depth: u64,   // native USDC, feeds the OI ceiling
    pub state: OracleState,
}

impl OracleView {
    fn require_tradeable(&self) -> Result<u64>;  // OracleState::Ok only
    fn require_markable(&self, now, max_staleness) -> Result<u64>;
    fn risk_input(&self) -> slab_risk::PriceInput;
}
```

`require_tradeable` is for opening risk. `require_markable` is for liquidating
and marking — allowed outside `Ok`, because blocking liquidation would leave
rotten positions accumulating.

Backend B calls `OpenPosition::oracle_view()` and never deserializes by hand.

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
