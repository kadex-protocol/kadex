import { WAD } from "@kadex/types";
import { type CollectorLimits } from "./limits.js";

export const COLLECTOR_CRYPT_API = "https://api.collectorcrypt.com";
export const COLLECTOR_CRYPT_COLLECTION = "CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac";

const USDC_DECIMALS = 6;

export interface CollectorListing {
  priceUsdc: bigint;
  currency: string;
}

export interface CollectorCard {
  id: string;
  nftAddress: string;
  name: string;
  category: string;
  grade: string;
  gradingCompany: string;
  year: number | null;
  nftStandard: string;
  insuredValueUsdc: bigint;
  ownerWallet: string | null;
  listing: CollectorListing | null;
  frontImage: string | null;
  backImage: string | null;
  certNumber: string | null;
  set: string | null;
  serial: string | null;
  vault: string | null;
  subject: string | null;
  population: { grade: number; higher: number; total: number } | null;
}

export interface MarketplacePage {
  cards: CollectorCard[];
  rejected: { id: string; reason: string }[];
  nextCursor: string | null;
  total: number;
  categoryCounts: Record<string, number>;
}

export interface ClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  apiKey?: string;
  /** Cache, request budget and retries; see `collectorCryptLimits()`. */
  limits?: CollectorLimits;
}

export const apiKeyFromEnv = (): string | undefined =>
  (typeof process !== "undefined" && process.env.COLLECTOR_CRYPT_API_KEY) || undefined;

type Raw = Record<string, unknown>;

const isRecord = (x: unknown): x is Raw => typeof x === "object" && x !== null && !Array.isArray(x);

const text = (raw: Raw, key: string): string => {
  const v = raw[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`card field ${key} is missing`);
  return v;
};

const optionalText = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function parseUsdc(value: unknown): bigint {
  const s = typeof value === "number" ? String(value) : value;
  if (typeof s !== "string" || !/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`not a dollar amount: ${JSON.stringify(value)}`);
  }
  const [whole = "0", fraction = ""] = s.split(".");
  if (fraction.length > USDC_DECIMALS) throw new Error(`more than ${USDC_DECIMALS} decimals: ${s}`);
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(fraction.padEnd(USDC_DECIMALS, "0"));
}

function parseListing(raw: unknown): CollectorListing | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.status === "string" && raw.status !== "Active") return null;
  return { priceUsdc: parseUsdc(raw.price), currency: text(raw, "currency") };
}

function parsePopulation(raw: unknown): CollectorCard["population"] {
  if (!isRecord(raw)) return null;
  const { gradePopulation: grade, populationHigher: higher, totalPopulation: total } = raw;
  if (typeof grade !== "number" || typeof higher !== "number" || typeof total !== "number") return null;
  return { grade, higher, total };
}

export function parseCard(raw: unknown): CollectorCard {
  if (!isRecord(raw)) throw new Error("card is not an object");
  const images = isRecord(raw.images) ? raw.images : {};
  const owner = isRecord(raw.owner) ? raw.owner : {};
  return {
    id: text(raw, "id"),
    nftAddress: text(raw, "nftAddress"),
    name: text(raw, "itemName"),
    category: optionalText(raw.category) ?? "",
    grade: optionalText(raw.grade) ?? "",
    gradingCompany: optionalText(raw.gradingCompany) ?? "",
    year: typeof raw.year === "number" ? raw.year : null,
    nftStandard: text(raw, "nftStandard"),
    insuredValueUsdc: parseUsdc(raw.insuredValue),
    ownerWallet: optionalText(owner.wallet),
    listing: parseListing(raw.listing),
    frontImage: optionalText(images.frontM) ?? optionalText(raw.frontImage),
    backImage: optionalText(images.backM) ?? optionalText(raw.backImage),
    certNumber: optionalText(raw.gradingID),
    set: optionalText(raw.set),
    serial: optionalText(raw.serial),
    vault: optionalText(raw.vault),
    subject: optionalText(raw.gemrateCardName),
    population: parsePopulation(raw.population),
  };
}

