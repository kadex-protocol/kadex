import { NextResponse } from "next/server";
import type { PublicKey } from "@solana/web3.js";
import { decodePool, findPool, readPriceHistory, toSeries, type PriceRefreshed } from "@kadex/sdk";
import { CLUSTER } from "@/lib/cluster";
import { HISTORY_POINTS, HISTORY_STEP_SECS, type IndexHistoryWire } from "@/lib/history";

/**
 * The index chart's series, from the oracle's `PriceRefreshed` events.
 *
 * Server side so every browser does not walk the RPC itself. The first call
 * reads the whole window at a coarse step; later ones read only signatures
 * newer than the last one seen, so a refresh costs a page of signatures and a
 * few transactions. A failed read keeps serving the last series.
 */

export const dynamic = "force-dynamic";

const WINDOW_SECS = HISTORY_POINTS * HISTORY_STEP_SECS;
const FRESH_MS = 30_000;
const RETRY_MS = 60_000;
// A public RPC allows about 40 getTransaction calls per 10 s, so one read never asks for more buckets than this.
const MAX_BUCKETS = 36;

interface Cache {
  oracle: PublicKey;
  events: PriceRefreshed[];
  newest: string | null;
  at: number;
}

let cache: Cache | null = null;
let inflight: Promise<Cache> | null = null;
let failedAt = 0;

async function refresh(): Promise<Cache> {
  const cluster = CLUSTER!;
  const poolInfo = await cluster.connection.getAccountInfo(findPool(cluster.usdcMint));
  if (!poolInfo) throw new Error("No pool on this cluster.");
  const oracle = decodePool(poolInfo.data).oracle;

  const now = Math.floor(Date.now() / 1000);
  const from = now - WINDOW_SECS;
  const known = cache && cache.oracle.equals(oracle) ? cache : null;
  const since = Math.max(from, Number(known?.events.at(-1)?.ts ?? from));
  const step = Math.max(HISTORY_STEP_SECS, Math.ceil((now - since) / MAX_BUCKETS / HISTORY_STEP_SECS) * HISTORY_STEP_SECS);
  const read = await readPriceHistory(cluster.connection, oracle, {
    from,
    step,
    until: known?.newest ?? undefined,
    concurrency: 4,
  });
  const events = [...(known?.events ?? []), ...read.events].filter((e) => Number(e.ts) >= from - HISTORY_STEP_SECS);
  return { oracle, events, newest: read.newest ?? known?.newest ?? null, at: Date.now() };
}

export async function GET() {
  if (!CLUSTER) return NextResponse.json({ error: "No cluster configured." }, { status: 404 });
  const stale = !cache || Date.now() - cache.at > FRESH_MS;
  if (stale && Date.now() - failedAt > RETRY_MS) {
    inflight ??= refresh().finally(() => (inflight = null));
    try {
      cache = await inflight;
    } catch (e) {
      failedAt = Date.now();
      console.error("Index history request failed:", e);
    }
  }
  if (!cache) return NextResponse.json({ error: "Could not load index history." }, { status: 502 });
  const now = Math.floor(Date.now() / 1000);
  const body: IndexHistoryWire = {
    step: HISTORY_STEP_SECS,
    points: toSeries(cache.events, HISTORY_STEP_SECS, now - WINDOW_SECS, now).map((p) => ({ ts: p.ts, price: p.price.toString() })),
  };
  return NextResponse.json(body);
}
