import { NextResponse } from "next/server";
import type { PublicKey } from "@solana/web3.js";
import { decodePool, findPool, readPriceHistory, toSeries, type PriceRefreshed } from "@kadex/sdk";
import { CLUSTER } from "@/lib/cluster";
import { HISTORY_POINTS, HISTORY_STEP_SECS, type IndexHistoryWire } from "@/lib/history";

/**
 * The index chart's series, from the oracle's `PriceRefreshed` events.
 *
 * Server side so every browser does not walk the RPC itself. The first call
 * reads the whole window; later ones read only signatures newer than the last
 * one seen, so a refresh costs a page of signatures and a few transactions.
 */

const WINDOW_SECS = HISTORY_POINTS * HISTORY_STEP_SECS;
const FRESH_MS = 30_000;

interface Cache {
  oracle: PublicKey;
  events: PriceRefreshed[];
  newest: string | null;
  at: number;
}

let cache: Cache | null = null;
let inflight: Promise<Cache> | null = null;

async function refresh(): Promise<Cache> {
  const cluster = CLUSTER!;
  const poolInfo = await cluster.connection.getAccountInfo(findPool(cluster.usdcMint));
  if (!poolInfo) throw new Error("No pool on this cluster.");
  const oracle = decodePool(poolInfo.data).oracle;

  const now = Math.floor(Date.now() / 1000);
  const from = now - WINDOW_SECS;
  const known = cache && cache.oracle.equals(oracle) ? cache : null;
  const read = await readPriceHistory(cluster.connection, oracle, {
    from,
    step: HISTORY_STEP_SECS,
    until: known?.newest ?? undefined,
  });
  const events = [...(known?.events ?? []), ...read.events].filter((e) => Number(e.ts) >= from - HISTORY_STEP_SECS);
  return { oracle, events, newest: read.newest ?? known?.newest ?? null, at: Date.now() };
}

export async function GET() {
  if (!CLUSTER) return NextResponse.json({ error: "No cluster configured." }, { status: 404 });
  try {
    if (!cache || Date.now() - cache.at > FRESH_MS) {
      inflight ??= refresh().finally(() => (inflight = null));
      cache = await inflight;
    }
    const now = Math.floor(Date.now() / 1000);
    const body: IndexHistoryWire = {
      step: HISTORY_STEP_SECS,
      points: toSeries(cache.events, HISTORY_STEP_SECS, now - WINDOW_SECS, now).map((p) => ({ ts: p.ts, price: p.price.toString() })),
    };
    return NextResponse.json(body);
  } catch (e) {
    console.error("Index history request failed:", e);
    return NextResponse.json({ error: "Could not load index history." }, { status: 502 });
  }
}
