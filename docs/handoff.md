# Handoff — start here

> Read this file before your first commit. Ten minutes, and it saves a week of
> rework.

Submission deadline: **12 Oct 2026**. Today is 1 Oct. Eleven days left.

## 1. Running it in five minutes

```sh
git clone https://github.com/Ooffset/slab.git
cd slab
npm install
npm run sync-keys        # keys/ -> target/deploy/ — fixed program IDs, don't skip
npm run build:programs   # NOT `anchor build` — see docs/deploying.md
cargo test --workspace   # 102 tests, under a second
npm run test:parity      # 21 Rust <-> TS parity tests
npm run test:integration # 19 on-chain tests, ~7min, boots a validator
```

You need Rust 1.89 (`rust-toolchain.toml` handles it), Solana CLI 3.1.10,
Anchor CLI 1.2.0, Node 22+.

If `cargo test` passes and `npm run build:programs` ends with "all programs
are deployable", your environment is correct.

**Do not run `anchor build` on its own.** It emits SBPF v3 binaries that the
Solana CLI cannot parse, so they cannot be deployed anywhere — including
devnet. `docs/deploying.md` explains it; Blocker #7 tracks it.

## 2. What already exists

149 tests passing. No risk handler is implemented yet except
`open_position` — deliberately. Day 1 was about getting the boundaries right
before anyone builds on top of them.

