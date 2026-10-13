import { NextResponse } from "next/server";
import type { Connection, PublicKey } from "@solana/web3.js";
import { decodePool, findPool, priceEventsFromLogs, signaturesByBucket, toSeries, type PriceRefreshed } from "@kadex/sdk";
import { CLUSTER } from "@/lib/cluster";
import { HISTORY_POINTS, HISTORY_STEP_SECS, type IndexHistoryWire } from "@/lib/history";

/**
 * The index chart's series, from the oracle's `PriceRefreshed` events.
 *
 * Server side so every browser does not walk the RPC itself. A public RPC
 * answers about ten `getTransaction` calls per ten seconds, so each refresh
 * reads a few buckets, newest first, and a failed read serves what is known.
 */

export const dynamic = "force-dynamic";

const WINDOW_SECS = HISTORY_POINTS * HISTORY_STEP_SECS;
const FRESH_MS = 30_000;
const FILLING_MS = 12_000;
const RETRY_MS = 60_000;
const TRANSACTIONS_PER_REFRESH = 6;
const PAGE = 1_000;

interface State {
  oracle: PublicKey;
  events: Map<number, PriceRefreshed>;
  unread: Map<number, string[]>;
  newest: string | null;
  olderFrom: string | null;
  at: number;
}

let state: State | null = null;
let inflight: Promise<void> | null = null;
let failedAt = 0;

const bucketOf = (ts: number) => Math.floor(ts / HISTORY_STEP_SECS) * HISTORY_STEP_SECS;

async function queuePage(connection: Connection, held: State, from: number, options: { before?: string; until?: string }) {
  const batch = await connection.getSignaturesForAddress(held.oracle, { ...options, limit: PAGE }, "confirmed");
  for (const [bucket, signatures] of signaturesByBucket(batch, HISTORY_STEP_SECS, from)) {
    // A page that continues an older one must not replace the newer signatures already queued for the bucket.
    if (options.before && (held.unread.has(bucket) || held.events.has(bucket))) continue;
    held.unread.set(bucket, signatures);
  }
  const oldest = batch.at(-1);
  return { newest: batch[0]?.signature ?? null, older: batch.length === PAGE && oldest && (oldest.blockTime ?? 0) >= from ? oldest.signature : null };
}

async function refresh(): Promise<void> {
  const { connection, usdcMint } = CLUSTER!;
  const now = Math.floor(Date.now() / 1000);
  const from = now - WINDOW_SECS;

  if (!state) {
    const poolInfo = await connection.getAccountInfo(findPool(usdcMint));
    if (!poolInfo) throw new Error("No pool on this cluster.");
    const fresh: State = { oracle: decodePool(poolInfo.data).oracle, events: new Map(), unread: new Map(), newest: null, olderFrom: null, at: 0 };
    const page = await queuePage(connection, fresh, from, {});
    fresh.newest = page.newest;
    fresh.olderFrom = page.older;
    state = fresh;
  } else {
    const page = await queuePage(connection, state, from, { until: state.newest ?? undefined });
    state.newest = page.newest ?? state.newest;
    // More than a page arrived since the last read: walk down from it so the hours in between are not skipped.
    if (page.older) state.olderFrom = page.older;
    else if (state.olderFrom) state.olderFrom = (await queuePage(connection, state, from, { before: state.olderFrom })).older;
  }

  const held = state;
  let budget = TRANSACTIONS_PER_REFRESH;
  for (const bucket of [...held.unread.keys()].sort((a, b) => b - a)) {
    if (budget === 0) break;
    let settled = true;
    for (const signature of held.unread.get(bucket)!) {
      if (budget === 0) {
        settled = false;
        break;
      }
      budget -= 1;
      const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const event = priceEventsFromLogs(tx?.meta?.logMessages ?? [], held.oracle).at(-1);
      if (event) {
        held.events.set(bucket, event);
        break;
      }
    }
    if (settled) held.unread.delete(bucket);
  }
  for (const bucket of held.events.keys()) if (bucket < bucketOf(from)) held.events.delete(bucket);
  for (const bucket of held.unread.keys()) if (bucket < bucketOf(from)) held.unread.delete(bucket);
  held.at = Date.now();
}

export async function GET() {
  if (!CLUSTER) return NextResponse.json({ error: "No cluster configured." }, { status: 404 });
  const filling = !!state && (state.unread.size > 0 || state.olderFrom !== null);
  const stale = !state || Date.now() - state.at > (filling ? FILLING_MS : FRESH_MS);
  if (stale && Date.now() - failedAt > RETRY_MS) {
    inflight ??= refresh().finally(() => (inflight = null));
    try {
      await inflight;
    } catch (e) {
      failedAt = Date.now();
      console.error("Index history request failed:", e);
    }
  }
  if (!state) return NextResponse.json({ error: "Could not load index history." }, { status: 502 });
  const now = Math.floor(Date.now() / 1000);
  const body: IndexHistoryWire = {
    step: HISTORY_STEP_SECS,
    points: toSeries([...state.events.values()], HISTORY_STEP_SECS, now - WINDOW_SECS, now).map((p) => ({ ts: p.ts, price: p.price.toString() })),
  };
  return NextResponse.json(body);
}
