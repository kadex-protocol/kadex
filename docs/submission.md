# Kadex

Kadex is a Solana prototype for trading the price of graded collectible cards without buying a card. It combines a card vault, an AMM-priced index instrument, a perpetual market, and a shared liquidity pool. The programs and web app are built and tested on a local validator. The web app also has a sample-data preview. Kadex has not been deployed to devnet.

## The problem

A collector can own a card or sell it, but cannot easily take a short position. A dealer holding inventory has the same gap when prices fall. A perpetual market could offer directional exposure and a hedge, but a thin card market needs a price source and limits on how much risk it can support.

## How Kadex works

The **vault** accepts whitelisted Collector Crypt card NFTs and mints a fixed number of fractions set at whitelist time. Redeeming the card requires burning the entire fraction supply.

The intended **index** is a weighted basket of vaulted card fractions. The launch basket identifies ten real Collector Crypt cards, selected by rule in `deployments/basket.json`. They have not been bought or vaulted. The index token prepared for devnet is a demonstration token controlled by the deployer. It is not backed by cards and cannot be redeemed for them. The backed basket mint remains issue #1.

The **perp** lets traders open long or short positions with USDC margin. Its oracle reads an on-chain AMM, applies a time-weighted price, move cap, depth check, and external-reference check, then supplies the price used for trading and liquidation. Opening a position is limited by both pool solvency and AMM depth.

The **pool** holds USDC and fractions, issues CLP shares to depositors, and takes the other side of trades. Its net asset value accounts for what it owes traders. Withdrawals return a proportional share of both assets.

## Who uses it

- **Speculators** use the Market ticket for long or short exposure and Portfolio to follow positions.
- **Liquidity providers** use Pool to deposit assets and see their CLP position.
- **Card owners** use Vault to inspect whitelisted cards, vault them, and redeem them when they hold every fraction.
- **Dealers** use Hedge mode to size a short against inventory value.
- **Arbitrageurs** can compare the long and short borrow rates in the Market ticket. A machine-readable feed for bots is still missing.

## What is built

The repository contains the vault, oracle, perp, pool, and mock AMM programs; risk and arithmetic packages; an SDK; a price keeper, liquidator, and external-reference feed; and Market, Pool, Vault, Portfolio, and Methodology web pages. The programs have local-validator integration coverage. Without a configured cluster, the web app displays labelled sample data. The devnet scripts and recorded-demo runbook are prepared, but the scripts have never run against a validator and nothing has been deployed to devnet.

## Known limits

- NAV circularity is **reduced, not solved**. The pool’s slow mark limits a price push within one transaction. A pushed price held for hours can still affect both trader PnL and pool NAV.
- The documented market-sizing example has a **$233,333 CLP solvency ceiling** and an **$8,972 AMM depth ceiling**, after the attack-safety factor. Depth binds roughly **26×** before solvency.
- The devnet index token is a demonstration token, not backed by or redeemable for cards (issue #1). Vaulted cards have separate fraction mints, so their fractions cannot be deposited into the pool bound to that index token.
- The ten-card launch basket was chosen from real Collector Crypt listings by rule, but the cards have not been bought or vaulted.
- Every upgrade authority and admin remains assigned to the deployer key in the deployment design (issue #12). No devnet deployment has occurred.
- The external-reference feed runs in dry run unless publishing is explicitly enabled.
- The first AMM liquidity provider and launch funding remain decisions. Kadex is not operating with real funds.