| Piece | State |
|---|---|
| `packages/slab-math` | **done** — fixed point, 32 tests |
| `packages/slab-risk` | **done** — every risk rule, 23 tests |
| `packages/slab-interface` | **frozen** — the contract between tracks |
| `programs/oracle` | accounts + all four defences, 11 tests. litesvm blocked (#6) |
| `programs/mock-amm` | constant-product price surface for devnet, 8 tests |
| `programs/card-vault` | full NFT↔fraction cycle, 2 tests. Missing: litesvm |
| `programs/clp-pool` | deposit, withdraw, settle CPI door, 14 tests |
| `programs/perp` | open, close, liquidate — all three complete |
| `packages/types` `packages/sdk` | PDAs and maths ready for the frontend |
| `apps/keeper` | **done** — permissionless refresh loop |
| `apps/liquidator` | scanner + decoder done; market/pool decode pending |
| `apps/web` | empty |

## 3. The pattern — copy this shape

Open `programs/perp/src/lib.rs` and read `open_position`. Every instruction in
this codebase follows it:

1. Anchor validates the accounts, in the `#[derive(Accounts)]` constraints
2. the handler reads what it needs and calls **one** function in `slab-risk`
3. the handler moves tokens and writes state
4. the handler emits an event

**The handler decides nothing.** Every rule — both ceilings, the margin
requirement, the utilization gate — lives in `slab-risk`.

This is not a style preference. It is why 152 tests run in under a second with
no validator. If rules move into handlers, that goes away and everyone pays
for it in iteration speed for the remaining ten days.

Two tests enforce it, and they fail in the `cargo test` of whoever broke them:

- `handlers_stay_thin` — a handler over 45 lines fails the build
- `risk_crate_cannot_reach_solana` — `slab-risk` must never depend on
  `anchor-lang` or `solana-program`

That second one is the real guarantee. `slab-risk` has no `AccountInfo`, no
`Context`, no `Signer` reachable from it. You *cannot* write account handling
inside a risk rule, because the types do not exist there.

## 4. The four architecture decisions you need to know

### 4.1 Four programs, not three

The spec describes three. The oracle became its own program.

Account ownership in Solana is per program. With `OracleAccount` inside
`clp-pool`, whoever writes prices and whoever writes risk would be editing the
same crate every day — exactly what this structure exists to prevent.

Cost: zero CPI. `perp` takes the account and deserializes it; Anchor checks
the owner itself, because `slab-interface` declares the oracle program's ID.
An account forged by another program is rejected before our logic runs.

### 4.2 There is no oracle key

`refresh_price` is permissionless and recomputes everything from on-chain
state. There is no off-chain signature to steal, and if our keeper dies anyone
can keep the price alive.

### 4.3 Unimplemented adapters fail loudly

`Meteora`, `Orca` and `Raydium` return errors in both Rust and TypeScript.
Returning zero, or a plausible number, would open the market on an invented
price. Do not "fix" this by returning a value.

### 4.4 Rounding always favours the pool

Deposits and withdrawals round down; fees, borrow and required margin round
up. Documented in `packages/slab-math/src/lib.rs` and tested.

## 5. What is FROZEN

Changing any of these breaks someone else's work in flight.

1. `slab_interface::seeds` — every PDA
2. `OracleAccount` and `OracleView` — the A↔B interface
3. `PoolParams` — economic configuration
4. `MarketState` and `OracleState`
5. Scales: WAD = 1e6, BPS = 1e4, RAY = 1e12
6. `FRACTION_DECIMALS = 6` — changing it breaks the oracle silently
7. The four program IDs in `keys/`

**Still need to change one?** The process is at the top of
`packages/slab-interface/src/lib.rs`: say why, list what it affects, update the
docs, update the tests, tell whoever is blocked. In that order.

## 6. Code rules

**No floating point anywhere near money.** Intermediates in `u128`/`i128`,
back to `u64` only through `to_u64`, which errors instead of truncating.

**In TypeScript, everything is BigInt.** `Number` loses precision above 2^53
and a native USDC balance passes that easily. Convert to `Number` on the last
line, for display only.

**Write tests alongside the code, not after.** And write the negative ones:
they carry more weight in judging than the positive ones.

**Small, isolated commits.** Never mix oracle, risk and frontend in one.

## 7. Who does what

### Backend A — asset and oracle

Branch: `backend/card-vault-oracle`

| Day | Task |
|---|---|
| ✅ D1 | fraction decimals fixed at 6 |
| ✅ D3 | `mock-amm`: a real curve whose price can be pushed |
| ✅ D4 | reserve reader, TWAP and clamp — tested as pure logic |
| ✅ D5–D6 | `refresh_price` on-chain, depth floor, divergence, staleness |
| ✅ | keeper: permissionless refresh loop |
| ✅ D2/D8 | 10 on-chain defence tests passing against a real validator |
| **D7** | **the price function is frozen. B is unblocked.** |

**A has reached D7.** `OracleView` is final: `price`, `twap`, `ts`, `depth`,
`state`, plus `require_tradeable`, `require_markable` and `risk_input`.
Nothing B consumes will move. What remains on A's side is the litesvm
unblock and, when Blocker #1 clears, the real AMM adapter — neither of which
changes the interface.

The D2 negatives that matter: mint outside the whitelist, redemption with
insufficient fractions, redemption by someone who does not hold all the
fractions, disabled card.

### Backend B — risk engine

Branch: `backend/risk-engine`

| Day | Task |
|---|---|
| ✅ D1–D2 | accounts + fixed point + overflow tests |
| ✅ D3–D5 | `deposit_usdc`, `deposit_fractions`, proportional `withdraw`, NAV |
| ✅ D6–D8 | `close_position`, `liquidate`, and the `settle_position` CPI door |
| ✅ D10 | liquidator scanner, decoder verified against the IDL |
| D9 | end-to-end integration — blocked with A on Blocker #6 |
| ✅ D11 | `Settled` unwind + redemption with an equal haircut |

**B's remaining work is unblocked.** The validator harness exists and works;
`tests/integration/` is where D9's end-to-end case goes. The decisions are
already tested — what is left is SPL token setup around them.

The decisions already exist and are tested: `risk::settle_close`,
`risk::settle_liquidation`, `risk::capacity`. What is missing is the token
movement around them, plus the CPI door that lets `perp` pay a winning
trader — Blocker #4.

**Do not implement a USDC-only withdrawal path**, not even as a shortcut.

### Frontend

Branch: `frontend/web`

You can start now without waiting for anyone. Already available:
`target/idl/*.json`, `target/types/*.ts`, PDAs in `@slab/types`, and
`derivePosition`, `deriveCapacity`, `deriveBorrowRates`, `derivePool` in
`@slab/sdk`.

| Day | Task |
|---|---|
| D1–D2 | Next.js scaffold, wallet adapter, account reads |
| D3–D4 | pool deposit screen: sleeves, NAV, CLP price |
| D5–D7 | trade screen: price, borrow, PnL, liquidation price |
| D8–D9 | protect-collection button, reading the wallet's cards |
| D10 | panel showing **both sides on one screen** — trader PnL and pool NAV |
| D11–D12 | script, video, submission text |

Read `docs/frontend-contract.md`. Start with mocked data in the shapes of
`PoolView`, `OracleView`, `MarketView` and `PositionView` — when the handlers
land, only the fetch changes.

### Everyone

- D12: full devnet integration, the three of you together
- D13: freeze the code, rehearse the demo twice
- D14: submit with room to spare

## 8. The one place where one of you blocks another

**D7.** Backend A freezes the price function and hands it to B. After that the
interface does not move.

Everything else is independent. B does not wait for A because it consumes
`OracleView`, and the tests build that struct by hand. The frontend waits for
nobody because the PDAs and types already exist.

## 9. Known blockers

| # | What | Severity | Owner |
|---|---|---|---|
| 1 | Real AMM on-chain layout unconfirmed | High | A |
| 2 | Who provides the first liquidity to the fraction pool | High | A + product |
| 3 | NAV circularity: one pool prices both the perp and the collateral | High | B |
| 4 | Risk CPI between `perp` and `clp-pool` | Medium | B |

**#2** is the easiest to underestimate: with no initial deposit there is no
reserve, no price, and nothing else works. And the size of that deposit sets
the open-interest ceiling for the entire market.

**#3**: the liquid sleeve mitigates it; it does not eliminate it. This goes in
the submission as written. Saying we reduced the circularity is honest; saying
we solved it is not.

## 10. The finding that changes the plan

The test `the_depth_ceiling_binds_long_before_solvency_does` confirms:

```
CLP solvency ceiling     $233,333
AMM depth ceiling         $8,972   ← binds (after the 2x attack-safety factor)
```

**AMM depth binds 26x before solvency does.** The ceiling the spec details
most will almost never bite. What sizes the market is the liquidity in the
fraction pool, not the CLP balance.

Worth the team discussing whether `phi` and `delta_max` are too conservative
for a constraint that barely ever binds.

## 10b. Issue status

`docs/issues.md` tracks all twelve. Four fixed in code, three are decisions
(first liquidity, upgrade authority, and the regulatory stance), three were
already structural, one belongs to the frontend.

The two worth knowing before you write anything:

- **NAV circularity is mitigated, not solved.** The pool marks collateral at
  `min(fast, slow)` so a push inflates it only over hours, not in one
  transaction. Say "reduced", never "solved".
- **The depth ceiling now carries a 2x attack-safety factor.** It used to
  break even exactly at the ceiling, which is not a margin.

## 11. Required reading

1. `docs/issues.md` — what is still open and what is already decided
2. `docs/invariants.md` — the 12 rules that are not negotiable
2. `docs/architecture.md` — program boundaries and layers
3. `docs/oracle.md` — the four defences and Blocker #1
4. `docs/frontend-contract.md` — frontend only
5. `packages/slab-interface/src/lib.rs` — what is frozen
