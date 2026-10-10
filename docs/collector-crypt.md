# Collector Crypt — what we read, and how

Verified live on 5 Oct 2026 by calling the API and then checking the same
asset on mainnet-beta. Nothing here is taken from documentation alone; where
the docs and the chain disagreed, the chain won.

**No partnership, no credentials.** The marketplace API is public and needs no
key; a key only raises rate limits. The assets are on a public chain.

## The API key

Optional. Without one the limit is 300 requests a minute per IP; with one,
3,000. Requested by email to support@collectorcrypt.com, sent as
`Authorization: Bearer ccsk_…` — the API does not read `x-api-key`.

Staying inside it (`packages/collector-crypt/src/limits.ts`, opt-in through
`limits`, shared per process by `collectorCryptLimits()`):

- **Cache, 30 s.** Responses say `cache-control: max-age=30`, so that is the
  provider's own terms. Concurrent callers for the same path share one
  request; failures are not cached.
- **Budget.** A token bucket at 80% of the limit: 240 a minute, 2,400 keyed.
- **Retry.** A 429 or 503 waits `Retry-After` (or 1 s, 2 s, 4 s), three times.
- **One request per card.** `/marketplace?search=<mint>` is an exact match
  carrying appraisal and listing together, where `fetchCard` needs two. The
  feed uses it, eight cards at a time; an unlisted card is unpriced either way.

Set `COLLECTOR_CRYPT_API_KEY` and the client, the whitelist script, the feed
and the web route handlers all send it. The gacha API has its own key; see
below. It is read on the server only and never
reaches the browser. An invalid key is silently ignored on marketplace routes,
so a typo looks exactly like no key at all.

## The gacha API

A second host, `https://gacha.collectorcrypt.com`, with its own key. Checked
live on 9 Oct 2026.

| Endpoint | Key | Gives us |
|---|---|---|
| `GET /api/v1/machines` | yes | **your** machines: config, live status (`enabled`), EV, per-tier stock, low/sells flags |
| `GET /api/v1/stock` | yes | **your** stock per tier, with the low-stock buffer status |
| `GET /api/machines` | no | house machines only — 119 on 9 Oct |
| `GET /api/stock` | no | house stock per tier — 151 machine codes |

- The key goes out as **`x-api-key`**, not the marketplace's `Authorization:
  Bearer`. It lives in `COLLECTOR_CRYPT_GACHA_API_KEY`, server side only;
  `apps/web/.env.example` lists it. Without a key the v1 endpoints answer 401.
- A machine is a pack: `price` per pull, `odds` and `tierRanges` per tier
  (common, uncommon, rare, epic), `stock` per tier, `ev` per pull and
  `instantBuyback` as a percent. Amounts are dollars as JSON numbers — `ev`
  carries float noise (`54.86571367572274`) — so the client rounds each to the
  nearest native USDC unit once and stays BigInt after that.
- Partner machines carry an `owner` wallet; house machines have `null`.
- `/machines` embeds stock and `/stock` repeats it. Fetched a moment apart,
  10 of 119 machines disagreed: stock moves between two requests.
- The v1 responses were documented to us but not yet seen. The client reads
  extra booleans into `flags` and accepts a tier as either a bare count or an
  object with a count and a low flag, and `npm run test:cc:live` prints what
  your machines actually return once the key is set.

| Piece | Where | Run |
|---|---|---|
| Client | `packages/collector-crypt/src/gacha.ts` | `npm run test:cc` |
| Server route | `apps/web/app/api/collector-crypt/gacha` | `GET /api/collector-crypt/gacha` — `scope` says house or mine |
| Live check | `tests/cc/gacha.live.mjs` | `npm run test:cc:live` (loads `apps/web/.env.local`) |

## The API

Base: `https://api.collectorcrypt.com` · dev: `https://dev-api.collectorcrypt.com`

| Endpoint | Gives us |
|---|---|
| `GET /marketplace` | every active listing, paginated |
| `GET /cards/publicNft/:cardId` | one card's catalogue data |
| `GET /cards/publicNft/:cardId/market` | whether it is buyable, and at what price |

