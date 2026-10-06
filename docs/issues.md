# Open issues

Status of the twelve. Four are closed in code, three are decisions nobody can
make for you, three were already structural, one is a communication job, one is
accepted.

Last reviewed 2 Oct 2026.

> **card-vault was unreachable on-chain until 2 Oct.** `whitelist_card` created
> the vault account without storing its bump, so every `fractionalize` derived
> a different PDA and failed `ConstraintSeeds`. No card could ever be
> deposited. Two unit tests and no integration coverage is how that survived;
> `tests/integration/vault.test.mjs` is why it cannot recur.

| # | Issue | Status |
|---|---|---|
| 1 | Who provides the first AMM liquidity | **Decision** — calculator built |
| 2 | NAV circularity | **Mitigated in code** |
| 3 | Fraction decimals and supply | **Verified** |
| 4 | Which DEX, native TWAP or accumulate | **Answered** — we accumulate |
| 5 | Keeper liveness | **Fixed** |
| 6 | Integer arithmetic, operation order | **Fixed** — property tests |
| 7 | Impermanent loss for AMM LPs | **Numbers below**, frontend's job |
| 8 | External fills feed | Already non-blocking by design |
| 9 | Upgrade authority | **Decision** before anything real |
| 10 | Basket fragmentation | Structural, not a convention |
| 11 | Collector Crypt format changes | Already isolated |
| 12 | Regulatory | Accepted, declared |

---

## 1 — Who provides the first AMM liquidity (DECISION)

Still yours to make. What changed is that it is now a number rather than a
feeling:

```sh
node scripts/size-market.mjs            # the whole table
node scripts/size-market.mjs 50000      # one size
```

```
  AMM depth    CLP sleeve   max OI     binding    attack cost  attacker gain
  $25,000      $50,000      $3,738     depth      $2,243       $1,121
  $50,000      $100,000     $7,477     depth      $4,486       $2,243
  $100,000     $200,000     $14,954    depth      $8,972       $4,486
  $250,000     $500,000     $37,385    depth      $22,431      $11,215
```

Three things fall out of it:

- **Depth binds at every size.** Adding USDC to the CLP does almost nothing
  for market size; adding AMM liquidity does all of it.
- **$25k is the floor, not a target.** Below it the oracle reports
  `ShallowDepth` and refuses to price risk at all.
- **$50k of AMM depth gives ~$7.5k of open interest**, which carries the
  $3,200 hedge in the product mock with room to spare.

## 2 — NAV circularity (MITIGATED)

The problem: one AMM priced both the perp and the CLP's card sleeve, so a
single push moved a trader's PnL *and* inflated the collateral behind that same
position. In one transaction.

```
AMM +10%  -> sleeve  66,000  NAV 206,000  (+3.0%)
AMM +50%  -> sleeve  90,000  NAV 230,000  (+15.0%)
```

The oracle now keeps a second, deliberately sluggish price — `slow_twap`, an
EMA at α=0.01, roughly fifty minutes to follow a step change. The pool marks
its card sleeve at `min(price, slow_twap)`:

- a push **upward** is ignored for hours, because the slow EMA lags
- a fall is taken **immediately**, because the fast price is lower

Collateral marks down fast and up slowly, which is the only direction a pool
should ever be wrong in. `perp` still uses the fast price for PnL — a position
has to settle at what the market says now, not at a lagging average.

**It is not eliminated.** Someone willing to hold a pushed price for hours
still moves both. It removes the single-transaction version, which is the one
that pays. Say that, rather than claiming it is solved.

## 3 — Fraction decimals and supply (VERIFIED)

6 decimals, 1 fraction = $1, matching USDC. Checked rather than asserted:
`six_decimals_prices_real_cards_without_visible_rounding` round-trips the four
cards in the product mock plus a $4,200 Charizard through the oracle's WAD
price and loses at most one unit — a millionth of a dollar.

`a_single_fraction_is_still_worth_something` guards the other end: if one
fraction rounded to zero, dust deposits would mint CLP for free.

The matching decimals are what make `price × quantity` land directly in native
USDC with no conversion step to get wrong. Changing `FRACTION_DECIMALS` breaks
the oracle silently, which is why there is a test asserting it is 6.

## 4 — Which DEX, native TWAP or accumulate (ANSWERED)

**The question does not bind, because we never depend on a native TWAP.**

`refresh_price` reads raw reserves and accumulates its own: a 32-slot ring
buffer for the 30-minute TWAP, plus the slow EMA. Whether Meteora, Orca or
Raydium exposes an oracle is irrelevant to correctness — we would ignore it
either way, because we need the clamp and the depth floor applied to the same
number, and a native oracle gives us neither.

So the DEX choice collapses to two ordinary questions: can the adapter read its
reserves, and is there liquidity there. Both are answered by writing one
adapter function, which is why `AmmAdapter` is an enum with one implementation
per venue and `Mock` for devnet.

## 5 — Keeper liveness (FIXED)

Permissionless means anyone *can* call it, not that anyone *will*.

