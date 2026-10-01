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

## What does not exist yet

- `deposit`, `withdraw`, `close_position` and `liquidate` instructions.
  `open_position` is complete and can be called today.
- real account fetching (the SDK has the shapes, the fetch is missing)
- `apps/web` is empty

Start with: scaffold, wallet adapter, PDA derivation, screens driven by mocked
data in the shapes of `PoolView`, `OracleView`, `MarketView` and
`PositionView`. When the handlers land, only the fetch changes.
