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

Set `COLLECTOR_CRYPT_API_KEY` and the client, the whitelist script, the feed
and the web route handlers all send it. It is read on the server only and never
reaches the browser. An invalid key is silently ignored on marketplace routes,
so a typo looks exactly like no key at all.

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
| Whitelist a card at its appraisal | `scripts/whitelist-core.mjs` | `DRY_RUN=1 node scripts/whitelist-core.mjs <asset> --weight-bps <n>` |
| `external_median` feed | `apps/external-feed` | `FEED_KEYPAIR=… ORACLE=… npx tsx apps/external-feed/src/index.ts` |
| Real cards on the vault screen | `apps/web/app/vault`, through `/api/collector-crypt/*` | `npm run web` |
| The whole path against a validator | `tests/cc/whitelist.test.mjs` | `npm run test:cc:chain` |

`weight_bps` has no default in the whitelist script. The appraisal comes from
their API; a card's share of the index is our decision and nobody else's.

### The median, and why the feed starts in dry run

A fraction is $1 of `insuredValue`, so `listing.price / insuredValue` is the
price per fraction a listing implies — the same unit as `oracle.price`. The
feed publishes the **median** of that ratio over whitelisted Core cards with an
active USDC listing, and nothing at all below `MIN_SAMPLES` (default 3).

It is a median because asks are not fills. On 7 Oct 2026 one page of 100
listings ran from 0.89x to 307x the appraisal, with a median of 1.26x.

That 1.26 is also why `PUBLISH=1` is opt-in. Against an AMM price of 1.00 it
is a 21% divergence, past `max_divergence` (15%), and publishing it puts the
oracle in `Diverged`, which stops new positions. Whether asks sit above
appraisals because the appraisals are stale or because sellers are hopeful is
a question to answer before switching it on, not after.

## What this does not solve

Reading their chain data proves the token exists. It does not prove the card
does. The trust moves from our admin to Collector Crypt, PSA and a Delaware
vault — better, because they have a business to lose, but it is delegation
rather than elimination. See `docs/custody.md`.
