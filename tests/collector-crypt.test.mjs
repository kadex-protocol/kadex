import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  categoryGroup,
  groupCounts,
  isCategoryGroup,
  isMarketplaceSource,
  isOrderBy,
  fetchCard,
  fetchListing,
  fetchMarketplacePage,
  impliedFractionPrice,
  JsonCache,
  mapLimited,
  requestBudget,
  weightedMedianWad,
  isVaultable,
  medianWad,
  parseCard,
  parseUsdc,
} from "../packages/collector-crypt/dist/index.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const WARTORTLE = "CvsHTsAjWdaxViomzmfzqkVFsNkps6Jzs8d24jjMzP43";

function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const path = url.replace("https://api.collectorcrypt.com", "");
    if (!(path in routes)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => routes[path] };
  };
  return { fetch, calls };
}

test("dollar amounts become native USDC without going through a float", () => {
  assert.equal(parseUsdc("70"), 70_000_000n);
  assert.equal(parseUsdc(23.28), 23_280_000n);
  assert.equal(parseUsdc("0.000001"), 1n);
  assert.equal(parseUsdc("2550"), 2_550_000_000n);
});

test("anything that is not a plain dollar amount is refused", () => {
  for (const bad of ["", "abc", "-5", "1e3", "1.0000001", null, undefined, {}]) {
    assert.throws(() => parseUsdc(bad), `accepted ${JSON.stringify(bad)}`);
  }
});

test("a marketplace page parses every real listing", async () => {
  const { fetch } = fakeFetch({ "/marketplace": fixture("cc_marketplace.json") });
  const page = await fetchMarketplacePage(null, { fetch });
  assert.equal(page.cards.length, 7);
  assert.deepEqual(page.rejected, []);
  assert.ok(page.nextCursor);
  assert.ok(page.total > 100_000);
  const first = page.cards[0];
  assert.equal(first.insuredValueUsdc, 200_000_000n);
  assert.equal(first.listing.priceUsdc, 650_000_000n);
  assert.equal(first.listing.currency, "USDC");
  assert.match(first.ownerWallet, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.match(first.frontImage, /^https:\/\//);
  assert.match(first.backImage, /^https:\/\//);
  assert.notEqual(first.backImage, first.frontImage);
});

test("the cursor is sent back as `cursor`", async () => {
  const { fetch, calls } = fakeFetch({ "/marketplace?cursor=a%2Bb": fixture("cc_marketplace.json") });
  await fetchMarketplacePage("a+b", { fetch });
  assert.deepEqual(calls, ["https://api.collectorcrypt.com/marketplace?cursor=a%2Bb"]);
});

test("the API key goes out as a bearer token, and only when there is one", async () => {
  const seen = [];
  const fetch = async (_url, init) => {
    seen.push(init.headers.authorization);
    return { ok: true, status: 200, json: async () => fixture("cc_marketplace.json") };
  };
  delete process.env.COLLECTOR_CRYPT_API_KEY;
  await fetchMarketplacePage(null, { fetch });
  await fetchMarketplacePage(null, { fetch, apiKey: "ccsk_explicit" });
  process.env.COLLECTOR_CRYPT_API_KEY = "ccsk_from_env";
  await fetchMarketplacePage(null, { fetch });
  delete process.env.COLLECTOR_CRYPT_API_KEY;
  assert.deepEqual(seen, [undefined, "Bearer ccsk_explicit", "Bearer ccsk_from_env"]);
});

test("name search and owner filter use the documented parameters", async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url.replace("https://api.collectorcrypt.com", ""));
    return { ok: true, status: 200, json: async () => fixture("cc_marketplace.json") };
  };
  await fetchMarketplacePage(null, { fetch }, { search: "charizard vstar" });
  await fetchMarketplacePage("abc", { fetch }, { ownerAddress: "6cWYD5eW8Brs7QqErvkwdWYtYpWAQFDdxz6nHTBPpgHA" });
  assert.deepEqual(calls, [
    "/marketplace?search=charizard+vstar",
    "/marketplace?ownerAddress=6cWYD5eW8Brs7QqErvkwdWYtYpWAQFDdxz6nHTBPpgHA&cursor=abc",
  ]);
});

