# Kadex — implementation plan

> `docs/spec.md` is what the product is. This document records how the code is
> split, where it deviates from the original spec, and how it is tested.

Last reviewed 9 Oct 2026. Submission: 12 Oct 2026. Open work is in
[GitHub issues](https://github.com/kadex-protocol/kadex/issues).

## 1. The map

Five on-chain programs, three shared Rust crates, four TypeScript packages,
four apps.

| Piece | Kind | State |
|---|---|---|
| `packages/kadex-math` | Rust crate | done |
| `packages/kadex-risk` | Rust crate | done |
| `packages/kadex-interface` | Rust crate | frozen |
| `programs/oracle` | program | done; real AMM adapter missing (#4) |
| `programs/mock-amm` | program | fixture for localnet and devnet |
| `programs/card-vault` | program | done; no basket mint yet (#1) |
| `programs/clp-pool` | program | done; binds one fraction mint |
| `programs/perp` | program | done |
| `packages/types` `packages/sdk` | TS | PDAs, decoders, LP and trade instructions |
| `packages/oracle` | TS | adapters, mock only |
| `packages/collector-crypt` | TS | API client, listing median |
| `apps/keeper` `apps/liquidator` `apps/external-feed` | TS | done |
| `apps/web` | Next.js | trade, pool and vault flows send transactions |

Tests: 173 Rust, 21 parity, 12 price history, 23 Raydium reader, 74 on-chain integration, 32 + 8 Collector Crypt.

## 2. Declared deviations from the spec

### Four programs, not three (five with the mock AMM)

The oracle is its own program instead of living inside `clp-pool`. Account
ownership in Solana is per program; inside `clp-pool`, prices and risk would
share one crate. As a separate program the only thing between them is an
account read, at zero CPI cost: Anchor checks the owner because
`kadex-interface` declares the oracle program's ID.

### A fourth crate: `kadex-risk`

Rules live in a crate that depends on neither `anchor-lang` nor
`solana-program`, so a rule cannot read an account and needs no validator to
be tested. Enforced by `risk_crate_cannot_reach_solana` and
`handlers_stay_thin`.

### One fraction mint per pool, not a basket

The spec prices an index. The code prices whatever single mint the pool binds
at `initialize_pool`. Closing that gap is #1.

## 3. Dependency graph

```
kadex-math ──> kadex-risk ──┬──> kadex-interface ──> all programs
                            │
                            └──> perp, clp-pool  (decisions)

oracle ──(OracleAccount, read only)──> perp, clp-pool
perp ──(CPI: record_open, settle_position)──> clp-pool

kadex-interface ──> packages/types (TS mirror) ──> packages/sdk ──> apps/web
```

## 4. Remaining blockers

| # | What | Issue |
|---|---|---|
| 1 | Real AMM on-chain layout | #4 |
| 2 | Who provides the first liquidity, and how much | #2 |
| 3 | NAV circularity — mitigated by the slow mark, not eliminated | declared in `docs/spec.md` |
| 7 | `anchor build` emits undeployable SBPF v3 | mitigated by `scripts/bin/cargo-build-sbf`; remove after upgrading to Agave 4.x |

Resolved: #4 (perp ↔ pool CPI, via `settle_position`), #5 (folder name), #6
(on-chain tests, via a `solana-test-validator` harness — litesvm abandoned).

## 5. Test strategy

**Pure unit tests (`cargo test`)** — where the economic invariants live. Every
risk function is pure over plain structs, with 20,000-case property tests on a
fixed seed.

**Rust ↔ TS parity (`npm run test:parity`)** — the same vectors as the Rust.
If the frontend's maths drifts, the screen shows one liquidation price and the
program uses another.

**On-chain integration (`npm run test:integration`)** —
`scripts/with-validator.mjs` boots a throwaway validator, deploys all five
programs and runs `tests/integration/`.

The **negative** tests matter more and are marked as such: capacity exceeded,
forged oracle, a jump past the clamp, stale oracle, insufficient depth,
divergence, opening outside `Active`, insufficient margin, liquidation before
the threshold, bad debt, pro-rata haircut.