One call to `GET /marketplace` returned **160,522 listings**, 89,471 of them
Pokemon. `limit` is rejected as an unknown property — the page size is `step`
(100 by default) and pagination is by cursor: the response carries
`nextCursor`, and it goes back as `?cursor=`.

The query parameters are a closed set, and anything outside it is a 400:
`step`, `page`, `cursor`, `orderBy`, `search`, `ownerAddress`,
`marketplaceSource`, `listPriceMin`, `listPriceMax`. `search` is a substring
match on the name and an exact match on the mint address; `ownerAddress` is an
exact wallet. There is no parameter for `nftStandard` or category, so "Core
only" is a filter we apply ourselves, after the page arrives.

Listings come from two sources, `CC` and `ME`. The default order is newest
listing first, which in practice is all `CC`; sorting by price mixes both.

Types are not uniform across endpoints, re-checked on 7 Oct 2026:

- `insuredValue` is a **string** (`"70"`) everywhere.
- `listing.price` is a number in `/marketplace` and a string in `/market`.
- `/cards/publicNft/:id` has no `owner` and no `listing`; both live in
  `/market`, so one card is two requests.

### The fields that matter to us

```
nftAddress      the asset on chain          -> what the vault verifies
insuredValue    the appraisal, in dollars   -> fractions_per_card
grade           e.g. "EX 5"                 -> whitelist record
gradingCompany  PSA, BGS, CGC               -> whitelist record
owner.wallet    who holds it                -> who we need to deposit
listing.price   asking price                -> external_median
listing.currency                            -> "USDC" in every sample
nftStandard     "core" or "pnft"            -> SEE BELOW
```

Every one of the first 100 listings carried a price, **denominated in USDC**.
Same unit the protocol settles in, so no conversion step to get wrong.

## Not every card is a Core asset

In that sample: **75 `core`, 25 `pnft`.**

That is the finding that shapes the work. `pnft` is a programmable NFT under
Token Metadata — a different standard, different accounts, a different
transfer. Supporting both doubles the deposit path.

**v1 should whitelist Core only.** It is the majority, it is what they are
migrating to, and `nftStandard` lets us filter before anyone wastes a
transaction.

## The collection, which the docs do not publish

```
CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac
```

Read off a live card by decoding its account, not found in any document. A
vanity address — it begins with `CCrypt`.

Every asset they mint carries this as its **update authority**, which is what
makes membership checkable rather than asserted. `card-vault` holds it as
`COLLECTOR_CRYPT_COLLECTION`.

## The card the test is built on

`CvsHTsAjWdaxViomzmfzqkVFsNkps6Jzs8d24jjMzP43` — a 1996 Wartortle, PSA 5,
Japanese, insured at $70, listed at 2,550 USDC.

Decoded from mainnet:

```
key              1  (AssetV1)
owner            6cWYD5eW8Brs7QqErvkwdWYtYpWAQFDdxz6nHTBPpgHA
update_authority Collection(CCryptUfe…)
name             1996 #8 Wartortle PSA 5 Japanese
```

Those 275 bytes are a fixture in `core_asset.rs`. A fixture I invent proves
the parser agrees with me; this one proves it agrees with the chain.

## Where each piece lands

- **`insuredValue` → `whitelist_card`.** Their appraisal becomes our fraction
  count. We inherit their valuation and should say so.
- **`listing.price` → `external_median`.** A sanity bound, never the price
  itself. Listings are asks, not fills — somebody can list a card at any
  number they like, and a market that priced itself off asking prices would
  be trivially moved. It belongs exactly where issue #8 puts it.
- **`nftAddress` → the vault.** Verified against the collection above.

## What is wired

| Piece | Where | Run |
|---|---|---|
| API client | `packages/collector-crypt` | `npm run test:cc` |
| Choose the launch basket | `scripts/select-basket.mjs` | `DRY_RUN=1 node scripts/select-basket.mjs` |
| Whitelist a card at its appraisal | `scripts/whitelist-core.mjs` | `DRY_RUN=1 node scripts/whitelist-core.mjs <asset> --weight-bps <n>` |
| Whitelist the whole basket | `scripts/whitelist-core.mjs` | `DRY_RUN=1 node scripts/whitelist-core.mjs --basket deployments/basket.json` |
| `external_median` feed | `apps/external-feed` | `FEED_KEYPAIR=… ORACLE=… npx tsx apps/external-feed/src/index.ts` |
| Real cards on the vault screen | `apps/web/app/vault`, through `/api/collector-crypt/*` | `npm run web` |
| The whole path against a validator | `tests/cc/whitelist.test.mjs` | `npm run test:cc:chain` |

