# Flows

> [Docs](README.md) › Flows · Up: [System map](system-map.md) · Related: [Programs](programs.md), [Web app](web-app.md), [Services](services.md), [Users](users.md)

Each flow as a sequence graph, from the click or the timer to the accounts that change. Instruction names, checks and events are the ones in `programs/*/src`. The web steps are the ones in `apps/web/lib`.

## Flow map

An arrow means "feeds" or "must happen before".

```mermaid
flowchart LR
  subgraph USERF["User flows"]
    F10["Faucet"]
    F1["Open a position"]
    F2["Close a position"]
    F9["Hedge"]
    F5["Earn deposit"]
    F6["Earn withdraw"]
    F7["Vault a card"]
    F8["Redeem a card"]
  end

  subgraph SYSF["System flows"]
    F4["Price refresh"]
    F3["Liquidation"]
    F11["Index chart history"]
  end

  F10 --> F1
  F10 --> F5
  F4 --> F1
  F4 --> F2
  F4 --> F3
  F4 --> F5
  F4 --> F6
  F4 --> F11
  F9 --> F1
  F1 --> F2
  F1 --> F3
  F5 --> F6
  F7 --> F8
  F7 --> F9
```

Every flow that reads a price needs a fresh one. A user transaction never waits for the keeper: when the stored price is older than half of `max_staleness_secs`, the web app prepends `refresh_price` to the same transaction (`refreshIfAging` in `apps/web/lib/tx.ts`).

## Open a position

Entry points: the trade ticket on `/`, `openPosition` in `lib/actions.ts`, `sendOpenPosition` in `lib/tradeTx.ts`.

```mermaid
sequenceDiagram
  actor T as Trader wallet
  participant W as Web app
  participant O as oracle
  participant P as perp
  participant S as SPL Token
  participant C as clp-pool

  T->>W: side and size
  W->>W: quote with SDK maths (margin, fee, liquidation price)
  W->>W: readChain, build the transaction
  W->>T: asks for a signature
  T-->>W: signed transaction
  Note over O,C: one transaction
  opt price older than half the staleness limit
    W->>O: refresh_price
  end
  W->>P: open_position(nonce, side, notional, margin)
  P-->>O: reads OracleAccount, owner checked
  P->>P: require_tradeable, then accrue borrow
  P->>P: kadex_risk check_open
  P->>S: transfer margin plus fee, trader to usdc_vault
  P->>P: add the position to the market book
  P->>C: CPI record_open(margin, fee, book), signed by the Market PDA
  C->>C: margin_held grows, fee is split, book is stored
  P->>P: write the Position account
  P-->>W: event PositionOpened
  W-->>T: confirmed signature
```

