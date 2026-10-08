# Kadex — implementation plan

> The Kadex spec is the source of economic truth. This document turns it into
> code boundaries and says who builds what without blocking anyone else.

State as of 1 Oct 2026 — days 1 and 2 complete. Submission: 12 Oct 2026.

## 1. The map

Four on-chain programs, three shared Rust crates, three TypeScript packages,
three apps.

| Piece | Kind | Owner | State |
|---|---|---|---|
| `packages/slab-math` | Rust crate | shared | **done**, 32 tests |
| `packages/slab-risk` | Rust crate | shared | **done**, 23 tests |
| `packages/slab-interface` | Rust crate | shared | **frozen**, 6 tests |
| `programs/oracle` | program | Backend A | state + defences, 11 tests |
| `programs/mock-amm` | program | Backend A | constant-product fixture, 8 tests |
| `programs/card-vault` | program | Backend A | full cycle, 2 tests |
| `programs/clp-pool` | program | Backend B | deposit/withdraw/settle, 14 tests |
| `programs/perp` | program | Backend B | open/close/liquidate + 2 guards |
| `packages/types` | TS | Frontend | PDAs and views frozen |
| `packages/sdk` | TS | Frontend | maths mirror + derivations |
| `packages/oracle` | TS | Backend A | adapters, mock working |
| `apps/keeper` | TS | Backend A | **done** — permissionless refresh loop |
| `apps/liquidator` | TS | Backend B | scanner done, decode pending |
| `apps/web` | Next.js | Frontend | empty |

149 tests: 107 Rust, 19 Rust↔TS parity, 23 on-chain integration.

## 2. Declared deviations from the spec

### Four programs, not three

The oracle became its own program instead of living inside `clp-pool`.

Account ownership in Solana is per program. With the oracle account inside
`clp-pool`, Backend A and Backend B would be editing the same program every
day — exactly what this work exists to prevent. As a separate program, A owns
the oracle, B owns risk, and the only thing between them is an account read.

Cost: zero CPI. `perp` takes the account and deserializes it; Anchor checks
the owner itself because `slab-interface` declares the oracle program's ID.

### A fourth crate: `slab-risk`

Rules were originally written as methods on the program's account structs.
They now live in a crate that depends on neither `anchor-lang` nor
`solana-program`.

The point is that the separation is enforced rather than agreed. A rule in
`slab-risk` has no `AccountInfo` reachable from it, so it cannot read an
account, and it needs no validator to be tested. Two tests hold the line:
`risk_crate_cannot_reach_solana` and `handlers_stay_thin`.

## 3. Dependency graph

```
slab-math ──> slab-risk ──┬──> slab-interface ──> all four programs
                          │
                          └──> perp, clp-pool  (decisions)

oracle ──(OracleAccount, read only)──> perp, clp-pool

slab-interface ──> packages/types (TS mirror) ──> packages/sdk ──> apps/web
```

What that means day to day:

- **A does not wait for B.** `oracle` and `card-vault` depend only on the
  shared crates, which are done.
- **B does not wait for A.** `perp` consumes `OracleView`, not the oracle
  program. B's tests build that struct by hand.
- **The frontend waits for nobody.** `packages/types` has the PDAs;
  `target/idl/*.json` and `target/types/*.ts` already exist.

## 4. Order for D1–D3

