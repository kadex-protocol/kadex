# Economic invariants

Each one is a test. If a test on this list goes red, the protocol is wrong —
not the test.

## 1. Solvency

```
OI_total × δ_max  ≤  U × φ
```

A winning trader is always paid out of the liquid sleeve. An opening that
would breach this is **refused in the same transaction**, not corrected later.

- Rust: `slab_risk::check_open`
- Test: `slab_risk::tests::opening_past_the_solvency_ceiling_is_refused`

## 2. Two ceilings, and the lower one wins

```
OI_allowed = min( U × φ / δ_max ,  R × (√(1+δ_liq) − 1) / μ )
```

Never the average, never the higher. With the spec parameters **the depth
ceiling binds 13x before solvency does** — it is AMM liquidity that sizes the
market, not the CLP balance.

- Rust: `slab_risk::capacity`
- Test: `slab_risk::tests::depth_ceiling_binds_long_before_solvency_does`

## 3. Utilization and borrow

```
u = OI_total / OI_allowed
r_hourly = r0 + r1 × u²
```

The quadratic term makes the rate climb slowly while capacity remains and
spike near the ceiling. The pool becomes expensive before it is cornered.

- Test: `slab_risk::tests::borrow_grows_quadratically_with_utilization`

## 4. The crowded side pays more

```
r_side = r_hourly × (1 + ψ × max(0, (OI_side − OI_opposite) / OI_total))
```

The thin side never pays a premium — its multiplier is exactly 1.0.

- Test: `slab_risk::tests::the_crowded_side_pays_more`

## 5. NAV

```
NAV = U + Σ(qᵢ × pᵢ) − trader_PnL − bad_debt
```

Trader profit leaves the pool one for one. No rounding creates value.

- Test: `clp_pool::tests::trader_profit_reduces_nav_one_for_one`

## 6. CLP price

```
CLP_price = NAV / CLP_supply
```

An empty pool is worth 1.0 by convention (first deposit).

## 7. Proportional withdrawal

Redemptions leave **both sleeves** proportionally, always. There is no
USDC-only path. If there were, the first out would take the liquid side and
the last would be left holding the whole illiquid one.

- Test: `clp_pool::tests::withdrawals_are_proportional_and_never_usdc_only`

## 8. The card sleeve never pays a winning trader

Which is why the open-interest ceiling looks at `usdc_sleeve` and not at total
NAV.

## 9. Liquidation uses the oracle price

Never an internal price. With an internal price, someone would push it to hunt
other people's liquidations.

- Rust: `slab_risk::is_liquidatable` takes the oracle price, always

## 10. Bad debt is explicit

A loss past the margin is written to `Pool.bad_debt` and deducted from NAV. It
never disappears and is never hidden. Invisible bad debt is what let nftperp
trade insolvent for months.

- Test: `slab_risk::tests::a_gap_through_the_margin_is_recorded_as_bad_debt`

## 11. ReduceOnly adds no new risk

It also freezes CLP withdrawals — so an LP cannot pull out exactly when the
pool most needs the buffer.

- Test: `clp_pool::tests::state_gates_match_the_spec`

## 12. Settled applies an equal pro-rata haircut

Everyone takes the same cut. No queue, no privilege.

- Test: `clp_pool::tests::the_settlement_haircut_is_equal_for_everyone`

## Rounding policy

Always in the pool's favour, never the user's.

| Operation | Direction | Why |
|---|---|---|
| CLP minted on deposit | down | nobody entering receives an extra share |
| assets returned on withdrawal | down | nobody leaving takes extra |
| fees, borrow, required margin | up | the user pays the cent |
| trader PnL | down in magnitude | the pool never pays the rounding cent |

Documented in `packages/slab-math/src/lib.rs` and verified by
`slab_math::tests::deposit_then_withdraw_never_creates_value`.
