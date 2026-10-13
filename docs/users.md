# Who uses this, and which screen serves them

> [Docs](README.md) › Users · Up: [Overview](overview.md) · Related: [Flows](flows.md), [Web app](web-app.md), [Glossary](glossary.md)

Five roles. Only three of them care about cards; the other two are the ones
that make the market work.

Last reviewed 9 Oct 2026. Every role has a screen.

| # | Role | Wants | Screen | State |
|---|---|---|---|---|
| 1 | Speculator | directional exposure without owning | Market, Portfolio | **built** |
| 2 | Liquidity provider | yield for being the counterparty | Pool, Portfolio | **built** |
| 3 | Card owner | liquidity without selling | Vault | **built** — vault and redeem send on a cluster |
| 4 | Dealer hedging stock | insurance on inventory | Market → Hedge | **built** |
| 5 | Arbitrageur | the long/short borrow spread | Market ticket | **built** |

---

## 1 — The speculator

Thinks card prices move and wants in without $4,200 and a three-week exit.

**Journey.** Market → picks Long or Short → types a notional → sees margin,
entry and the liquidation price → connects wallet → opens.

**What they must understand before signing**, in this order:

1. the margin they are posting, and that it can go to zero
2. **the liquidation price** — the single most important number on the screen
3. that borrow accrues hourly, so a position held is a position bleeding
4. that capacity is finite and the request can be refused

Served. The ticket shows all four. The liquidation price comes from the same
function the program uses, so it is the real one.

Open positions are listed on the trade screen with their health and
liquidation price, and can be closed from there.

## 2 — The liquidity provider

The house. Deposits USDC or card fractions, earns fees, pays the winners.

**Journey.** Pool → reads what they are actually buying → Deposit → USDC or
Fractions → sees the haircut and CLP minted → deposits.

**What they must understand**, and this is a disclosure obligation, not a
nice-to-have:

1. they are the counterparty, not an investor in a product
2. income is fees — **constant and modest**; losses are occasional and large
3. redemption returns a proportional slice of **both** sleeves
4. card deposits take a 3% haircut, and that haircut pays the LPs already there
5. providing liquidity to the *card pool* is a different product with
   impermanent loss — a card doubling costs about 5.7% against holding it

Served, including the distinction in 5, which is the one most protocols blur.

**Position.** "Your position" on the Earn page shows the CLP held, what a full
withdrawal returns from each sleeve, the return since the first deposit (fees
and trader PnL together, labelled as such) and utilisation through time, all
read from the programs' own events.

## 3 — The card owner

Has a graded card. Wants liquidity without selling it.

**Journey.** Vault → sees the four steps → picks a whitelisted card → sees
fractions minted and the burn-all condition → vaults it.

**What they must understand:**

1. whitelisting is **permissioned** — they cannot list their own card
2. the fraction count is fixed at whitelist time, not at deposit
3. **redemption burns the entire supply** — sell one fraction and getting the
   card back means buying it back first

Served, and 3 is stated before the deposit button rather than after it.

**Inventory.** "Your vaulted cards" on the Vault page lists every locked card the
wallet deposited or holds fractions of: held against the whole supply, how
many are still needed to redeem, and that shortfall at appraisal value.

---

## 4 — The dealer hedging inventory

Holds $50k of stock. Not betting against cards; **buying insurance**. If the
market falls, they lose on the shelf and gain on the short.

This is the realistic source of short flow. Collectors do not short — the
culture is buy-and-hold — so without hedgers the book is one-sided, which is
the structural risk in `docs/issues.md`.

**What they need** — served by Hedge mode in the trade ticket:

- framing as hedging, not speculation. "Short" reads as betting against the
  hobby; "protect inventory value" reads as prudence, and it is the same trade
- a sizing input in **inventory value**, not notional: "I hold $50k, how much
  cover does that need"
- the cost of the hedge per month, stated plainly, because that is the
  premium they are deciding whether to pay
- what happens if the market rises: the hedge loses and the shelf gains

Shipped as Hedge mode: the same ticket with Short preselected and sizing in
inventory value. Same instruction underneath.

## 5 — The arbitrageur

No opinion about cards. Sees long paying 29.5%/month and short paying 19.7%,
shorts the perp, buys fractions, banks the spread.

The A/B says this flow matters: `psi` moved average skew from 87% to 65%
precisely by paying these people to show up.

**What they need:**

- the two borrow rates, side by side, with the spread as a number — currently
  only the rate for the selected side is shown, so the spread is invisible
- utilisation and capacity headroom
- a machine-readable version of the same. An arbitrageur does not refresh a
  page; they poll

Both rates and the spread are now always visible in the ticket. Still
missing: a machine-readable endpoint for bots.

---

## What is left

1. **A machine-readable feed** of rates, utilisation and capacity for
   arbitrageurs. They poll; they do not refresh a page.

## Where to go next

- [flows.md](flows.md): what each role's action does on chain.
- [web-app.md](web-app.md): the pages and API routes behind each screen.
- [overview.md](overview.md): the three sides and the roadmap.
- [Docs index](README.md)
