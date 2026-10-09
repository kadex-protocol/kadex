/**
 * Price history, read back from the chain.
 *
 * Nothing stores past prices in an account, and nothing needs to: every
 * `refresh_price` emits `PriceRefreshed` into its transaction's logs. The
 * history is those events, so reading it needs no indexer and no program
 * change — list the oracle's signatures, keep one per bucket, fetch only those.
 *
 * Any program can write a `Program data:` line, so an event is believed only
 * when it was logged while the oracle program itself was executing.
 */

import { PublicKey, type Connection, type ConfirmedSignatureInfo } from "@solana/web3.js";
import type { OracleState } from "@kadex/types";
import { PROGRAM_IDS } from "@kadex/types";

export const PRICE_REFRESHED_DISCRIMINATOR = [64, 39, 28, 72, 53, 221, 84, 139] as const;
export const PRICE_REFRESHED_SIZE = 8 + 32 + 8 * 4 + 1 + 8;

const ORACLE_STATES: OracleState[] = ["ok", "stale", "shallowDepth", "diverged", "uninitialized", "catchingUp"];

export interface PriceRefreshed {
  oracle: PublicKey;
  spot: bigint;
  twap: bigint;
  /** WAD, TWAP and clamp applied: the price positions settle at. */
  price: bigint;
  depthUsdc: bigint;
  state: OracleState;
  ts: bigint;
}

export interface PricePoint {
  /** Start of the bucket, unix seconds. */
  ts: number;
  price: bigint;
}

export function decodePriceRefreshed(data: Uint8Array): PriceRefreshed {
  if (data.length !== PRICE_REFRESHED_SIZE) {
    throw new Error(`PriceRefreshed is ${data.length} bytes, expected ${PRICE_REFRESHED_SIZE}: the event layout changed`);
  }
  if (PRICE_REFRESHED_DISCRIMINATOR.some((byte, i) => data[i] !== byte)) throw new Error("not a PriceRefreshed event");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u64 = (at: number) => view.getBigUint64(at, true);
  const state = ORACLE_STATES[data[72]!];
  if (!state) throw new Error(`unknown OracleState ${data[72]}`);
  return {
    oracle: new PublicKey(data.subarray(8, 40)),
    spot: u64(40),
    twap: u64(48),
    price: u64(56),
    depthUsdc: u64(64),
    state,
    ts: view.getBigInt64(73, true),
  };
}

const INVOKE = /^Program (\w+) invoke \[\d+\]$/;
const EXIT = /^Program (\w+) (success|failed)/;
const DATA = "Program data: ";

/**
 * Every `PriceRefreshed` for `oracle` in one transaction's logs, in order.
 *
 * Follows the invoke stack so a line counts only when the oracle program was
 * the one running. Lines that do not decode are skipped, never thrown on: a
 * transaction can carry other programs' events.
 */
export function priceEventsFromLogs(logs: readonly string[], oracle: PublicKey): PriceRefreshed[] {
  const stack: string[] = [];
  const oracleProgram = PROGRAM_IDS.oracle.toBase58();
  const events: PriceRefreshed[] = [];
  for (const line of logs) {
    const invoke = INVOKE.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    if (EXIT.test(line)) {
      stack.pop();
      continue;
    }
    if (!line.startsWith(DATA) || stack[stack.length - 1] !== oracleProgram) continue;
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(line.slice(DATA.length).trim()), (c) => c.charCodeAt(0));
    } catch {
      continue;
    }
    if (bytes.length !== PRICE_REFRESHED_SIZE) continue;
    if (PRICE_REFRESHED_DISCRIMINATOR.some((byte, i) => bytes[i] !== byte)) continue;
    const event = decodePriceRefreshed(bytes);
    if (event.oracle.equals(oracle)) events.push(event);
  }
  return events;
}

const bucketOf = (ts: number, step: number) => Math.floor(ts / step) * step;

/**
 * Candidates per bucket, newest first. A refresh that lands in a slot already
 * refreshed succeeds without emitting, so a bucket keeps a few to fall back on.
 */
export function signaturesByBucket(
  signatures: readonly Pick<ConfirmedSignatureInfo, "signature" | "blockTime" | "err">[],
  step: number,
  from: number,
  perBucket = 3,
): Map<number, string[]> {
  const buckets = new Map<number, string[]>();
  for (const s of signatures) {
    if (s.err !== null || s.blockTime == null || s.blockTime < from) continue;
    const key = bucketOf(s.blockTime, step);
    const list = buckets.get(key) ?? [];
    if (list.length < perBucket) list.push(s.signature);
    buckets.set(key, list);
  }
  return buckets;
}

/**
 * One point per bucket from `from` to `to`, the last price seen in each.
 * Buckets with no refresh carry the previous price forward — the oracle price
 * did not change, because nothing refreshed it. Leading buckets before the
 * first event are left out rather than invented.
 */
export function toSeries(events: readonly Pick<PriceRefreshed, "ts" | "price">[], step: number, from: number, to: number): PricePoint[] {
  const last = new Map<number, { ts: bigint; price: bigint }>();
  for (const e of events) {
    const key = bucketOf(Number(e.ts), step);
    const seen = last.get(key);
    if (!seen || e.ts >= seen.ts) last.set(key, e);
  }
  const points: PricePoint[] = [];
  let price: bigint | null = null;
  for (let ts = bucketOf(from, step); ts <= to; ts += step) {
    price = last.get(ts)?.price ?? price;
    if (price !== null) points.push({ ts, price });
  }
  return points;
}

export interface HistoryOptions {
  /** Unix seconds; signatures older than this are not read. */
  from: number;
  step: number;
  /** Stop paging at this signature (exclusive), to read only what is new. */
  until?: string;
  /** Upper bound on `getSignaturesForAddress` pages of 1,000. */
  maxPages?: number;
  /** Concurrent `getTransaction` calls. */
  concurrency?: number;
}

export interface HistoryRead {
  events: PriceRefreshed[];
  /** Newest signature seen, to pass back as `until` next time. */
  newest: string | null;
}

/** Read the oracle's `PriceRefreshed` events, at most one per bucket. */
export async function readPriceHistory(connection: Connection, oracle: PublicKey, opts: HistoryOptions): Promise<HistoryRead> {
  const signatures: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  for (let page = 0; page < (opts.maxPages ?? 40); page += 1) {
    const batch = await connection.getSignaturesForAddress(oracle, { before, until: opts.until, limit: 1000 }, "confirmed");
    signatures.push(...batch);
    const oldest = batch[batch.length - 1];
    if (batch.length < 1000 || !oldest || (oldest.blockTime ?? 0) < opts.from) break;
    before = oldest.signature;
  }

  const buckets = [...signaturesByBucket(signatures, opts.step, opts.from).values()];
  const events: PriceRefreshed[] = [];
  let next = 0;
  const worker = async () => {
    while (next < buckets.length) {
      const candidates = buckets[next++]!;
      for (const signature of candidates) {
        const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        const found = priceEventsFromLogs(tx?.meta?.logMessages ?? [], oracle);
        if (found.length > 0) {
          events.push(found[found.length - 1]!);
          break;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 8 }, worker));
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { events, newest: signatures[0]?.signature ?? null };
}
