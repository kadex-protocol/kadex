# Collector Crypt — what we read, and how

Verified live on 5 Oct 2026 by calling the API and then checking the same
asset on mainnet-beta. Nothing here is taken from documentation alone; where
the docs and the chain disagreed, the chain won.

**No partnership, no credentials.** The marketplace API is public and needs no
key; a key only raises rate limits. The assets are on a public chain.

## The API

Base: `https://api.collectorcrypt.com` · dev: `https://dev-api.collectorcrypt.com`

| Endpoint | Gives us |
|---|---|
| `GET /marketplace` | every active listing, paginated |
| `GET /cards/publicNft/:cardId` | one card's catalogue data |
| `GET /cards/publicNft/:cardId/market` | whether it is buyable, and at what price |

One call to `GET /marketplace` returned **160,522 listings**, 89,471 of them
Pokemon. `limit` is rejected as an unknown property — pagination is by cursor
(`nextCursor`), not by limit.

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

## What this does not solve

Reading their chain data proves the token exists. It does not prove the card
does. The trust moves from our admin to Collector Crypt, PSA and a Delaware
vault — better, because they have a business to lose, but it is delegation
rather than elimination. See `docs/custody.md` when it exists.
