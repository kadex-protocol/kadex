# Kadex

Perpetual futures on an index of tokenized trading cards, on Solana. The CLP
pool is the counterparty to every trade; the price comes from an AMM pool of
card fractions, not from a signed oracle.

## Getting started

```sh
npm install
npm run sync-keys        # keys/ -> target/deploy/ (fixed program IDs)
npm run build:programs   # 5 programs, deployable binaries + IDLs (docs/deploying.md)
cargo test --workspace   # 152 invariant tests, < 1s
node --test tests/parity.test.mjs   # 21 Rust <-> TS parity tests
npm run test:integration # 49 tests against a local validator
```

## Layout

| Path | What |
|---|---|
| `packages/slab-math` | fixed-point arithmetic, no floats |
| `packages/slab-risk` | every risk rule. No Anchor, no Solana, by design |
| `packages/slab-interface` | **frozen interfaces** between tracks |
| `programs/oracle` | price: TWAP, clamp, depth, divergence |
| `programs/card-vault` | NFT ↔ SPL fractions |
| `programs/clp-pool` | pool, NAV, sleeves, state |
| `programs/perp` | positions, borrow, liquidation |
| `packages/types` `packages/sdk` | the frontend contract |
| `docs/` | handoff, plan, architecture, invariants, oracle, frontend |

## Read before writing code

0. `docs/handoff.md` — **start here**
1. `docs/implementation-plan.md` — who does what, and what is blocked
2. `docs/invariants.md` — the 12 rules that are not negotiable
3. `packages/slab-interface/src/lib.rs` — what is frozen and how to change it

## Branches

```
main                          integration, always green
backend/card-vault-oracle     Backend A
backend/risk-engine           Backend B
frontend/web                  Frontend
```

Small, isolated commits. Never mix oracle, risk and frontend in one.
