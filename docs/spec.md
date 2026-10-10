# Kadex — what it is and how it works

Kadex is a perpetual futures exchange on Solana where the asset is the price of
collectible cards. A trader bets on that price going up or down, a shared pool
takes the other side of every trade, and the price is read from an on-chain
market rather than from anyone's signature.

Last reviewed 9 Oct 2026.

## The flow

```
 Graded card (PSA, in a vault)
        │  Collector Crypt mints it as a Metaplex Core NFT
        ▼
 ┌─ card-vault ─────────┐   NFT locked in escrow → fixed number of
 │ fractionalize_core   │   fraction tokens minted (1 fraction = $1 of appraisal)
 └──────────────────────┘
        │ fractions
        ▼
 AMM pool (fractions / USDC)  ← fractions trade here; this IS the price
        │ reserves read on-chain
        ▼
 ┌─ oracle ─────────────┐   refresh_price (permissionless; the keeper calls it every 5s)
 │ price, slow price,   │   → time-weighted average, capped moves, minimum depth,
 │ depth, state         │     sanity check against listing prices
 └──────────────────────┘
        │ read as an account (no CPI)
        ▼
 ┌─ perp ───────────────┐  CPI   ┌─ clp-pool ──────────────┐
 │ open / close /       │ ─────► │ USDC + fractions held,  │
 │ liquidate positions  │        │ issues CLP shares to LPs│
 └──────────────────────┘        └─────────────────────────┘
        ▲                               ▲
     traders                    liquidity providers (the house)
```

## 1. Card → fractions (`card-vault`)

- An admin whitelists a card at its Collector Crypt appraisal and sets its
  index weight. A $70 card becomes 70 fractions — 70,000,000 base units, since
  fractions use 6 decimals like USDC.
- The owner deposits the NFT. It moves into a program escrow and the vault
  mints exactly the whitelisted number of fractions, never a number chosen at
  deposit time.
- Getting the card back burns the **entire** supply. Anyone who sold fractions
  has to buy them back first.
- The vault checks the NFT belongs to Collector Crypt's collection
  (`CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac`), so a fake cannot be
  deposited. See `docs/collector-crypt.md` and `docs/custody.md`.

## 2. Fractions → price (`oracle`)

Fractions trade against USDC in an AMM; spot is
`usdc_reserve / fraction_reserve`. `refresh_price` reads the reserves and
builds the official price itself — there is no oracle key to steal. Every
defence is expressed in elapsed time, never in number of calls:

| Defence | Default | Blocks |
|---|---|---|
| One update per slot | — | stacking refreshes in one transaction |
| Time-weighted average | 30 min | a price pushed for a moment |
| Move cap | 5% per 15 s | outrunning the clock |
| Minimum depth, over the window | $25k | liquidity added for one transaction |
| Divergence from listing median | 15% | sustained manipulation |
| Staleness, checked at read time | 15 min | trading on a dead price |

It also keeps a **slow price**, an average that takes about 50 minutes to
follow a jump. The pool uses it (section 3). Details: `docs/oracle.md`.

## 3. The pool, the house (`clp-pool`)

- LPs deposit **USDC** or **card fractions** and receive CLP shares. Fraction
  deposits take a 3% haircut, paid to the LPs already in.
- NAV = USDC + fraction value − what the pool owes traders on open positions.
  Trader margin and protocol fees are kept outside it.
- Deposits are priced at `max(price, slow)`, withdrawals at `min(price, slow)`:
  collateral marks down fast and up slowly, so pushing the AMM and withdrawing
  in one transaction does not pay.
- A withdrawal returns a proportional slice of **both** sleeves. There is no
  USDC-only exit.
- Withdrawals stop at the capacity open positions need.
- `settle_position` is the only way value leaves the pool to a trader, and
  only the perp market PDA can sign it.

## 4. Trading (`perp`)

`open_position(side, notional, margin)`:

1. require a fresh price and oracle state `Ok`
2. accrue borrow up to now
3. call **one** function, `risk::check_open`, which holds every rule that can
   refuse the order: leverage (max 5x), market state, and open-interest
   capacity — the lower of
   - **solvency**: what the pool's USDC can pay out
   - **AMM depth**: small enough that pushing the price to trigger
     liquidations costs an attacker twice what they would gain
4. take margin + 0.1% fee, record the position, update the pool's book

**Borrow** is the hourly carrying cost. It rises with utilisation and the
crowded side pays more, which pays arbitrageurs to take the other side.