export const isVaultable = (card: CollectorCard): boolean =>
  card.nftStandard === "core" && card.insuredValueUsdc > 0n;

export function impliedFractionPrice(card: CollectorCard): bigint | null {
  if (!card.listing || card.listing.currency !== "USDC" || card.insuredValueUsdc <= 0n) return null;
  return (card.listing.priceUsdc * WAD) / card.insuredValueUsdc;
}

/**
 * The weighted median: the price at which half the weight sits below. Equal
 * weights give `medianWad`; at an exact half it is the midpoint, as there.
 */
export function weightedMedianWad(samples: readonly { price: bigint; weight: bigint }[]): bigint | null {
  const xs = samples.filter((s) => s.weight > 0n).sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
  const total = xs.reduce((t, s) => t + s.weight, 0n);
  if (total === 0n) return null;
  let below = 0n;
  for (let i = 0; i < xs.length; i += 1) {
    below += xs[i]!.weight;
    if (below * 2n > total) return xs[i]!.price;
    if (below * 2n === total) return (xs[i]!.price + xs[i + 1]!.price) / 2n;
  }
  return xs[xs.length - 1]!.price;
}

export function medianWad(values: bigint[]): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2n;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(path: string, opts: ClientOptions): Promise<unknown> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const apiKey = opts.apiKey ?? apiKeyFromEnv();
  const { cache, budget, retries = 0 } = opts.limits ?? {};
  const load = async (): Promise<unknown> => {
    for (let attempt = 0; ; attempt += 1) {
      await budget?.take();
      const res = await doFetch(`${opts.baseUrl ?? COLLECTOR_CRYPT_API}${path}`, {
        headers: {
          accept: "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
      });
      if ((res.status === 429 || res.status === 503) && attempt < retries) {
        const after = Number(res.headers?.get?.("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1_000 : 1_000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`Collector Crypt ${path} answered ${res.status}`);
      return res.json();
    }
  };
  return cache ? cache.get(`${apiKey ? "key" : "anon"} ${path}`, load) : load();
}

export interface MarketplaceFilter {
  search?: string;
  ownerAddress?: string;
  step?: number;
  orderBy?: OrderBy;
  listPriceMin?: number;
  listPriceMax?: number;
  marketplaceSource?: MarketplaceSource;
}

export const ORDER_BY = [
  "listedDateDesc", "listedDateAsc", "listedPriceAsc", "listedPriceDesc",
  "nameAsc", "nameDesc", "yearAsc", "yearDesc", "dateAsc", "dateDesc", "priceAsc", "priceDesc",
] as const;
export type OrderBy = (typeof ORDER_BY)[number];
export const isOrderBy = (v: unknown): v is OrderBy => (ORDER_BY as readonly unknown[]).includes(v);

export const MARKETPLACE_SOURCES = ["CC", "ME"] as const;
export type MarketplaceSource = (typeof MARKETPLACE_SOURCES)[number];
export const isMarketplaceSource = (v: unknown): v is MarketplaceSource =>
  (MARKETPLACE_SOURCES as readonly unknown[]).includes(v);

export const CATEGORY_GROUPS = ["pokemon", "one-piece", "tcg", "sports", "other"] as const;
export type CategoryGroup = (typeof CATEGORY_GROUPS)[number];

export const isCategoryGroup = (v: unknown): v is CategoryGroup =>
  (CATEGORY_GROUPS as readonly unknown[]).includes(v);

const TCG = new Set([
  "riftbound", "dragon ball", "lorcana", "magic the gathering", "yu-gi-oh", "gundam", "union arena",
  "naruto", "trading card games", "collectible card game", "collectible card games",
]);
const SPORTS = new Set([
  "baseball", "basketball", "football", "soccer", "hockey", "golf", "boxing & mma", "wrestling",
  "sports", "misc sports", "multisport", "multi-sport",
]);

export function categoryGroup(category: string): CategoryGroup {
  const key = category.trim().toLowerCase().replace(/!+$/, "");
  if (key === "pokemon") return "pokemon";
  if (key === "one piece") return "one-piece";
  if (TCG.has(key)) return "tcg";
  if (SPORTS.has(key)) return "sports";
  return "other";
}

export function groupCounts(byCategory: Record<string, number>): Record<CategoryGroup, number> {
  const out: Record<CategoryGroup, number> = { pokemon: 0, "one-piece": 0, tcg: 0, sports: 0, other: 0 };
  for (const [category, n] of Object.entries(byCategory)) out[categoryGroup(category)] += n;
  return out;
}

export async function fetchMarketplacePage(
  cursor: string | null = null,
  opts: ClientOptions = {},
  filter: MarketplaceFilter = {},
): Promise<MarketplacePage> {
  const params = new URLSearchParams();
  if (filter.search) params.set("search", filter.search);
  if (filter.ownerAddress) params.set("ownerAddress", filter.ownerAddress);
  if (filter.step) params.set("step", String(filter.step));
  if (filter.orderBy) params.set("orderBy", filter.orderBy);
  if (filter.listPriceMin !== undefined) params.set("listPriceMin", String(filter.listPriceMin));
  if (filter.listPriceMax !== undefined) params.set("listPriceMax", String(filter.listPriceMax));
  if (filter.marketplaceSource) params.set("marketplaceSource", filter.marketplaceSource);
  if (cursor) params.set("cursor", cursor);
  const query = params.size > 0 ? `?${params}` : "";
  const body = await getJson(`/marketplace${query}`, opts);
  if (!isRecord(body) || !Array.isArray(body.filterNFtCard)) {
    throw new Error("Collector Crypt /marketplace changed shape: filterNFtCard is missing");
  }
  const cards: CollectorCard[] = [];
  const rejected: MarketplacePage["rejected"] = [];
  for (const item of body.filterNFtCard) {
    try {
      cards.push(parseCard(item));
    } catch (e) {
      rejected.push({
        id: isRecord(item) && typeof item.id === "string" ? item.id : "?",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const categoryCounts: Record<string, number> = {};
  if (isRecord(body.cardsQtyByCategory)) {
    for (const [category, n] of Object.entries(body.cardsQtyByCategory)) {
      if (typeof n === "number") categoryCounts[category] = n;
    }
  }
  return {
    cards,
    rejected,
    nextCursor: optionalText(body.nextCursor),
    total: typeof body.total === "number" ? body.total : cards.length,
    categoryCounts,
  };
}

/**
 * A card's current appraisal alone: one request, and it keeps answering after
 * the card is vaulted, when it can no longer be listed.
 */
export async function fetchAppraisal(nftAddress: string, opts: ClientOptions = {}): Promise<bigint> {
  const raw = await getJson(`/cards/publicNft/${encodeURIComponent(nftAddress)}`, opts);
  if (!isRecord(raw)) throw new Error(`Collector Crypt has no card ${nftAddress}`);
  return parseUsdc(raw.insuredValue);
}

export async function fetchCard(nftAddress: string, opts: ClientOptions = {}): Promise<CollectorCard> {
  const path = `/cards/publicNft/${encodeURIComponent(nftAddress)}`;
  const [card, market] = await Promise.all([getJson(path, opts), getJson(`${path}/market`, opts)]);
  if (!isRecord(card)) throw new Error(`Collector Crypt has no card ${nftAddress}`);
  const m = isRecord(market) ? market : {};
  return parseCard({ ...card, owner: m.owner, listing: m.listing });
}

/**
 * One card with its appraisal and its active listing, in one request: a
 * marketplace search by mint is an exact match and carries both. `null` when
 * the card is not listed, which is also when it has no price for the median.
 */
export async function fetchListing(nftAddress: string, opts: ClientOptions = {}): Promise<CollectorCard | null> {
  const page = await fetchMarketplacePage(null, opts, { search: nftAddress });
  return page.cards.find((c) => c.nftAddress === nftAddress) ?? null;
}

export * from "./gacha.js";
export * from "./limits.js";