| Day | Backend A | Backend B | Frontend |
|---|---|---|---|
| D1 | ✅ fraction decimals (6, fixed) | ✅ accounts + fixed point | ✅ scaffold + PDAs |
| D2 | ⚠️ litesvm blocked (#6) | ✅ `open_position` reference | account reads via SDK |
| D3 | ✅ mock AMM + ✅ keeper | `deposit`/proportional `withdraw` | pool screen with real shapes |

## 5. What is frozen

Changing any of these needs the process at the top of
`packages/slab-interface/src/lib.rs`.

1. `slab_interface::seeds` — every PDA
2. `OracleAccount` and `OracleView` — the A↔B interface
3. `PoolParams` — economic configuration
4. `MarketState` and `OracleState`
5. Scales: WAD = 1e6, BPS = 1e4, RAY = 1e12
6. `FRACTION_DECIMALS = 6` — changing it breaks the oracle silently
7. The four program IDs in `keys/`

## 6. Blockers

### Blocker #1 — real AMM layout (HIGH, owner: A)

The on-chain layout of the fraction/USDC pool is unconfirmed. The `Meteora`,
`Orca` and `Raydium` adapters **fail loudly** on purpose, in Rust and in TS.
The `Mock` adapter exists so everyone can work without faking an integration.

When it is confirmed, only `programs/oracle/src/adapter.rs` and
`packages/oracle/src/index.ts` change.

### Blocker #2 — who provides the first liquidity (HIGH, owner: A + product)

Without an initial AMM deposit there is no reserve, no price, and nothing else
works. The size of that deposit sets the open-interest ceiling for the whole
market. This is a product decision, not a coding one.

### Blocker #3 — NAV circularity (HIGH, owner: B)

The same AMM pool prices the perp **and** the CLP's card sleeve. Pushing the
AMM moves both. The liquid sleeve mitigates this; it does not eliminate it.
It goes in the submission as written.

~~Blocker #6 — on-chain integration tests~~ — resolved on 2 Oct via a
`solana-test-validator` harness. `scripts/with-validator.mjs` boots a throwaway
validator, deploys all five programs and runs `tests/integration/`. The ten
oracle defence cases pass against a real runtime. litesvm was abandoned: no
release both loads our binaries and matches the pinned rustc.

### Blocker #7 — `anchor build` produces undeployable binaries (HIGH, owner: all)

Found while resolving #6, and it is worse than a test problem.

Anchor 1.2 hardcodes `--arch v3`. The Solana CLI 3.1.10 cannot parse the
resulting ELF **at all** — not through `solana program deploy`, not through
`solana program-v4 deploy`:

```
Error: ELF error: Failed to parse ELF file: invalid file header
```

The runtime supports SBPFv3 (the feature gate is active on a fresh validator);
every tool that reads the ELF before sending it does not. So `anchor build`
alone yields binaries that cannot reach devnet.

Mitigated with a PATH shim. `scripts/bin/cargo-build-sbf` rewrites `--arch v3`
to `--arch v1` and passes everything else through; Anchor invokes
`cargo-build-sbf` by name, so putting that directory first on PATH is enough.
`npm run build:programs` does this itself and verifies `e_flags` on each
output. See `docs/deploying.md`.

The sharp edge is now only for someone who has not put `scripts/bin` on their
PATH. The real fix is upgrading the Solana CLI: **Agave 4.3.0 is released**,
far newer than the pinned 3.1.10, and should parse v3 natively. That is a
toolchain change worth doing after the submission rather than during it.

~~Blocker #4 — risk CPI between `perp` and `clp-pool`~~ — resolved on 2 Oct.
`clp_pool::settle_position` is the single door value leaves the pool through,
gated by `address = pool.perp_market` on a `Signer`, and `perp` signs it with
the market PDA's seeds. Closing and liquidating both go through it.

~~Blocker #5 — trailing space in the folder name~~ — resolved on 1 Oct. The
project directory is now `slab`, matching the repository.

## 7. Test strategy

Three layers, and the first catches the most bugs.

**Pure unit tests (`cargo test`)** — 88 tests, under a second, no validator.
This is where the economic invariants live. Every risk function is written as
a pure function over plain structs so it can be tested here.

**Rust↔TS parity (`node --test`)** — 19 tests with the same vectors as the
Rust ones. If the frontend's maths drifts from the program's, the screen shows
one liquidation price and the program uses another. This file catches that.

**Program tests in litesvm** — per-instruction, against the compiled `.so`.
Not written yet; they start at D2.

The **negative** tests matter more than the positive ones and are marked as
such: capacity exceeded, forged oracle, a jump past the clamp, a stale oracle,
insufficient depth, excessive divergence, opening outside `Active`,
insufficient margin, liquidation before the threshold, bad debt, pro-rata
haircut.

## 8. The finding that changes the plan

```
CLP solvency ceiling     $233,333
AMM depth ceiling         $8,972   ← binds (after the 2x attack-safety factor)
```

AMM depth binds 13x before solvency. The ceiling the spec details most will
almost never bite; what sizes the market is the liquidity in the fraction
pool. Worth deciding whether `phi` and `delta_max` are too conservative for a
constraint that barely ever binds.
