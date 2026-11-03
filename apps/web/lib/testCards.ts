import { CLUSTER } from "./cluster";

export interface TestCard {
  mainnet: string;
  asset: string;
  name: string;
  valueUsd: number;
}

export interface TestCardRecord {
  cards: TestCard[];
  owned: string[];
  vaulted: string[];
  recorded: boolean;
}

export interface TestCardClaim {
  claimed: boolean;
  asset?: string;
  mainnet?: string;
  name?: string;
  signature?: string;
  error?: string;
}

const CACHE_MS = 30_000;
const NO_WALLET = "";

const cache = new Map<string, { at: number; record: Promise<TestCardRecord> }>();

export function invalidateTestCards() {
  cache.clear();
}

export function loadTestCardRecord(wallet: string | null = null): Promise<TestCardRecord> {
  if (!CLUSTER || CLUSTER.network === "mainnet") return Promise.resolve({ cards: [], owned: [], vaulted: [], recorded: false });
  const key = wallet ?? NO_WALLET;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.record;
  const record = fetch(wallet ? `/api/test-cards?wallet=${encodeURIComponent(wallet)}` : "/api/test-cards")
    .then((res) => {
      if (!res.ok) throw new Error("Could not read test cards.");
      return res.json() as Promise<TestCardRecord>;
    })
    .catch((error) => {
      cache.delete(key);
      throw error;
    });
  cache.set(key, { at: Date.now(), record });
  return record;
}

export async function claimTestCard(wallet: string): Promise<TestCardClaim> {
  try {
    const res = await fetch("/api/test-cards/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet }),
    });
    const reply = (await res.json()) as TestCardClaim;
    if (reply.claimed) invalidateTestCards();
    return reply;
  } catch {
    return { claimed: false, error: "Could not reach the server." };
  }
}

export const holdsTestCard = (record: TestCardRecord) => record.owned.length > 0 || record.vaulted.length > 0;

export function twinOf(record: TestCardRecord, mainnet: string) {
  const copies = record.cards.filter((c) => c.mainnet === mainnet);
  const mine = copies.find((c) => record.owned.includes(c.asset)) ?? copies.find((c) => record.vaulted.includes(c.asset));
  return (mine ?? copies[0])?.asset ?? null;
}

export const originalOf = (record: TestCardRecord, asset: string) => record.cards.find((c) => c.asset === asset)?.mainnet ?? null;

export const clusterName = () => (CLUSTER?.network === "local" ? "a local validator" : CLUSTER?.network ?? "sample data");