test("categories fold into the groups the vault screen filters by", () => {
  assert.equal(categoryGroup("Pokemon"), "pokemon");
  assert.equal(categoryGroup("One Piece"), "one-piece");
  assert.equal(categoryGroup("Yu-Gi-Oh!"), "tcg");
  assert.equal(categoryGroup("Yu-Gi-Oh"), "tcg");
  assert.equal(categoryGroup("Boxing & MMA"), "sports");
  assert.equal(categoryGroup(" baseball "), "sports");
  assert.equal(categoryGroup("Watch"), "other");
  assert.equal(categoryGroup(""), "other");
  assert.ok(isCategoryGroup("sports"));
  assert.ok(!isCategoryGroup("Sports"));
  assert.deepEqual(
    groupCounts({ Pokemon: 10, "One Piece": 4, Lorcana: 3, "Yu-Gi-Oh!": 2, Soccer: 5, Hockey: 1, Watch: 7, "": 9 }),
    { pokemon: 10, "one-piece": 4, tcg: 5, sports: 6, other: 16 },
  );
});

test("the page size and the per-category counts come through", async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url.replace("https://api.collectorcrypt.com", ""));
    const body = { ...fixture("cc_marketplace.json"), cardsQtyByCategory: { Pokemon: 89101, Soccer: 1203, bad: "x" } };
    return { ok: true, status: 200, json: async () => body };
  };
  const page = await fetchMarketplacePage(null, { fetch }, { step: 500 });
  assert.deepEqual(calls, ["/marketplace?step=500"]);
  assert.deepEqual(page.categoryCounts, { Pokemon: 89101, Soccer: 1203 });
});

test("sorting, price range and source go out under the API's own names", async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url.replace("https://api.collectorcrypt.com", ""));
    return { ok: true, status: 200, json: async () => fixture("cc_marketplace.json") };
  };
  await fetchMarketplacePage(
    null,
    { fetch },
    { orderBy: "listedPriceAsc", listPriceMin: 0, listPriceMax: 250, marketplaceSource: "CC" },
  );
  assert.deepEqual(calls, ["/marketplace?orderBy=listedPriceAsc&listPriceMin=0&listPriceMax=250&marketplaceSource=CC"]);
  assert.ok(isOrderBy("yearDesc") && !isOrderBy("cheapest"));
  assert.ok(isMarketplaceSource("ME") && !isMarketplaceSource("me"));
});

test("only Core cards with an appraisal are vaultable", async () => {
  const { fetch } = fakeFetch({ "/marketplace": fixture("cc_marketplace.json") });
  const { cards } = await fetchMarketplacePage(null, { fetch });
  assert.equal(cards.filter(isVaultable).length, 5);
  assert.ok(cards.filter((c) => c.nftStandard === "pnft").every((c) => !isVaultable(c)));
  assert.equal(isVaultable({ ...cards[0], insuredValueUsdc: 0n }), false);
});

test("one malformed listing is reported, not fatal", async () => {
  const body = fixture("cc_marketplace.json");
  body.filterNFtCard[1] = { ...body.filterNFtCard[1], insuredValue: "N/A" };
  const { fetch } = fakeFetch({ "/marketplace": body });
  const page = await fetchMarketplacePage(null, { fetch });
  assert.equal(page.cards.length, 6);
  assert.equal(page.rejected.length, 1);
  assert.match(page.rejected[0].reason, /not a dollar amount/);
});

test("a response without filterNFtCard fails loudly", async () => {
  const { fetch } = fakeFetch({ "/marketplace": { items: [] } });
  await assert.rejects(fetchMarketplacePage(null, { fetch }), /changed shape/);
});