- The nonce is the current time in milliseconds. It is part of the Position PDA seeds, so one wallet can hold many positions.
- Margin must be at least `notional / 5`. The ticket sends exactly that.
- The fee is 0.10% of notional, rounded up.
- The entry price is the oracle price. There is no slippage parameter because the trade does not move a pool.
- An open that would pass either open-interest ceiling, or take utilization to 95%, is refused in the same transaction. Rules: [programs.md](programs.md#the-rules-that-can-refuse-an-open).

## Close a position

Entry points: the positions table, `closePosition` in `lib/actions.ts`, `sendClosePosition` in `lib/tradeTx.ts`.

```mermaid
sequenceDiagram
  actor T as Trader wallet
  participant W as Web app
  participant O as oracle
  participant P as perp
  participant C as clp-pool
  participant S as SPL Token

  T->>W: close
  W->>T: asks for a signature
  T-->>W: signed transaction
  Note over O,S: one transaction
  opt price older than half the staleness limit
    W->>O: refresh_price
  end
  W->>P: close_position
  P-->>O: reads OracleAccount
  P->>P: require_markable, then accrue borrow
  P->>P: kadex_risk settle_close gives equity
  P->>P: close fee, capped at what the trader is owed
  P->>P: remove the position from the book
  P->>C: CPI settle_position(to_trader, fee, bad_debt, book, margin)
  C->>S: transfer payout, usdc_vault to trader
  C->>C: sleeve gains margin and loses payout and fee, fee is split
  P->>P: close the Position account, rent returns to the owner
  P-->>W: event PositionClosed
```

- Payout = margin + PnL − borrow owed − close fee, never below zero.
- Closing works in every market state and in every oracle state, as long as the price is fresh.
- If equity is negative the trader receives nothing and the shortfall is recorded in `Pool.bad_debt`.
- If the payout is larger than the sleeve can cover, `settle_position` fails with `PayoutExceedsSleeve` and the position stays open.

## Liquidation

Actor: `apps/liquidator`, or anyone else. `liquidate` is permissionless and pays its caller.

```mermaid
sequenceDiagram
  participant L as Liquidator
  participant R as RPC
  participant O as oracle
  participant P as perp
  participant C as clp-pool
  participant S as SPL Token

  loop every INTERVAL_MS, 5 s by default
    L->>R: fetch Market, Pool, OracleAccount and every Position of the market
    L->>L: health below maintenance margin? (same maths as the program)
    opt at least one position is liquidatable
      Note over O,S: one transaction per position
      opt price older than half the staleness limit
        L->>O: refresh_price
      end
      L->>P: liquidate
      P-->>O: reads OracleAccount
      P->>P: require_markable, then accrue borrow
      P->>P: is_liquidatable, or fail with NotLiquidatable
      P->>P: settle_liquidation, remove the position from the book
      P->>C: CPI settle_position(liquidator_fee, 0, bad_debt, book, margin)
      C->>S: transfer reward, usdc_vault to liquidator
      P->>P: close the Position account, rent returns to its owner
      P-->>L: event PositionLiquidated
    end
  end
```

How the margin is split:

| Equity at liquidation | Liquidator receives | Stays in the pool | Bad debt recorded |
|---|---|---|---|
| Positive | min(1% of notional, equity) | margin − reward | 0 |
| Zero or negative | min(1% of notional, margin) | margin − reward | the negative equity |

With 5x leverage and a 6.25% maintenance margin, a position opened at maximum leverage becomes liquidatable after a move of 13.75% against it, before borrow. The oracle's move cap means the official price reaches that level some time after the AMM does. See [oracle.md](oracle.md).

## Price refresh

Actor: `apps/keeper`, the price mover, or any transaction that prepends the instruction.

```mermaid
sequenceDiagram
  participant K as Keeper
  participant O as oracle
  participant A as Raydium pool and vaults
  participant X as Readers

  loop every INTERVAL_MS, 5 s by default
    K->>O: refresh_price(oracle, amm_pool, vault 0, vault 1)
    alt already refreshed in this slot
      O-->>K: Ok, nothing changes
    else first refresh of the slot
      O-->>A: reads pool state and both vault balances
      O->>O: validate pool, vaults and authority, subtract owed fees
      O->>O: spot, cumulative, checkpoint, TWAP, window depth
      O->>O: clamp to 5% per 15 s, slow price, state
      O-->>K: event PriceRefreshed
    end
  end
  X-->>O: perp and clp-pool read OracleAccount inside their own instructions
  X-->>O: web app reads the account and the PriceRefreshed events
```

Steps inside the instruction: [programs.md](programs.md#what-refresh_price-computes).

On devnet a second process trades in the Raydium pool so the index moves. `scripts/devnet-market.mjs swing` swaps `tKDX` and `kdUSD` on a sine wave, and every swap carries `refresh_price` in the same transaction.

```mermaid
flowchart LR
  M["price mover<br/>scripts/devnet-market.mjs"] -->|"swap_base_input"| R[("Raydium CPMM pool")]
  M -->|"refresh_price, same transaction"| O["oracle"]
  K["keeper"] -->|"refresh_price"| O
  R -.->|"reserves"| O
  O -.->|"price"| P["perp"]
  O -.->|"marks"| C["clp-pool"]
```

If every refresher stops, the price ages past `max_staleness_secs`. Opening is then refused. Close, liquidate, deposit and withdraw also refuse a stale price, and each can carry its own `refresh_price`.

## Earn deposit

Entry points: `/pool`, `poolAction` in `lib/actions.ts`, `sendPoolAction` in `lib/poolTx.ts`.

```mermaid
sequenceDiagram
  actor L as Liquidity provider wallet
  participant W as Web app
  participant O as oracle
  participant C as clp-pool
  participant S as SPL Token

  L->>W: amount, in kdUSD or tKDX
  W->>W: quoteDeposit (haircut, CLP minted, share of pool)
  W->>L: asks for a signature
  L-->>W: signed transaction
  Note over O,S: one transaction
  opt price older than half the staleness limit
    W->>O: refresh_price
  end
  W->>S: create the CLP token account if missing
  alt kdUSD
    W->>C: deposit_usdc(amount)
    C-->>O: reads marks
    C->>C: shares = amount × supply / nav_issue
    C->>S: transfer kdUSD into usdc_vault
  else index token
    W->>C: deposit_fractions(amount)
    C-->>O: reads marks
    C->>C: value at the low mark, minus the 3% haircut
    C->>C: shares = net value × supply / nav_issue
    C->>C: card sleeve at the high mark must stay within 30% of assets
    C->>S: transfer tKDX into fraction_vault
  end
  C->>S: mint CLP to the depositor
  C-->>W: event Deposited
```

- The pool accepts its stable mint and its one fraction mint: `kdUSD` and `tKDX` on devnet. Details: [programs.md](programs.md#what-the-pool-accepts).
- Deposits are allowed only in state `Active`.
- A deposit too small to mint one base unit of CLP fails with `DustDeposit`.

## Earn withdraw

```mermaid
sequenceDiagram
  actor L as Liquidity provider wallet
  participant W as Web app
  participant O as oracle
  participant C as clp-pool
  participant S as SPL Token

  L->>W: CLP amount
  W->>W: quoteWithdraw (kdUSD out, tKDX out)
  W->>L: asks for a signature
  L-->>W: signed transaction
  Note over O,S: one transaction
  opt price older than half the staleness limit
    W->>O: refresh_price
  end
  W->>S: create the kdUSD and tKDX token accounts if missing
  W->>C: withdraw(shares)
  C-->>O: reads marks
  C->>C: value = shares × nav_redeem / supply
  C->>C: split the value in the proportion the two sleeves are held
  C->>C: kadex_risk check_withdraw
  C->>S: burn CLP
  C->>S: transfer kdUSD and tKDX to the owner
  C-->>W: event Withdrawn
```

- A withdrawal always returns both assets in proportion. There is no stable-only exit.
- `check_withdraw` refuses a withdrawal that would leave open interest above the solvency ceiling of the remaining sleeve (`WithdrawBreachesCapacity`).
- In state `Settled` the instruction is `redeem_settled`: the same NAV-sized slice, with no capacity check.

## Vault a card

Precondition: the registry admin has whitelisted the card with `whitelist_core_card`, which fixes `fractions_per_card` from the appraisal and creates the card's fraction mint.

Entry points: `/vault/[address]`, `VaultActions`, `sendVaultAction` in `lib/vaultTx.ts`.

```mermaid
sequenceDiagram
  actor U as Card owner wallet
  participant W as Web app
  participant V as card-vault
  participant M as Metaplex Core
  participant S as SPL Token

  W->>W: readCoreCard (asset owner, Registry, WhitelistedCard, VaultedCard, wallet fractions)
  W->>W: vaultAction decides what to offer
  U->>W: vault, then a second click that states the fraction count
  W->>U: asks for a signature
  U-->>W: signed transaction
  Note over V,S: one transaction
  W->>S: create the fraction token account if missing
  W->>V: fractionalize_core
  V->>V: card enabled, not locked, owned by the signer, in the registry collection
  V->>M: TransferV1, owner becomes the VaultedCard PDA
  V->>V: re-read the asset, owner must be the vault PDA
  V->>S: mint fractions_per_card to the depositor
  V->>V: VaultedCard locked, depositor recorded
  V-->>W: event CardFractionalized
```

`vaultAction` in `@kadex/sdk` returns one of `vault`, `redeem`, `redeemShort`, `notOwner`, `notWhitelisted`, `disabled` or `missing`. It mirrors the program's checks, so the button is never enabled for a transaction the program would refuse.

## Redeem a card

```mermaid
sequenceDiagram
  actor U as Fraction holder wallet
  participant W as Web app
  participant V as card-vault
  participant S as SPL Token
  participant M as Metaplex Core

  W->>W: readCoreCard, wallet holds the whole supply?
  U->>W: redeem, then a second click
  W->>U: asks for a signature
  U-->>W: signed transaction
  W->>V: redeem_core
  V->>V: card locked, caller holds at least fractions_minted
  V->>S: burn the whole supply from the caller
  V->>M: TransferV1 signed by the VaultedCard PDA, owner becomes the caller
  V->>V: re-read the asset, owner must be the caller
  V->>V: VaultedCard unlocked, fractions_minted = 0
  V-->>W: event CardRedeemed
```

There is no partial redemption. A wallet that sold fractions has to hold all of them again before the card comes back. The Vault page lists, per locked card, how many fractions a wallet holds and how many are missing (`readVaultInventory`).

## Hedge

Hedge mode is the trade ticket with the short side fixed and the size derived from card inventory. It sends the same `open_position`.

```mermaid
flowchart TD
  A["Cards the wallet owns<br/>Collector Crypt marketplace, by owner"] --> INV["Inventory value at appraisal"]
  B["Devnet test cards the wallet owns"] --> INV
  C["Cards the wallet vaulted"] --> INV
  INV --> SPLIT["Split: in the index basket, outside it"]
  SPLIT --> SUG["suggestHedge in lib/hedge.ts"]
  L1["Limit: maximum notional"] --> SUG
  L2["Limit: maximum monthly cost"] --> SUG
  CAP["Market capacity left"] --> SUG
  SUG --> MIN["Suggested short = the smallest of:<br/>inventory, maximum notional,<br/>size the monthly cost allows, capacity left"]
  MIN --> Q["quote: margin, liquidation price, monthly borrow cost"]
  Q --> OP["open_position, side short"]
```

In hedge mode the number typed in the ticket is inventory value, and a cover slider (60% by default) sets the share of it to short. The suggestion fills the ticket with its own size. The monthly cost is the short side's hourly borrow rate times 720 hours, applied to the notional.

## Faucet

On devnet a wallet that connects receives test SOL and `kdUSD`.

```mermaid
sequenceDiagram
  actor U as Wallet
  participant W as Web app
  participant F as /api/faucet
  participant R as Devnet RPC

  U->>W: connect
  W->>F: POST wallet address
  F->>F: refuse on mainnet, per-wallet cooldown, global rate limit
  F->>R: read SOL balance, kdUSD balance, mint
  alt wallet already funded
    F-->>W: funded false
  else needs SOL or kdUSD
    F->>R: one transaction, signed by the faucet key
    Note over F,R: transfer SOL if below 0.01, create the token account, send 1,000 kdUSD if below 100
    F-->>W: funded true, signature
    W->>W: drop cached reads and reload balances
  end
```

The route never runs on mainnet: it checks the configured network and the cluster's genesis hash. Limits: one grant per wallet per 60 seconds and 40 grants per 10 minutes.

## Index chart history

No account stores past prices. The chart is rebuilt from `PriceRefreshed` events.

```mermaid
sequenceDiagram
  participant B as Browser
  participant H as /api/index-history
  participant R as RPC

  B->>H: GET
  alt series is fresh (30 s)
    H-->>B: cached points
  else needs a refresh
    H->>R: getSignaturesForAddress(oracle)
    H->>H: keep up to three signatures per 5 minute bucket
    H->>R: getTransaction, at most six per refresh, newest buckets first
    H->>H: decode PriceRefreshed, only if logged while the oracle program was executing
    H-->>B: 24 hours of 5 minute points, prices as WAD strings
  end
  B->>B: append the price just read, so the chart ends where the ticket quotes
```

The web app also polls the market state every 10 seconds (`lib/useMarket.ts`) and shares identical reads for 3 seconds (`lib/chain.ts`).

## Where to go next

- [programs.md](programs.md): the instructions these flows call.
- [web-app.md](web-app.md): the modules that build these transactions.
- [services.md](services.md): the keeper, the liquidator and the price mover.
- [invariants.md](invariants.md): the rules every flow respects.
- [Docs index](README.md)
