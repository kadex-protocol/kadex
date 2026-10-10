/**
 * The launch basket (#10): the selection rules, the weights, and the guard
 * that refuses to whitelist a basket whose appraisals have moved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eligible, RULES, selectBasket, shareBps } from "../scripts/select-basket.mjs";
import { planBasket } from "../scripts/whitelist-core.mjs";

const USDC = 1_000_000n;
let n = 0;
/** A listed Core card; `id` keeps names distinct unless a test wants a repeat. */
const card = ({ value, ask = value, category = "Pokemon", grader = "PSA", name, standard = "core" } = {}) => {
  n += 1;
  const address = `Asset${String(n).padStart(4, "0")}`;
  return {
    nftAddress: address,
    name: name ?? `2020 #${n} Card ${n} PSA 10 Set`,
    category,
    grade: "GEM-MT 10",
    gradingCompany: grader,
    nftStandard: standard,
    insuredValueUsdc: BigInt(value) * USDC,
    listing: { priceUsdc: BigInt(ask) * USDC, currency: "USDC" },
    frontImage: null,
  };
};

test("each rule has its reason", () => {
  assert.equal(eligible(card({ value: 2_000 })), null);
  assert.match(eligible(card({ value: 2_000, standard: "pnft" })), /Core/);
  assert.match(eligible(card({ value: 500 })), /band/);
  assert.match(eligible(card({ value: 9_000 })), /band/);
  assert.match(eligible(card({ value: 2_000, ask: 3_000 })), /ask too far/);
  assert.match(eligible(card({ value: 2_000, ask: 1_500 })), /ask too far/);
  assert.match(eligible(card({ value: 2_000, grader: "Teddy Baldassarre" })), /grader/);
  assert.match(eligible({ ...card({ value: 2_000 }), listing: { priceUsdc: 2_000n * USDC, currency: "SOL" } }), /USDC/);
});

test("weights are appraisal shares that sum to exactly 10,000", () => {
  assert.deepEqual(shareBps([1n, 1n, 1n]), [3_334, 3_333, 3_333]);
  const w = shareBps([5_350n, 4_200n, 4_000n, 3_850n, 3_650n, 3_500n, 3_150n, 2_500n, 4_200n, 3_500n]);
  assert.equal(w.reduce((a, b) => a + b, 0), 10_000);
  assert.equal(w[0], 1_412);
});

test("quotas fill highest appraisal first, one card per name, every weight under the cap", () => {
  const pool = [
    ...[5_000, 4_800, 4_500, 4_200, 4_000, 3_800, 3_600].map((value) => card({ value })),
    card({ value: 4_900, name: "2020 #1 Card 1 PSA 9 Set" }), // the same print as an earlier card, one grade down
    ...[3_000, 2_800, 2_000].map((value) => card({ value, category: "One Piece" })),
    ...[3_500, 3_200].map((value) => card({ value, category: "Lorcana" })),
    card({ value: 200, category: "Baseball" }),
  ];
  // Make the repeat really a repeat of the first card's name.
  pool[7].name = pool[0].name.replace("PSA 10", "PSA 9");
  const basket = selectBasket(pool);
  assert.equal(basket.length, 10);
  assert.deepEqual(
    basket.map((b) => b.group),
    ["pokemon", "pokemon", "pokemon", "pokemon", "pokemon", "pokemon", "one-piece", "one-piece", "tcg", "tcg"],
  );
  assert.ok(!basket.some((b) => b.card === pool[7]), "the second grade of the same print is skipped");
  assert.equal(basket.reduce((t, b) => t + b.weightBps, 0), 10_000);
  assert.ok(basket.every((b) => b.weightBps <= RULES.maxWeightBps));
});

test("a card over the cap is swapped for the next one in its group", () => {
  const big = card({ value: 6_000 });
  const pool = [
    big,
    ...[1_000, 1_000, 1_000, 1_000, 1_000, 1_000].map((value) => card({ value })),
    ...[1_000, 1_000].map((value) => card({ value, category: "One Piece" })),
    ...[1_000, 1_000].map((value) => card({ value, category: "Lorcana" })),
  ];
  const basket = selectBasket(pool);
  assert.ok(!basket.some((b) => b.card === big), "6,000 of 15,000 would be 40%");
  assert.ok(basket.every((b) => b.weightBps <= RULES.maxWeightBps));
});

test("too few cards to stay under the cap is an error, not a lopsided basket", () => {
  assert.throws(() => selectBasket([card({ value: 2_000 }), card({ value: 2_000 })]), /weight cap/);
});

test("the committed basket follows the rules", () => {
  const basket = JSON.parse(readFileSync(new URL("../deployments/basket.json", import.meta.url), "utf8"));
  assert.equal(basket.cards.reduce((t, c) => t + c.weightBps, 0), 10_000);
  assert.ok(basket.cards.every((c) => c.weightBps <= RULES.maxWeightBps));
  assert.equal(new Set(basket.cards.map((c) => c.asset)).size, basket.cards.length);
});

test("whitelisting refuses a basket whose appraisals moved", () => {
  const live = card({ value: 2_000 });
  const basket = { cards: [{ asset: live.nftAddress, name: "x", appraisalUsd: "2000.00", weightBps: 10_000 }] };
  const ok = (address, value) => new Map([[address, { ...live, nftAddress: "11111111111111111111111111111111", insuredValueUsdc: BigInt(value) * USDC }]]);
  const asset = live.nftAddress;
  assert.throws(() => planBasket(basket, ok(asset, 2_100)), /re-run scripts\/select-basket/);
  assert.throws(() => planBasket({ cards: [{ ...basket.cards[0], weightBps: 9_000 }] }, ok(asset, 2_000)), /sum to 9000/);
  assert.throws(() => planBasket(basket, new Map()), /not on Collector Crypt/);
  assert.equal(planBasket(basket, ok(asset, 2_000))[0].plan.weightBps, 10_000);
});