test("a single card joins its catalogue entry with its market entry", async () => {
  const { fetch } = fakeFetch({
    [`/cards/publicNft/${WARTORTLE}`]: fixture("cc_card.json"),
    [`/cards/publicNft/${WARTORTLE}/market`]: fixture("cc_card_market.json"),
  });
  const card = await fetchCard(WARTORTLE, { fetch });
  assert.equal(card.nftAddress, WARTORTLE);
  assert.equal(card.name, "1996 #8 Wartortle PSA 5 Japanese Basic");
  assert.equal(card.nftStandard, "core");
  assert.equal(card.insuredValueUsdc, 70_000_000n);
  assert.equal(card.listing.priceUsdc, 2_550_000_000n);
  assert.equal(card.ownerWallet, "6cWYD5eW8Brs7QqErvkwdWYtYpWAQFDdxz6nHTBPpgHA");
  assert.equal(card.certNumber, "151884628");
  assert.equal(card.set, "Pokemon Japanese Basic");
  assert.equal(card.serial, "8");
  assert.equal(card.vault, "OmniVault");
  assert.equal(card.subject, "Wartortle");
  assert.deepEqual(card.population, { grade: 31, higher: 297, total: 367 });
  assert.ok(isVaultable(card));
});

test("a closed listing is not a price", () => {
  const market = fixture("cc_card_market.json");
  const card = parseCard({
    ...fixture("cc_card.json"),
    owner: market.owner,
    listing: { ...market.listing, status: "Closed" },
  });
  assert.equal(card.listing, null);
  assert.equal(impliedFractionPrice(card), null);
});

test("an unknown card is an error, not an empty card", async () => {
  const { fetch } = fakeFetch({});
  await assert.rejects(fetchCard(WARTORTLE, { fetch }), /answered 404/);
});

test("the implied fraction price is ask over appraisal, in WAD", async () => {
  const { fetch } = fakeFetch({
    [`/cards/publicNft/${WARTORTLE}`]: fixture("cc_card.json"),
    [`/cards/publicNft/${WARTORTLE}/market`]: fixture("cc_card_market.json"),
  });
  const card = await fetchCard(WARTORTLE, { fetch });
  assert.equal(impliedFractionPrice(card), 36_428_571n);
  assert.equal(impliedFractionPrice({ ...card, listing: { priceUsdc: 1n, currency: "SOL" } }), null);
});

test("the median ignores an absurd ask", async () => {
  const { fetch } = fakeFetch({ "/marketplace": fixture("cc_marketplace.json") });
  const { cards } = await fetchMarketplacePage(null, { fetch });
  const prices = cards.filter(isVaultable).map(impliedFractionPrice);
  assert.equal(medianWad(prices), 1_222_222n);
  assert.equal(medianWad([...prices, 307_000_000n, 36_428_571n]), 1_466_666n);
});

test("the median of an even sample is the midpoint, and of nothing is nothing", () => {
  assert.equal(medianWad([1_000_000n, 2_000_000n]), 1_500_000n);
  assert.equal(medianWad([]), null);
});

test("the weighted median counts each card by its weight", () => {
  const xs = (pairs) => pairs.map(([price, weight]) => ({ price, weight }));
  // Equal weights agree with the plain median, odd and even.
  assert.equal(weightedMedianWad(xs([[3n, 1n], [1n, 1n], [2n, 1n]])), medianWad([3n, 1n, 2n]));
  assert.equal(weightedMedianWad(xs([[1_000_000n, 5n], [2_000_000n, 5n]])), 1_500_000n);
  // A card holding most of the index sets its price; an outlier with little weight does not.
  assert.equal(weightedMedianWad(xs([[1_100_000n, 6_000n], [900_000n, 2_000n], [307_000_000n, 2_000n]])), 1_100_000n);
  assert.equal(weightedMedianWad(xs([[5n, 0n]])), null);
  assert.equal(weightedMedianWad([]), null);
});

test("one card's listing is one request, matched on the exact mint", async () => {
  const market = fixture("cc_card_market.json");
  const card = { ...fixture("cc_card.json"), listing: { ...market.listing, price: 77 } };
  const other = { ...card, nftAddress: "6cWYD5eW8Brs7QqErvkwdWYtYpWAQFDdxz6nHTBPpgHA" };
  const { fetch, calls } = fakeFetch({ [`/marketplace?search=${WARTORTLE}`]: { filterNFtCard: [other, card], total: 2 } });
  const found = await fetchListing(WARTORTLE, { fetch });
  assert.equal(calls.length, 1);
  assert.equal(found.nftAddress, WARTORTLE);
  assert.equal(impliedFractionPrice(found), 1_100_000n);

  const none = fakeFetch({ [`/marketplace?search=${WARTORTLE}`]: { filterNFtCard: [other] } });
  assert.equal(await fetchListing(WARTORTLE, { fetch: none.fetch }), null, "a search hit on another card is not this card");
});