- interval dropped from 30s to **5s**, and the binding reason is liquidation,
  not staleness — see below
- documented: run **at least two** keepers, different machines, different
  payers. A lost race costs one failed transaction; `refresh_price` recomputes
  from scratch and is idempotent within a slot.
- if every keeper stops, the oracle ages past `max_staleness_secs` and the
  market goes `ReduceOnly` by itself. Positions still close and liquidate. The
  failure mode is "no new risk", not "funds stuck".

**Why 5s and not 30s.** Liquidation uses the clamped oracle price, which moves
at most 5% per refresh. A 5x position liquidates after a 13.75% move, so the
oracle needs three refreshes to get there:

```
keeper every 30s ->  90s of lag
keeper every  5s ->  15s of lag
```

In that window a position is underwater at spot but not yet liquidatable at the
oracle price. That window is where bad debt comes from:

```
spot -13.75% -> equity  +6.25% of notional
spot -20.00% -> equity   0.00%
spot -30.00% -> equity -10.00%   <- bad debt
```

This is the clamp cutting both ways: it stops someone pushing the price to hunt
liquidations, and it delays legitimate liquidations by the same mechanism. You
cannot have one without the other. Running the keeper faster is the cheap lever;
raising maintenance margin is the expensive one.

## 6 — Integer arithmetic and operation order (FIXED)

`a * b / c` reordered to `a / c * b` gives a different answer, and the
difference only shows at inputs nobody picks by hand. There are now property
tests running 20,000 cases each, with a fixed seed so a failure replays:

- a deposit/withdraw round trip never creates value
- long and short PnL always cancel exactly
- a proportional slice never exceeds its sleeve
- redeeming the whole supply drains it exactly, no more
- `ceil` is never below `floor` and never more than one above
- utilization never leaves `[0, 1]`
- the haircut is monotone in what is available
- the depth ceiling only ever grows with depth
- **nothing panics on adversarial input** — every entry point returns an error
  rather than unwinding, because a panic on-chain aborts with no useful error

### A real finding from this work

Building the sizing calculator exposed that the depth ceiling had **no margin
at all**. `cap = cost / mu` means `cap × mu == cost`, so at the ceiling an
attack broke even exactly and rounding decided whether it paid.

There is now an `attack_safety` parameter, default **2.0**: moving the price
must cost twice what the cascade pays. It halves the ceiling, which is the
correct price for the difference between an invariant and a coin flip.

## 7 — Impermanent loss (FRONTEND'S JOB)

Not a backend issue; it is a thing the UI must not hide.

```
  price move   LP value vs just holding
      +10%        -0.11%
      +25%        -0.62%
      +50%        -2.02%
     +100%        -5.72%
     -25%        -1.03%
     -50%        -5.72%
     -75%       -20.00%
```

Cards are not a stablecoin pair. A card doubling costs the AMM LP 5.7% against
simply holding it, and that is the ordinary case, not the tail.

Two distinct roles, and the UI must not blur them:

- **AMM LP** (fractions/USDC) takes impermanent loss, earns swap fees
- **CLP depositor** takes trader PnL, earns trading fees — a different product
  with a different risk

Copy for the deposit screen: *"You are providing a two-sided market. If the
card's price moves sharply in either direction you will hold less of the
winning side than if you had simply kept your cards. Swap fees are what you are
paid for that."*

## 8 — External fills feed (ALREADY NON-BLOCKING)

Fills are a sanity bound, never a price source. If the feed dies the market
loses one defence and keeps working, which is deliberate: making a secondary
defence into a single point of failure is worse than not having it.

Test: `a_missing_external_feed_degrades_instead_of_halting`, in both the pure
and on-chain suites.

## 9 — Upgrade authority (DECISION, NOT YET)

On devnet the deploying keypair holds it and that is fine. Before anything
holding real value, the answer has to be one of: a multisig, a timelock, or
burned.

Not worth spending submission time on. Worth having an answer ready if a judge
asks, because "the deployer can replace the program" undoes every other
guarantee in this document.

## 10 — Basket fragmentation (STRUCTURAL)

Handled by a field, not a convention. `Pool.fraction_mint` is bound at
`initialize_pool` and there is no instruction that rebinds it — verified: the
field is assigned in exactly one place. A second basket needs a second pool and
a second market, which is a deliberate act rather than an accident.

It matters because splitting liquidity makes each pool shallower, and by the
depth ceiling a shallower pool is cheaper to attack and supports less open
interest. Two $25k baskets are strictly worse than one $50k basket.

## 11 — Collector Crypt format changes (ALREADY ISOLATED)

The only thing that knows their layout is one function in
`programs/oracle/src/adapter.rs` plus its TypeScript twin. If they change it,
that function changes and nothing else does.

Unimplemented adapters **fail loudly** rather than return a plausible number,
because a market opening on an invented price is worse than a market that will
not open.

## 12 — Regulatory (ACCEPTED)

Securities, derivatives and gambling regimes overlap here. Declared in the
submission, not resolved. Nothing in the backend changes this either way.