**Close** settles PnL at the oracle price, minus borrow and fees, through
`clp-pool::settle_position`.

**Liquidate** is open to anyone once equity falls below 6.25% maintenance
margin, for 1% of notional. If equity is already negative the liquidator is
still paid from the margin and the shortfall is recorded as bad debt.

## 5. Off-chain actors

| App | Job |
|---|---|
| `apps/keeper` | `refresh_price` every 5 s. Run at least two, on different machines |
| `apps/liquidator` | scans positions, refreshes if needed, sends `liquidate` |
| `apps/external-feed` | publishes the Collector Crypt listing median. Dry run unless `PUBLISH=1` |

## 6. How the code is structured

- **`kadex-math`** — integer fixed-point arithmetic. No floats near money.
- **`kadex-risk`** — every rule as a pure function, no Solana dependency.
  `risk_crate_cannot_reach_solana` fails if it gains one.
- **Programs** validate accounts, call one risk function, move tokens.
  `handlers_stay_thin` fails if a handler passes 45 lines.
- **`packages/sdk`** mirrors the arithmetic in TypeScript; parity tests keep
  the liquidation price on screen equal to the one the program uses.

Invariants: `docs/invariants.md`. Program boundaries: `docs/architecture.md`.

## Where it stops today

**Priced from a real AMM.** The oracle reads a Raydium CPMM constant-product
pool, validating the pool, both vaults and Raydium's authority and excluding
owed fees (`docs/oracle.md`). `scripts/devnet.mjs` creates an index token, a
devnet USD, the pool and the protocol on devnet, re-runnably.

**The index token is a demonstration instrument.** It is one SPL mint the
deployer controls, seeded into the pool. It is not backed by, and cannot be
redeemed for, any card. Each card's index weight is stored on its vault record
and read by nothing. The launch basket, ten real Collector Crypt cards, is
chosen by rule in `deployments/basket.json` (see `docs/collector-crypt.md`).

What turns "a token the market prices" into "an index of cards":

| | GitHub |
|---|---|
| Basket mint backed by weighted vaulted cards, redeemable | #1 |
| Who provides launch liquidity, and how much | #2 |
| Devnet deployment (needs ~7 SOL on the deployer) | #5 |

## Reference designs

Two live products solve parts of this. What to take from each, and what not to.

**Jupiter Perps / JLP** — the closest model to `clp-pool`
([pool](https://developers.jup.ag/docs/perps/pool-account.md),
[custody](https://developers.jup.ag/docs/perps/custody-account.md),
[requests](https://developers.jup.ag/docs/perps/position-request-account.md)).

- Same shape: one LP pool is counterparty to every trader; AUM is assets minus
  what is reserved for trader profit, which is our NAV.
- Borrow is a cumulative index snapshotted per position, as in ours.
- Each pool asset has a target weight with a ±20% band
  (`tokenWeightageBufferBps`), and swaps that push a weight further from
  target pay a tax. **That is the mechanism the index token (#1) needs** for
  keeping the basket at its weights.
- An AUM cap stops deposits past a size the market can support. Our depth
  ceiling plays that role for open interest; we have no deposit cap.
- 6 bps open/close fee against our 10; 25% of fees to the protocol, ours 25%
  (`lp_fee_share_bps` = 7500).
- Opens and closes go through a `PositionRequest` a keeper fills, which allows
  slippage limits and TP/SL. Ours execute in the user's transaction, which is
  simpler but has no stop-loss. Worth adding after submission.
- Different: Jupiter prices from external oracles and allows high leverage on
  deep majors. Cards are thin, which is why we price from our own AMM with a
  clamp and cap leverage at 5x.

**StonkFun flywheel** ([flywheel](https://www.stonkfun.xyz/flywheel)) — a
market-cap-weighted basket on Solana.

- Platform fees buy back the top 15 tokens by market cap, weighted by market
  cap, and tokens can drop out and come back.
- Useful as an example of an index whose membership and weights are rules,
  published, rather than an admin's choice each time.
- Not a model for custody: there is nothing behind the tokens. Our basket
  units must be redeemable for vaulted fractions.

## Known limits, declared

- NAV circularity is **reduced, not solved**: the slow mark removes the
  single-transaction attack, not a push held for hours.
- A winning payout larger than the liquid sleeve is refused, not paid in part;
  the solvency ceiling keeps it from arising for moves up to `delta_max` (#14).
- Upgrade authority is the deployer on devnet (#12).
- Regulatory: securities, derivatives and gambling regimes overlap. Declared,
  not resolved.