test("the cache serves repeats and concurrent callers from one request, and forgets failures", async () => {
  const { fetch, calls } = fakeFetch({ "/marketplace": fixture("cc_marketplace.json") });
  const limits = { cache: new JsonCache(60_000) };
  await Promise.all([1, 2, 3].map(() => fetchMarketplacePage(null, { fetch, limits })));
  await fetchMarketplacePage(null, { fetch, limits });
  assert.equal(calls.length, 1);
  await fetchMarketplacePage(null, { fetch, limits, apiKey: "ccsk_test" });
  assert.equal(calls.length, 2, "keyed and anonymous responses are kept apart");

  let fail = true;
  const flaky = async () => (fail ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => fixture("cc_marketplace.json") });
  const cache = new JsonCache(60_000);
  await assert.rejects(fetchMarketplacePage(null, { fetch: flaky, limits: { cache } }), /answered 500/);
  fail = false;
  assert.ok((await fetchMarketplacePage(null, { fetch: flaky, limits: { cache } })).cards.length > 0);
});

test("a 429 is retried after Retry-After, and given up on after the retries", async () => {
  let n = 0;
  const limited = (until) => async () => {
    n += 1;
    return n <= until
      ? { ok: false, status: 429, headers: { get: (h) => (h === "retry-after" ? "0.01" : null) }, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => fixture("cc_marketplace.json") };
  };
  assert.ok((await fetchMarketplacePage(null, { fetch: limited(2), limits: { retries: 3 } })).cards.length > 0);
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(fetchMarketplacePage(null, { fetch: limited(9), limits: { retries: 1 } }), /answered 429/);
  assert.equal(n, 2);
});

test("the budget spaces requests past the burst", async () => {
  const budget = requestBudget(600, 1); // 10 a second, no burst beyond one
  const start = Date.now();
  await Promise.all([1, 2, 3].map(() => budget.take()));
  assert.ok(Date.now() - start >= 180, `three takes at 10/s took ${Date.now() - start} ms`);
});

test("mapLimited keeps order and never runs more than n at once", async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimited([5, 1, 4, 2, 3], 2, async (x) => {
    peak = Math.max(peak, ++running);
    await new Promise((r) => setTimeout(r, x));
    running -= 1;
    return x * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30]);
  assert.equal(peak, 2);
});

test("the appraisal index is current appraisal over whitelisted appraisal, weighted", async () => {
  const { appraisalIndexFrom } = await import("../packages/collector-crypt/dist/chain.js");
  const { PublicKey } = await import("@solana/web3.js");
  const key = (n) => new PublicKey(Buffer.alloc(32, n));
  const wl = [
    { asset: key(1), fractionsPerCard: 5_000n * 1_000_000n, weightBps: 6_000, enabled: true }, // re-appraised +10%
    { asset: key(2), fractionsPerCard: 2_000n * 1_000_000n, weightBps: 2_000, enabled: true }, // unchanged
    { asset: key(3), fractionsPerCard: 2_000n * 1_000_000n, weightBps: 2_000, enabled: true }, // halved
    { asset: key(4), fractionsPerCard: 1_000n * 1_000_000n, weightBps: 1, enabled: true }, // no answer
  ];
  const now = new Map([
    [key(1).toBase58(), 5_500n * 1_000_000n],
    [key(2).toBase58(), 2_000n * 1_000_000n],
    [key(3).toBase58(), 1_000n * 1_000_000n],
  ]);
  const r = appraisalIndexFrom(wl, now, 3);
  assert.deepEqual(r.samples.map((s) => s.price), [1_100_000n, 1_000_000n, 500_000n]);
  assert.equal(r.index, 1_100_000n, "the card holding 60% of the weight sets it");
  assert.equal(r.median, 1_000_000n);
  assert.deepEqual(r.unpriced.map((u) => u.reason), ["no appraisal"]);
  assert.equal(appraisalIndexFrom(wl, now, 4).index, null, "three answers, four required: nothing");
});
