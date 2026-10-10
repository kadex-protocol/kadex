# Handoff — start here

> What Kadex is lives in `docs/spec.md`. This file is the state of the code
> and the rules for changing it. Ten minutes, and it saves a week of rework.

Last reviewed 9 Oct 2026. Submission deadline: **12 Oct 2026**.

## 1. Running it

```sh
git clone https://github.com/kadex-protocol/kadex.git
cd kadex
npm install
npm run sync-keys        # keys/ -> target/deploy/ — fixed program IDs, don't skip
npm run build:programs   # NOT `anchor build` — see docs/deploying.md
cargo test --workspace   # 185 tests, under a second
npm run test:parity      # 23 Rust <-> TS parity tests
npm run test:integration # 78 on-chain tests, boots a validator
```

If `cargo test` passes and `npm run build:programs` ends with "all programs
are deployable", your environment is correct.

**Do not run `anchor build` on its own** unless `scripts/bin` is first on your
PATH. Anchor 1.2 emits SBPF v3 binaries the Solana CLI 3.1.10 cannot parse, so
they cannot be deployed anywhere. `docs/deploying.md` explains the shim.

## 2. What exists

| Piece | State |
|---|---|
| `packages/kadex-math` | done — fixed point, property tests |
| `packages/kadex-risk` | done — every risk rule |
| `packages/kadex-interface` | **frozen** — the contract between programs |
| `programs/oracle` | done — all defences, time-based since the 6 Oct audit |
| `programs/mock-amm` | done — constant-product pool whose price can be pushed |
| `programs/card-vault` | done — SPL and Metaplex Core cards, whitelist, redeem |
| `programs/clp-pool` | done — deposit, withdraw, settle, settled redemption, fees |
| `programs/perp` | done — open, close, liquidate, borrow |
| `packages/types` `packages/sdk` | PDAs, decoders, LP and trade instructions, price history, maths |
| `packages/collector-crypt` | API client, listing median |
| `apps/keeper` | done — permissionless refresh loop, 5 s |
| `apps/liquidator` | done — reads state, refreshes if needed, liquidates |
| `apps/external-feed` | done — dry run unless `PUBLISH=1` |
| `apps/web` | trade (open, list, close), Earn/pool (deposit, withdraw), portfolio, card marketplace with vault and redeem, methodology. Runs on sample data with no cluster configured |

**Not built yet** — each is a GitHub issue:

| What | Issue |
|---|---|
| Index token: a basket mint of weighted vaulted cards | #1 |
| Who provides the first AMM liquidity | #2 |
| Seed script from real vaulted cards | #3 |
| Devnet deployment | #5 |

## 3. The pattern — copy this shape

Open `programs/perp/src/lib.rs` and read `open_position`. Every instruction
follows it:

1. Anchor validates the accounts, in the `#[derive(Accounts)]` constraints
2. the handler reads what it needs and calls **one** function in `kadex-risk`
3. the handler moves tokens and writes state
4. the handler emits an event

**The handler decides nothing.** That is why 185 tests run in under a second
with no validator. Two tests enforce it:

- `handlers_stay_thin` — a handler over 45 lines fails the build
- `risk_crate_cannot_reach_solana` — `kadex-risk` must never depend on
  `anchor-lang` or `solana-program`

## 4. Architecture decisions

**The oracle is its own program.** Account ownership is per program; inside
`clp-pool` it would have put prices and risk in one crate. Cost: zero CPI —
`perp` deserializes the account and Anchor checks its owner.

**There is no oracle key.** `refresh_price` is permissionless and recomputes
everything from on-chain state.

**Unimplemented adapters fail loudly.** `Meteora`, `Orca` and `Raydium` return
errors in Rust and TypeScript. Do not "fix" this by returning a value: the
market would open on an invented price.

**Rounding always favours the pool.** Deposits and withdrawals round down;
fees, borrow and required margin round up.

**Only the upgrade authority initializes.** Every `initialize_*` checks it.
Deploy and initialize with the same key.

## 5. What is frozen

Changing any of these breaks someone else's work:

1. `kadex_interface::seeds` — every PDA
2. `OracleAccount` and `OracleView`
3. `PoolParams`
4. `MarketState` and `OracleState`
5. Scales: WAD = 1e6, BPS = 1e4, RAY = 1e12
6. `FRACTION_DECIMALS = 6` — changing it breaks the oracle silently
7. The program IDs in `keys/`

The index token (#1) will need to change some of these. The process is at the
top of `packages/kadex-interface/src/lib.rs`: say why, list what it affects,
update the docs, update the tests, tell whoever is blocked.

## 6. Code rules

- **No floating point near money.** Intermediates in `u128`/`i128`, back to
  `u64` only through `to_u64`, which errors instead of truncating.
- **In TypeScript, everything is BigInt.** Convert to `Number` on the last
  line, for display only.
- **Write the negative tests.** They carry more weight than the positive ones.
- **Small, isolated commits.** Never mix oracle, risk and frontend in one.
- **Do not implement a USDC-only withdrawal path**, not even as a shortcut.

## 7. The finding that sizes the market

```
CLP solvency ceiling     $233,333
AMM depth ceiling         $8,972   ← binds (after the 2x attack-safety factor)
```

AMM depth binds about 26x before solvency. What sizes the market is the
liquidity in the fraction pool, not the CLP balance — which is why #2 matters
more than any pool deposit. `node scripts/size-market.mjs` gives the table.

## 8. Further reading

1. `docs/issues.md` — design issues, what was decided, the 6 Oct audit
2. `docs/invariants.md` — the rules that are not negotiable
3. `docs/architecture.md` — program boundaries and custody
4. `docs/oracle.md` — the defences
5. `docs/frontend-contract.md` — frontend only
6. `docs/collector-crypt.md`, `docs/custody.md` — where the cards come from
