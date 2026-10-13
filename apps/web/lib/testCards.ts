import { CLUSTER } from "./cluster";

export interface TestCard {
  mainnet: string;
  asset: string;
  name: string;
  valueUsd: number;
}

export interface TestCardRecord {
  cards: TestCard[];
  recorded: boolean;
}

let cached: Promise<TestCardRecord> | null = null;
let cachedAt = 0;

export function loadTestCardRecord(): Promise<TestCardRecord> {
  if (!CLUSTER || CLUSTER.network === "mainnet") return Promise.resolve({ cards: [], recorded: false });
  if (cached && Date.now() - cachedAt < 30_000) return cached;
  cachedAt = Date.now();
  cached = fetch("/api/test-cards")
    .then((res) => {
      if (!res.ok) throw new Error("Could not read test cards.");
      return res.json() as Promise<TestCardRecord>;
    })
    .catch((error) => {
      cached = null;
      throw error;
    });
  return cached;
}

export function loadTestCards(): Promise<TestCard[]> {
  return loadTestCardRecord().then((record) => record.cards);
}

export const twinOf = (cards: TestCard[], mainnet: string) => cards.find((c) => c.mainnet === mainnet)?.asset ?? null;

export const originalOf = (cards: TestCard[], asset: string) => cards.find((c) => c.asset === asset)?.mainnet ?? null;

export const clusterName = () => (CLUSTER?.network === "local" ? "a local validator" : CLUSTER?.network ?? "sample data");
