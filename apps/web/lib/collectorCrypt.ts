import type { CategoryGroup, CollectorCard, MarketplaceSource, OrderBy } from "@kadex/collector-crypt";
import { isVaultable } from "@kadex/collector-crypt";

export interface CardWire {
  nftAddress: string;
  name: string;
  category: string;
  grade: string;
  gradingCompany: string;
  year: number | null;
  nftStandard: string;
  insuredValueUsdc: string;
  askUsdc: string | null;
  ownerWallet: string | null;
  frontImage: string | null;
  backImage: string | null;
  certNumber: string | null;
  set: string | null;
  serial: string | null;
  vault: string | null;
  subject: string | null;
  population: CollectorCard["population"];
  vaultable: boolean;
}

export interface VaultCard extends Omit<CardWire, "insuredValueUsdc" | "askUsdc"> {
  insuredValueUsdc: bigint;
  askUsdc: bigint | null;
}

export interface MarketplaceWire {
  cards: CardWire[];
  nextCursor: string | null;
  total: number;
  returnedCount: number;
  groups: Record<CategoryGroup, number>;
}

export const toWire = (c: CollectorCard): CardWire => ({
  nftAddress: c.nftAddress,
  name: c.name,
  category: c.category,
  grade: c.grade,
  gradingCompany: c.gradingCompany,
  year: c.year,
  nftStandard: c.nftStandard,
  insuredValueUsdc: c.insuredValueUsdc.toString(),
  askUsdc: c.listing && c.listing.currency === "USDC" ? c.listing.priceUsdc.toString() : null,
  ownerWallet: c.ownerWallet,
  frontImage: c.frontImage,
  backImage: c.backImage,
  certNumber: c.certNumber,
  set: c.set,
  serial: c.serial,
  vault: c.vault,
  subject: c.subject,
  population: c.population,
  vaultable: isVaultable(c),
});

const fromWire = (c: CardWire): VaultCard => ({
  ...c,
  insuredValueUsdc: BigInt(c.insuredValueUsdc),
  askUsdc: c.askUsdc === null ? null : BigInt(c.askUsdc),
});

export const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || body === null) throw new Error(body?.error ?? `Request failed (${res.status}).`);
  return body;
}

export interface VaultCardFilter {
  search: string;
  owner: string | null;
  group: CategoryGroup | null;
  sort?: OrderBy | null;
  source?: MarketplaceSource | null;
  askMin?: string;
  askMax?: string;
}

export async function loadVaultCards(cursor: string | null, filter: VaultCardFilter) {
  const params = new URLSearchParams();
  if (filter.search) params.set("search", filter.search);
  if (filter.owner) params.set("owner", filter.owner);
  if (filter.group) params.set("group", filter.group);
  if (filter.sort) params.set("sort", filter.sort);
  if (filter.source) params.set("source", filter.source);
  if (filter.askMin) params.set("min", filter.askMin);
  if (filter.askMax) params.set("max", filter.askMax);
  if (cursor) params.set("cursor", cursor);
  const page = await getJson<MarketplaceWire>(`/api/collector-crypt/marketplace?${params}`);
  return { cards: page.cards.map(fromWire), nextCursor: page.nextCursor, total: page.total, returnedCount: page.returnedCount, groups: page.groups };
}

export async function loadVaultCard(nftAddress: string): Promise<VaultCard> {
  const { card } = await getJson<{ card: CardWire }>(`/api/collector-crypt/card/${nftAddress}`);
  return fromWire(card);
}
