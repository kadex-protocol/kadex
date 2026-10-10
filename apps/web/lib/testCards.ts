import { CLUSTER } from "./cluster";

export interface TestCard {
  mainnet: string;
  asset: string;
  name: string;
}

let cached: Promise<TestCard[]> | null = null;

export function loadTestCards(): Promise<TestCard[]> {
  if (!CLUSTER || CLUSTER.network === "mainnet") return Promise.resolve([]);
  cached ??= fetch("/api/test-cards")
    .then((res) => (res.ok ? (res.json() as Promise<{ cards: TestCard[] }>) : { cards: [] }))
    .then((body) => body.cards)
    .catch(() => []);
  return cached;
}

export const twinOf = (cards: TestCard[], mainnet: string) => cards.find((c) => c.mainnet === mainnet)?.asset ?? null;

export const originalOf = (cards: TestCard[], asset: string) => cards.find((c) => c.asset === asset)?.mainnet ?? null;

export const clusterName = () => (CLUSTER?.network === "local" ? "a local validator" : CLUSTER?.network ?? "sample data");
