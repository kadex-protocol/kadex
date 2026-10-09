# Frontend contract

> The frontend does NOT deserialize accounts by hand and does NOT derive PDAs
> by hand. Everything goes through `@slab/sdk`, so a layout change breaks the
> SDK build instead of breaking the screen in silence.

## Usable today

| Resource | Where | State |
|---|---|---|
| Program IDs | `@slab/types` → `PROGRAM_IDS` | frozen |
| PDA derivation | `@slab/types` → `find*` | frozen |
| IDLs | `target/idl/*.json` | generated |
| Anchor types | `target/types/*.ts` | generated |
| Maths | `@slab/sdk` → `math` | parity-tested |
| Screen derivations | `@slab/sdk` → `derive*` | done |

## PDA derivation

```ts
import { findPool, findMarket, findPosition, findOracle } from "@slab/types";

const pool     = findPool(usdcMint);
const market   = findMarket(pool);
const oracle   = findOracle(basket);
const position = findPosition(market, wallet, 0n);
```

The seeds mirror `slab_interface::seeds` byte for byte. If they drift, the
frontend derives addresses that do not exist.

## Values the screen needs

None of these are stored on an account. They are computed in the SDK with the
same fixed-point arithmetic as the Rust.

```ts
import { derivePosition, deriveCapacity, deriveBorrowRates, derivePool } from "@slab/sdk";

// position: PnL, borrow owed, equity, health, liquidation price
const p = derivePosition(raw, market, oraclePrice, pool.params);

// capacity: BOTH ceilings and which one binds
const c = deriveCapacity(pool, oracle, market);
// c.binding === "depth" | "solvency"  ← show this
// c.free                              ← how much can still be opened
// c.utilization                       ← in WAD

// borrow per side, crowded-side surcharge included
const r = deriveBorrowRates(pool, market, c.cap);

// pool: NAV, CLP price, sleeve composition
const v = derivePool(pool);
```

## Scales

| Value | Scale | Convert with |
|---|---|---|
| prices, ratios, parameters | WAD = 1e6 | `fromWad` |
| USDC and fractions | 6 decimals | `fromUsdc` / `toUsdc` |
| borrow index | RAY = 1e12 | — |
| configured fees | bps = 1e4 | — |

**Everything is BigInt.** `Number` loses precision above 2^53 and a native
USDC balance passes that easily. Convert to `Number` on the last line, for
display only.

## Enabling and disabling controls

```ts
import { gates, oracleTradeable } from "@slab/types";

const g = gates(pool.state);      // canOpen, canClose, canDeposit, canWithdraw...
const ok = oracleTradeable(oracle.state);

// open-position button:
disabled = !g.canOpen || !ok || c.free === 0n;
```

This mirrors `MarketState::allows_*` in Rust. If the screen enables a button
the program refuses, the user pays gas to receive an error.

## What to show when the market is gated

Never show a bare "error". The state says why:

| State | Message |
|---|---|
| `reduceOnly` + oracle `shallowDepth` | "Pool liquidity below minimum. Closing positions only." |
| `reduceOnly` + high utilization | "Capacity reached. Closing positions only." |
| oracle `stale` | "Price out of date. Waiting for an update." |
| oracle `diverged` | "Price diverged from the external reference. Market on hold." |
| `settled` | "Market closed. Final redemption available." |

## Reading accounts and sending LP transactions

`@slab/sdk` decodes `Pool`, `OracleAccount` and `Market` and builds the three
LP instructions. Each decoder checks the account size and discriminator and
throws if either is off, so a layout change stops the screen instead of
feeding it garbage.

```ts
import { decodePool, decodeOracle, marksOf, poolView, depositUsdcIx, withdrawIx } from "@slab/sdk";

const pool = decodePool(poolInfo.data);
const marks = marksOf(decodeOracle(oracleInfo.data));   // trade, low, high
const view = poolView(poolAddress, pool, marks);        // the PoolView the screen renders
```

A deposit is priced at the high mark and a withdrawal at the low one, so a
quote has to use `navIssue` for CLP minted and `navRedeem` for CLP burned.
`tests/integration/sdk.test.mjs` holds both to what the program pays out.

## Pointing the web app at a cluster

With neither variable set the app runs on sample data and says so.

```
NEXT_PUBLIC_SLAB_RPC_URL=http://127.0.0.1:8899
NEXT_PUBLIC_SLAB_USDC_MINT=<the mint the pool was initialized with>
```

`npm run dev:chain -- <your wallet>` boots a validator, deploys, seeds the
pool with 140,000 USDC and 40,000 fractions, funds that wallet with SOL, USDC
and fractions, writes `apps/web/.env.local` and keeps the oracle fresh. Set
`SLAB_ENV_FILE` to write the file somewhere else, which is what running it
from WSL against a Windows checkout needs.

The pool page then reads the chain and sends `deposit_usdc`,
`deposit_fractions` and `withdraw`, creating the destination token accounts
and prepending `refresh_price` when the oracle is past half its staleness
limit. The wallet signs; the app sends through its own RPC.

The trade screen reads the wallet's positions (`decodePosition`, filtered by
owner at `POSITION_OWNER_OFFSET`) and sends `openPositionIx` and
`closePositionIx` through `apps/web/lib/tradeTx.ts`, prepending
`refresh_price` the same way.

## What does not exist yet

- the vault screen sends nothing: no SDK builders for `fractionalize_core` /
  `redeem_core`, and "Vault this card" has no handler (#6)
- no LP position view (#8) and no vault inventory (#7)
- price history: nothing records it, so the chart is empty on a real cluster (#9)
- the basket constituents and weights are the `CONSTITUENTS` constant in
  `apps/web/lib/market.ts`, not read from chain (#1, #10)
