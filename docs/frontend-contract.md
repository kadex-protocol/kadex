# Frontend contract

> The frontend does NOT deserialize accounts by hand and does NOT derive PDAs
> by hand. Everything goes through `@kadex/sdk`, so a layout change breaks the
> SDK build instead of breaking the screen in silence.

## Usable today

| Resource | Where | State |
|---|---|---|
| Program IDs | `@kadex/types` → `PROGRAM_IDS` | frozen |
| PDA derivation | `@kadex/types` → `find*` | frozen |
| IDLs | `target/idl/*.json` | generated |
| Anchor types | `target/types/*.ts` | generated |
| Maths | `@kadex/sdk` → `math` | parity-tested |
| Screen derivations | `@kadex/sdk` → `derive*` | done |

## PDA derivation

```ts
import { findPool, findMarket, findPosition, findOracle } from "@kadex/types";

const pool     = findPool(usdcMint);
const market   = findMarket(pool);
const oracle   = findOracle(basket);
const position = findPosition(market, wallet, 0n);
```

The seeds mirror `kadex_interface::seeds` byte for byte. If they drift, the
frontend derives addresses that do not exist.

## Values the screen needs

None of these are stored on an account. They are computed in the SDK with the
same fixed-point arithmetic as the Rust.

```ts
import { derivePosition, deriveCapacity, deriveBorrowRates, derivePool } from "@kadex/sdk";

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
import { gates, oracleTradeable } from "@kadex/types";

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

`@kadex/sdk` decodes `Pool`, `OracleAccount` and `Market` and builds the three
LP instructions. Each decoder checks the account size and discriminator and
throws if either is off, so a layout change stops the screen instead of
feeding it garbage.

```ts
import { decodePool, decodeOracle, marksOf, poolView, depositUsdcIx, withdrawIx } from "@kadex/sdk";

const pool = decodePool(poolInfo.data);
const marks = marksOf(decodeOracle(oracleInfo.data));   // trade, low, high
const view = poolView(poolAddress, pool, marks);        // the PoolView the screen renders
```

A deposit is priced at the high mark and a withdrawal at the low one, so a
quote has to use `navIssue` for CLP minted and `navRedeem` for CLP burned.
`tests/integration/sdk.test.mjs` holds both to what the program pays out.

`navIssue` also counts the borrow the open book owes and has not paid
(`bookBorrowOwed`), brought to `marks.now`. Build marks with the time, or the
quote ignores borrow accrued since the book's last snapshot:

```ts
const marks = marksOf(oracle, nowUnixSeconds);   // depth comes from the oracle
```

`tests/integration/activity.test.mjs` shows a deposit minting exactly the
shares `navIssue` quotes at the deposit's block time, and more if borrow were
ignored. `Pool` is 554 bytes and `Market` 197 since this change (#14).

## Pointing the web app at a cluster

With neither variable set the app runs on sample data and says so.

```
NEXT_PUBLIC_KADEX_RPC_URL=http://127.0.0.1:8899
NEXT_PUBLIC_KADEX_USDC_MINT=<the mint the pool was initialized with>
```

`npm run dev:chain -- <your wallet>` boots a validator, deploys, seeds the
pool with 140,000 USDC and 40,000 fractions, funds that wallet with SOL, USDC
and fractions, writes `apps/web/.env.local` and keeps the oracle fresh. Set
`KADEX_ENV_FILE` to write the file somewhere else, which is what running it
from WSL against a Windows checkout needs.

The pool page then reads the chain and sends `deposit_usdc`,
`deposit_fractions` and `withdraw`, creating the destination token accounts
and prepending `refresh_price` when the oracle is past half its staleness
limit. The wallet signs; the app sends through its own RPC.

The trade screen reads the wallet's positions (`decodePosition`, filtered by
owner at `POSITION_OWNER_OFFSET`) and sends `openPositionIx` and
`closePositionIx` through `apps/web/lib/tradeTx.ts`, prepending
`refresh_price` the same way.

## Vaulting a card

The card page reads the asset's state on the cluster the app points at, not
from Collector Crypt, and offers only what the program would accept:

```ts
import { readCoreCard, vaultAction, fractionalizeCoreIx, redeemCoreIx } from "@kadex/sdk";

const state = await readCoreCard(connection, asset, wallet);  // owner, registry, card, vault, wallet fractions
const action = vaultAction(state, wallet);
// "vault" | "redeem" | "redeemShort" | "notOwner" | "notWhitelisted" | "disabled" | "missing"
```

`vault` sends `fractionalize_core` (creating the fraction account first);
`redeem` sends `redeem_core`, which burns the whole supply. `redeemShort` says
how many the wallet holds against how many it needs. Both actions ask for a
second click that states the fraction count before signing.
`tests/integration/vault-sdk.test.mjs` runs each state against the real
Metaplex Core program and shows the program refusing what the button refuses.

## LP position

```ts
import { readLpEvents, lpReturn, readUtilisation } from "@kadex/sdk";

const events = await readLpEvents(connection, pool, wallet);   // the wallet's Deposited / Withdrawn / Redeemed
const r = lpReturn(events, valueNow, priceAt);                 // contributed, withdrawn, return, firstDepositTs
const trend = await readUtilisation(connection, market);       // OI and utilisation at each open and close
```

Return is fees and trader PnL together: both move the value of a share, so
they cannot be separated per LP. A fraction deposit's event carries no price,
so it is valued at the index price nearest before it and marked approximate.
Utilisation at an open is exact (the event carries `oi_after` and `cap`); a
close subtracts that position's notional and keeps the last cap seen. Both
read the last 300 transactions of the wallet and of the market.

## Vault inventory

```ts
import { readVaultInventory } from "@kadex/sdk";

const rows = await readVaultInventory(connection, wallet);
// per locked card the wallet deposited or holds part of:
// supply, held (summed over ALL its token accounts), missing, deposited, missingAtAppraisal
```

Two RPC calls: the program's locked `VaultedCard` accounts, and the wallet's
token accounts. `missingAtAppraisal` is the shortfall at 1 fraction = $1 of
appraisal, not a market price, and the page says so.

## Price history

No account stores past prices: every `refresh_price` emits `PriceRefreshed`
into its transaction's logs, and that is the record.

```ts
import { readPriceHistory, toSeries } from "@kadex/sdk";

const { events, newest } = await readPriceHistory(connection, oracle, { from, step: 300 });
const points = toSeries(events, 300, from, now);   // one point per bucket, carried forward
// next time: { from, step: 300, until: newest } reads only what is new
```

It lists the oracle's signatures, keeps a few per bucket, and fetches only
those transactions. An event counts only if it was logged while the oracle
program was executing, so another program cannot forge one. The web app runs
this server side in `/api/index-history` and caches it for 30 seconds; the
chart appends the price just read so it ends where the ticket quotes.

Limit: history goes back as far as the RPC keeps transactions. A pruned or
light RPC returns less, and the chart shows what it gets.

## What does not exist yet

- the basket constituents and weights come from `deployments/basket.json`
  (the launch basket, #10) through `CONSTITUENTS` in `apps/web/lib/market.ts`,
  not read from chain (#1)
