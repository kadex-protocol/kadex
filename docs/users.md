# Who uses this, and which screen serves them

Five roles. Only three of them care about cards; the other two are the ones
that make the market work, and the current frontend barely speaks to either.

Last reviewed 3 Oct 2026.

| # | Role | Wants | Screen | State |
|---|---|---|---|---|
| 1 | Speculator | directional exposure without owning | Market | **built** |
| 2 | Liquidity provider | yield for being the counterparty | Pool | **built** |
| 3 | Card owner | liquidity without selling | Vault | **built** |
| 4 | Dealer hedging stock | insurance on inventory | — | **nothing** |
| 5 | Arbitrageur | the long/short borrow spread | — | **nothing** |

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

**Missing:** no way to see an open position's health, because there are no
positions yet.

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

**Missing:** no position view. An LP cannot see what their CLP is worth, what
they have earned, or how utilisation is trending. That is the whole reason
someone opens the app on day two, and it does not exist.

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

**Missing:** no inventory view. Someone who has vaulted three cards has no
screen showing what is locked and what it would take to redeem each.

---

## 4 — The dealer hedging inventory — NOT SERVED

Holds $50k of stock. Not betting against cards; **buying insurance**. If the
market falls, they lose on the shelf and gain on the short.

This is the realistic source of short flow. Collectors do not short — the
culture is buy-and-hold — so without hedgers the book is one-sided, which is
the structural risk in `docs/issues.md`.

**What they need, and none of it exists:**

- framing as hedging, not speculation. "Short" reads as betting against the
  hobby; "protect inventory value" reads as prudence, and it is the same trade
- a sizing input in **inventory value**, not notional: "I hold $50k, how much
  cover does that need"
- the cost of the hedge per month, stated plainly, because that is the
  premium they are deciding whether to pay
- what happens if the market rises: the hedge loses and the shelf gains

**Smallest useful version:** a `/hedge` route that is the trade ticket with
Short preselected, inventory-value sizing, and the monthly cost in the
headline. Same instruction underneath.

## 5 — The arbitrageur — NOT SERVED

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

**Smallest useful version:** add the opposite side's rate and the spread to
the ticket readout. Two lines. It is the cheapest thing on this page and it
targets the flow the design most needs.

---

## What this says about priorities

The three built screens serve the people who **want** to be here. The two
missing ones serve the people the market **needs** in order to work.

If one-sided flow is the structural risk — and the A/B says `psi` only helps
when someone responds to it — then shipping nothing for hedgers and
arbitrageurs means relying on a mechanism with no audience.

In order of value for effort:

1. **Show the borrow spread** in the ticket. Two lines. Serves role 5.
2. **A position view** for LPs. Serves role 2, and it is why anyone returns.
3. **A `/hedge` framing** of the short side. Serves role 4, needs no new
   program code — only different copy and a different sizing input.