`weight_bps` has no default in the whitelist script. The appraisal comes from
their API; a card's share of the index is our decision and nobody else's.

### The launch basket (#10)

`deployments/basket.json`: ten cards chosen by `scripts/select-basket.mjs`
from live listings on 10 Oct 2026, by rules rather than by hand.

| Rule | Why |
|---|---|
| Core, appraised, live USDC ask within 0.8–1.25× the appraisal | the treasury can buy it near the value its fractions mint at, and its ask keeps the external median near 1.00 |
| PSA, Beckett or CGC; trading cards only | graded and comparable; no watches or comics |
| Appraisal $1,000–$6,000, one card per name | no single card dominates; not one print five times |
| 6 Pokémon, 2 One Piece, 2 other TCG | the market's actual mix; no sports card was listed above $250 |
| Weight = share of the basket's total appraisal | with one of each deposited, it equals the card's share of the sleeve, which `max_card_weight` (15%) caps; a card over it is swapped for the next |

Result: 6.60%–14.12% each, $37,900 appraised, $39,134 to buy at the asks.
**Depositor:** the protocol treasury buys each card at its ask and vaults it
with `fractionalize_core`. Re-run the script to refresh; the whitelist script
refuses a basket whose appraisals have moved since it was written, because
the weights would no longer match the sleeve.

### The external reference: appraisal drift, not asks (#11)

**What the feed publishes.** For each enabled whitelisted card, its current
`insuredValue` over the appraisal it was whitelisted at (`fractions_per_card`,
one fraction per dollar): a price per fraction in WAD, the unit of
`oracle.price`. The weighted median by `weight_bps` goes to
`set_external_median`; nothing below `MIN_SAMPLES` (default 5). It reads
1.000 at launch and moves only when Collector Crypt re-appraises a card.
`SOURCE=asks` publishes the asks median instead; both are logged every tick.

**Why not asks.** Measured 10 Oct 2026 over 4,734 appraised Core USDC
listings:

| | p10 | median | p90 | listed below 0.87x |
|---|---|---|---|---|
| ask / appraisal, all | 1.00 | 1.52 | 5.00 | 1% |
| $1,000–$6,000 only | 1.00 | 1.48 | 4.80 | 1% |

Asks start at the appraisal and run up from it, the same in every value
band: the appraisal is a floor sellers price above, not a stale number the
market has left behind. A median of asks is therefore biased high by
construction. And it would go empty at launch: a vaulted card is owned by
its vault PDA and cannot be listed, so once the treasury deposits the basket
no whitelisted card has an ask. The API returns only active listings (130
checked, none closed), so sales cannot correct it either; see #18.

**What it is and is not.** An appraisal is a valuation, not a tradable
price. It only gates: when the AMM price is more than `max_divergence` (15%)
from it, `evaluate_state` returns `Diverged` and `require_tradeable` refuses
new positions; closing and liquidation are unaffected. It never prices
anything, and if the feed stops, the bound lapses after `max_staleness_secs`
rather than halting the market.

**The trade-off, stated.** If Collector Crypt re-appraises rarely, the
reference stays near 1.00 and new positions pause whenever the AMM moves more
than 15% from the launch value, until appraisals catch up or the bound is
reviewed. That is the defence working as a circuit breaker, but it can pause
a legitimate move. Watch the logged asks/appraisal gap; executed sales (#18)
are the better reference once they can be read.

**Turning it on.** After the basket is whitelisted and deposited:
`PUBLISH=1 FEED_KEYPAIR=… ORACLE=… npx tsx apps/external-feed/src/index.ts`.

## What this does not solve

Reading their chain data proves the token exists. It does not prove the card
does. The trust moves from our admin to Collector Crypt, PSA and a Delaware
vault — better, because they have a business to lose, but it is delegation
rather than elimination. See `docs/custody.md`.
