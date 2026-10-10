#!/usr/bin/env node
/**
 * The launch basket, chosen by written rules from live Collector Crypt
 * listings, not by hand. Same listings in, same basket out.
 *
 *   node scripts/select-basket.mjs            # scan, print, write deployments/basket.json
 *   DRY_RUN=1 node scripts/select-basket.mjs  # scan and print only
 *
 * The rules (`RULES`), and why:
 * - Metaplex Core with an appraisal: the only cards card-vault can hold.
 * - A live USDC ask within 0.8–1.25x the appraisal: the treasury can buy it
 *   near the value its fractions are minted at, and its ask does not drag
 *   the external median (#8) away from 1.00.
 * - Graded by PSA, Beckett or CGC; trading cards only (no watches, comics).
 * - Appraisal between $1,000 and $6,000, one card per name: no single card
 *   dominates and the basket is not five copies of one print.
 * - Quotas per category group, filled highest appraisal first.
 * - Weight = the card's share of the basket's total appraisal, in bps. With
 *   one of each card deposited, that is also its share of the pool's card
 *   sleeve, the quantity `max_card_weight` (15%) caps, so the two never
 *   disagree. Any card over the cap is dropped and the next one taken.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { categoryGroup, collectorCryptLimits, fetchMarketplacePage, isVaultable } from "@kadex/collector-crypt";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const USDC = 1_000_000n;

export const RULES = {
  quotas: { pokemon: 6, "one-piece": 2, tcg: 2, sports: 0, other: 0 },
  minAppraisal: 1_000n * USDC,
  maxAppraisal: 6_000n * USDC,
  /** Ask over appraisal, in bps. */
  minAskRatioBps: 8_000n,
  maxAskRatioBps: 12_500n,
  graders: ["PSA", "Beckett", "CGC", "BGS"],
  maxWeightBps: 1_500,
};

const askRatioBps = (c) => (c.listing.priceUsdc * 10_000n) / c.insuredValueUsdc;
const byAppraisalDesc = (a, b) =>
  a.insuredValueUsdc === b.insuredValueUsdc ? a.nftAddress.localeCompare(b.nftAddress) : a.insuredValueUsdc > b.insuredValueUsdc ? -1 : 1;
/** "2021 #4 Charizard PSA 10 …" and "2021 #4 Charizard PSA 9 …" are one name. */
const nameKey = (c) => c.name.replace(/\b(PSA|BGS|CGC|Beckett)\b.*$/i, "").trim().toLowerCase();

export function eligible(card, rules = RULES) {
  if (!isVaultable(card)) return "not a Core card with an appraisal";
  if (!card.listing || card.listing.currency !== "USDC") return "no USDC ask";
  if (!rules.graders.includes(card.gradingCompany)) return `grader ${card.gradingCompany || "none"}`;
  if (card.insuredValueUsdc < rules.minAppraisal || card.insuredValueUsdc > rules.maxAppraisal) return "appraisal outside the band";
  const r = askRatioBps(card);
  if (r < rules.minAskRatioBps || r > rules.maxAskRatioBps) return "ask too far from the appraisal";
  return null;
}

/** Largest-remainder bps of each value's share, summing to exactly 10,000. */
export function shareBps(values) {
  const total = values.reduce((t, v) => t + v, 0n);
  const raw = values.map((v, i) => ({ i, floor: (v * 10_000n) / total, rem: (v * 10_000n) % total }));
  let left = 10_000n - raw.reduce((t, r) => t + r.floor, 0n);
  for (const r of [...raw].sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1))) {
    if (left === 0n) break;
    r.floor += 1n;
    left -= 1n;
  }
  return raw.map((r) => Number(r.floor));
}

export function selectBasket(cards, rules = RULES) {
  const pools = {};
  const seen = new Set();
  for (const c of [...cards].sort(byAppraisalDesc)) {
    if (eligible(c, rules) !== null) continue;
    if (seen.has(c.nftAddress) || seen.has(nameKey(c))) continue;
    seen.add(c.nftAddress).add(nameKey(c));
    (pools[categoryGroup(c.category)] ??= []).push(c);
  }
  // Take each quota from the top, then drop the heaviest card while any is over the cap.
  const taken = Object.entries(rules.quotas).flatMap(([g, n]) => (pools[g] ?? []).slice(0, n).map((c) => ({ c, g })));
  const spare = Object.fromEntries(Object.entries(rules.quotas).map(([g, n]) => [g, (pools[g] ?? []).slice(n)]));
  for (;;) {
    const weights = shareBps(taken.map((t) => t.c.insuredValueUsdc));
    const over = weights.findIndex((w) => w > rules.maxWeightBps);
    if (over === -1) {
      return taken.map(({ c, g }, i) => ({ card: c, group: g, weightBps: weights[i] }));
    }
    const { g } = taken[over];
    taken.splice(over, 1);
    const next = spare[g]?.shift();
    if (next) taken.push({ c: next, g });
    if (taken.length * rules.maxWeightBps < 10_000) throw new Error("not enough eligible cards to stay under the weight cap");
  }
}

export function basketFile(selected, scanned, at = new Date()) {
  const usd = (n) => (Number(n) / 1e6).toFixed(2);
  return {
    note: "Launch basket for issue #10. Chosen by scripts/select-basket.mjs from live Collector Crypt listings; re-run to refresh.",
    selectedAt: at.toISOString(),
    listingsScanned: scanned,
    rules: {
      ...RULES,
      minAppraisal: usd(RULES.minAppraisal),
      maxAppraisal: usd(RULES.maxAppraisal),
      minAskRatioBps: Number(RULES.minAskRatioBps),
      maxAskRatioBps: Number(RULES.maxAskRatioBps),
    },
    depositor: "protocol treasury: buys each card at its ask, then vaults it with fractionalize_core",
    totals: {
      appraisalUsd: usd(selected.reduce((t, s) => t + s.card.insuredValueUsdc, 0n)),
      costAtAskUsd: usd(selected.reduce((t, s) => t + s.card.listing.priceUsdc, 0n)),
    },
    cards: selected.map(({ card: c, group, weightBps }) => ({
      asset: c.nftAddress,
      name: c.name,
      group,
      category: c.category,
      grade: `${c.gradingCompany} ${c.grade}`,
      certNumber: c.certNumber,
      year: c.year,
      set: c.set,
      appraisalUsd: usd(c.insuredValueUsdc),
      askUsd: usd(c.listing.priceUsdc),
      owner: c.ownerWallet,
      weightBps,
      image: c.frontImage,
    })),
  };
}

async function main() {
  const limits = collectorCryptLimits();
  const cards = [];
  let cursor = null;
  for (let page = 0; page < 30; page += 1) {
    const p = await fetchMarketplacePage(cursor, { limits }, { step: 500 });
    cards.push(...p.cards);
    cursor = p.nextCursor;
    if (!cursor) break;
  }
  const selected = selectBasket(cards);
  const file = basketFile(selected, cards.length);
  for (const c of file.cards) {
    console.log(`${String(c.weightBps).padStart(5)} bps  $${c.appraisalUsd.padStart(9)}  ask $${c.askUsd.padStart(9)}  ${c.group.padEnd(9)}  ${c.name}`);
  }
  console.log(`\n${file.cards.length} cards from ${cards.length} listings · appraisal $${file.totals.appraisalUsd} · cost at ask $${file.totals.costAtAskUsd}`);
  if (process.env.DRY_RUN === "1") return console.log("dry run: nothing written");
  const out = process.env.KADEX_BASKET ?? join(ROOT, "deployments", "basket.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(file, null, 2) + "\n");
  console.log(`wrote ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
