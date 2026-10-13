# Demo script

**Runtime:** 2 minutes 50 seconds. Record the devnet site, https://web-devnet-production.up.railway.app, in a private window so the wallet starts empty. Every action below is a real transaction on Solana devnet with test tokens.

Before recording: the wallet used on camera needs test copies of cards (`node scripts/devnet.mjs cards <wallet>`, then upload `web-devnet` again). The price moves on its own, slowly: a position opened at the start shows a visible profit or loss by the Portfolio shot.

| Time | On screen | Narration |
|---|---|---|
| 0:00–0:15 | Home. The “On-chain index” tag, the mark price and the live chart. | “This is Kadex on Solana devnet: a perpetual market on one index of graded trading cards. You trade the card market without buying, shipping or storing a card.” |
| 0:15–0:40 | Connect the wallet; the balance shows 1,000 kdUSD from the faucet. In the ticket select Long, enter 500, point to margin, liquidation price and borrow cost, then open it. Show the confirmation and the position row. | “A trader sees the margin, the liquidation price and the borrow cost before signing. This long is now a position on-chain, and the market refuses any order that exceeds its capacity.” |
| 0:40–1:05 | Vault page, the “Test cards on devnet” row, then one card page. Vault it: confirm, and show the fractions received and the Redeem button. | “A card owner locks a graded card in the vault and receives fractions worth its appraised value. Getting the card back takes every fraction. On devnet these are test copies of real Collector Crypt cards.” |
| 1:05–1:25 | Home, Hedge mode. The suggestion lists the inventory value; enter the two limits and show the suggested short and its monthly cost. | “A dealer holding cards can size a short against that inventory. Hedge mode is the same trade, sized from what the wallet holds.” |
| 1:25–1:50 | Earn. Total value locked, then deposit 200 kdUSD and show the CLP received. Open Withdraw and show that an exit returns both assets. | “Liquidity providers deposit and receive CLP shares. The pool takes the other side of every trade and earns the borrow and trading fees. A withdrawal returns a share of both of the pool’s assets.” |
| 1:50–2:15 | Portfolio, top row: **Your open PnL**, **Pool NAV** and **Pool owes traders** side by side, then the position, the vaulted card and the pool shares below. | “Trader profit and the pool’s value belong together: when traders win, the pool owes them more. Portfolio shows both on one screen.” |
| 2:15–2:35 | Index Methodology. The solvency and depth capacity figures and which one binds. | “Open interest is capped twice, by what the pool can pay and by how deep the pricing pool is. The tighter limit wins.” |
| 2:35–2:50 | Portfolio, close the position. End on the home page. | “The programs, the price keeper and the liquidator are live on devnet. The index token there is a demonstration token; a basket backed by vaulted cards is the next step.” |

If the devnet site is unavailable, the same walkthrough works on the sample-data preview, https://web-production-6940ad.up.railway.app, with its “Demo wallet”. Say then that it is a simulation in the browser and that nothing is signed.
