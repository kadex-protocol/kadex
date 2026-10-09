# Economic invariants

Each one is a test. If a test on this list goes red, the protocol is wrong —
not the test.

## 1. Solvency

```
OI_total × δ_max  ≤  U × φ
```

A winning trader is always paid out of the liquid sleeve. An opening that
would breach this is **refused in the same transaction**, not corrected later.

- Rust: `kadex_risk::check_open`
- Test: `kadex_risk::tests::opening_past_the_solvency_ceiling_is_refused`

## 2. Two ceilings, and the lower one wins

```
OI_allowed = min( U × φ / δ_max ,  R × (√(1+δ_liq) − 1) / μ )
```

Never the average, never the higher. With the spec parameters **the depth
ceiling binds 13x before solvency does** — it is AMM liquidity that sizes the
market, not the CLP balance.

- Rust: `kadex_risk::capacity`
- Test: `kadex_risk::tests::depth_ceiling_binds_long_before_solvency_does`

## 3. Utilization and borrow

```
u = OI_total / OI_allowed
r_hourly = r0 + r1 × u²
```

The quadratic term makes the rate climb slowly while capacity remains and
spike near the ceiling. The pool becomes expensive before it is cornered.

- Test: `kadex_risk::tests::borrow_grows_quadratically_with_utilization`

## 4. The crowded side pays more

```
r_side = r_hourly × (1 + ψ × max(0, (OI_side − OI_opposite) / OI_total))
```

The thin side never pays a premium — its multiplier is exactly 1.0.

- Test: `kadex_risk::tests::the_crowded_side_pays_more`

## 5. NAV

```
vault       = U + margin_held + protocol_fees_owed
NAV_redeem  = U + Σ(qᵢ × min(p, slow)) − max(trader_PnL(p), 0)
NAV_issue   = U + Σ(qᵢ × max(p, slow)) − trader_PnL(p)
```

`U` is the LPs' money and nothing else. Trader margin and the protocol's share
of fees are in the same vault but **held apart**, so neither can be withdrawn
by LPs or counted as capacity. `trader_PnL` is marked at today's price from the
book `perp` pushes on every open and settle — never a stored number.

Value leaves at `NAV_redeem` and CLP is issued at `NAV_issue ≥ NAV_redeem`, so
no deposit followed by a withdrawal can come out ahead. Bad debt is recorded
but not deducted: the pool never received that money, so `U` already reflects
it.

Changed 6 Oct 2026. Before, deposits were priced at NAV but withdrawals paid a
raw slice of the vault, margin included: $100k in and straight out returned
$110,416 on a validator.

- Test: `clp_pool::tests::deposit_then_withdraw_*`
- Test: `clp_pool::tests::margin_is_not_lp_money`
- Test: `lifecycle: deposit then withdraw at once returns no more than went in`
- Test: `lifecycle: the vault holds exactly sleeve + margin + protocol fees`
- Test: `lifecycle: what the trader gains, the pool loses, to the unit`

### The lifecycle is zero-sum

Over a full open-to-close cycle, the trader's change in USDC, the LPs' change
in NAV and the protocol's fee share sum to exactly zero. Every unit the trader
walks away with came out of the LPs' equity; every unit the pool kept — LP
fees and borrow into the sleeve, the protocol's share beside it — came out of
the trader's. That single equality is the economic claim the project rests
on, and it is asserted end to end on a live validator.

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

- Rust: `kadex_risk::is_liquidatable` takes the oracle price, always

## 10. Bad debt is explicit

A loss past the margin is written to `Pool.bad_debt` and deducted from NAV. It
never disappears and is never hidden. Invisible bad debt is what let nftperp
trade insolvent for months.

- Test: `kadex_risk::tests::a_gap_through_the_margin_is_recorded_as_bad_debt`

## 11b. Settled unwinds, it does not trade

`Settled` forbids opening, depositing and the normal withdrawal. It still
allows **closing and liquidating**.

This was changed on 2 Oct. `Settled` originally barred both, which stranded
every open position's margin permanently. A settled market has to be able to
unwind; margin is held apart from the sleeve, so redemptions never touch it.

- Test: `clp_pool::tests::state_gates_match_the_spec`
- Test: `lifecycle: a settled market unwinds and redeems with an equal haircut`

## 11. ReduceOnly adds no new risk

It also freezes CLP withdrawals — so an LP cannot pull out exactly when the
pool most needs the buffer.

- Test: `clp_pool::tests::state_gates_match_the_spec`

## 12. Settled applies an equal pro-rata haircut

`redeem_settled` pays a proportional slice of both sleeves, scaled by
`NAV / total_assets`. Assets are what is physically in the vaults; NAV is what
belongs to the LPs after bad debt and after margin still owed to open
positions. When those liabilities exist, the raw split would hand LPs money
that is not theirs, so every holder is scaled by the same factor.

Equal is the point. The alternative — first come, first served — is what a
bank run is, and it is settled by who is awake rather than by who is owed.

- Test: `clp_pool::tests::the_settlement_haircut_is_equal_for_everyone`
- Test: `clp_pool::tests::open_positions_hold_back_their_margin_at_settlement`
- Test: `lifecycle: a settled market unwinds and redeems with an equal haircut`

## Rounding policy

Always in the pool's favour, never the user's.

| Operation | Direction | Why |
|---|---|---|
| CLP minted on deposit | down | nobody entering receives an extra share |
| assets returned on withdrawal | down | nobody leaving takes extra |
| fees, borrow, required margin | up | the user pays the cent |
| trader PnL | down in magnitude | the pool never pays the rounding cent |

Documented in `packages/kadex-math/src/lib.rs` and verified by
`kadex_math::tests::deposit_then_withdraw_never_creates_value`.
