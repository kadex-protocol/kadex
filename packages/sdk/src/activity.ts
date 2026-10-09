/**
 * An LP's history and the market's utilisation, read back from the events
 * the programs already emit — no indexer, no program change.
 *
 * - `Deposited` / `Withdrawn` / `Redeemed` (clp-pool) give a wallet's
 *   contributions and exits, so its return since the first deposit.
 * - `PositionOpened` (perp) records open interest after the open and the cap
 *   it was checked against, so utilisation at that moment; `PositionClosed`
 *   and `PositionLiquidated` take that position's notional back out.
 *
 * An LP's fees cannot be told apart from trader PnL: both land in the NAV a
 * share is worth. So the number is "return", fees and trader PnL together,
 * and it is labelled as such wherever it is shown.
 */

import { PublicKey, type Connection } from "@solana/web3.js";
import { PROGRAM_IDS } from "@kadex/types";
import { isEvent, programData } from "./history.js";

const WAD = 1_000_000n;

export const ACTIVITY_DISCRIMINATORS = {
  deposited: [111, 141, 26, 45, 161, 35, 100, 57],
  withdrawn: [20, 89, 223, 198, 194, 124, 219, 13],
  redeemed: [14, 29, 183, 71, 31, 165, 107, 38],
  positionOpened: [237, 175, 243, 230, 147, 117, 101, 121],
  positionClosed: [157, 163, 227, 228, 13, 97, 138, 121],
  positionLiquidated: [40, 107, 90, 214, 96, 30, 61, 128],
} as const;

const SIZE = {
  deposited: 8 + 32 + 32 + 8 * 3,
  exit: 8 + 32 + 32 + 8 * 4,
  positionOpened: 8 + 32 + 32 + 1 + 8 * 6,
  positionClosed: 8 + 32 + 32 + 8 * 4,
  positionLiquidated: 8 + 32 * 3 + 8 * 4,
};

export type LpEvent =
  | { kind: "deposit"; ts: number; usdc: bigint; fractions: bigint; shares: bigint }
  | { kind: "withdraw" | "redeem"; ts: number; usdc: bigint; fractions: bigint; shares: bigint; price: bigint };

export type MarketEvent =
  | { kind: "open"; ts: number; position: PublicKey; notional: bigint; oiAfter: bigint; cap: bigint }
  | { kind: "close" | "liquidate"; ts: number; position: PublicKey };

const reader = (b: Uint8Array) => {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { key: (at: number) => new PublicKey(b.subarray(at, at + 32)), u64: (at: number) => v.getBigUint64(at, true) };
};

/** The wallet's own clp-pool events for `pool` in one transaction. */
export function lpEventsFromLogs(logs: readonly string[], pool: PublicKey, wallet: PublicKey, ts: number): LpEvent[] {
  const out: LpEvent[] = [];
  for (const b of programData(logs, PROGRAM_IDS.clpPool)) {
    const r = reader(b);
    if (isEvent(b, ACTIVITY_DISCRIMINATORS.deposited, SIZE.deposited)) {
      if (r.key(8).equals(pool) && r.key(40).equals(wallet)) {
        out.push({ kind: "deposit", ts, usdc: r.u64(72), fractions: r.u64(80), shares: r.u64(88) });
      }
    } else {
      const kind = isEvent(b, ACTIVITY_DISCRIMINATORS.withdrawn, SIZE.exit) ? "withdraw" : isEvent(b, ACTIVITY_DISCRIMINATORS.redeemed, SIZE.exit) ? "redeem" : null;
      if (kind && r.key(8).equals(pool) && r.key(40).equals(wallet)) {
        out.push({ kind, ts, shares: r.u64(72), usdc: r.u64(80), fractions: r.u64(88), price: r.u64(96) });
      }
    }
  }
  return out;
}

/** The market's position events in one transaction. */
export function marketEventsFromLogs(logs: readonly string[], ts: number): MarketEvent[] {
  const out: MarketEvent[] = [];
  for (const b of programData(logs, PROGRAM_IDS.perp)) {
    const r = reader(b);
    if (isEvent(b, ACTIVITY_DISCRIMINATORS.positionOpened, SIZE.positionOpened)) {
      // position 8, owner 40, side 72 (one byte), notional 73, margin 81,
      // entry 89, fee 97, oi_after 105, cap 113.
      out.push({ kind: "open", ts, position: r.key(8), notional: r.u64(73), oiAfter: r.u64(105), cap: r.u64(113) });
    } else if (isEvent(b, ACTIVITY_DISCRIMINATORS.positionClosed, SIZE.positionClosed)) {
      out.push({ kind: "close", ts, position: r.key(8) });
    } else if (isEvent(b, ACTIVITY_DISCRIMINATORS.positionLiquidated, SIZE.positionLiquidated)) {
      out.push({ kind: "liquidate", ts, position: r.key(8) });
    }
  }
  return out;
}

export interface LpReturn {
  /** USDC deposited, plus card fractions at the oracle price of the time. */
  contributed: bigint;
  /** USDC and fractions taken out, the fractions at the mark the exit used. */
  withdrawn: bigint;
  /** What the shares still held are worth now, at the redemption NAV. */
  valueNow: bigint;
  /** valueNow + withdrawn − contributed: fees and trader PnL together, net of haircuts. */
  return: bigint;
  firstDepositTs: number | null;
  /** True when a fraction deposit had to be priced from a nearby price, not the exact one. */
  approximate: boolean;
}

/**
 * Return since the first deposit. `priceAt(ts)` gives the oracle price (WAD)
 * a fraction deposit at `ts` is valued at, and whether it is exact; the
 * deposit event does not carry the price it used.
 */
export function lpReturn(events: readonly LpEvent[], valueNow: bigint, priceAt: (ts: number) => { price: bigint; exact: boolean }): LpReturn {
  let contributed = 0n;
  let withdrawn = 0n;
  let approximate = false;
  let first: number | null = null;
  for (const e of events) {
    if (e.kind === "deposit") {
      first = first === null ? e.ts : Math.min(first, e.ts);
      contributed += e.usdc;
      if (e.fractions > 0n) {
        const p = priceAt(e.ts);
        approximate ||= !p.exact;
        contributed += (e.fractions * p.price) / WAD;
      }
    } else {
      withdrawn += e.usdc + (e.fractions * e.price) / WAD;
    }
  }
  return { contributed, withdrawn, valueNow, return: valueNow + withdrawn - contributed, firstDepositTs: first, approximate };
}

export interface UtilisationPoint {
  ts: number;
  /** Total open interest, native USDC. */
  oi: bigint;
  /** WAD; null when no cap has been seen yet. */
  utilization: bigint | null;
}

/**
 * Open interest and utilisation through time, oldest first. Each open
 * reports the exact total after it and the cap it was checked against; a
 * close or liquidation subtracts that position's notional when its open is
 * in the window, and is skipped otherwise rather than guessed. Utilisation
 * after a close uses the last cap seen, which is the best known.
 */
export function utilisationSeries(events: readonly MarketEvent[]): UtilisationPoint[] {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const notional = new Map<string, bigint>();
  const points: UtilisationPoint[] = [];
  let oi: bigint | null = null;
  let cap: bigint | null = null;
  for (const e of sorted) {
    if (e.kind === "open") {
      notional.set(e.position.toBase58(), e.notional);
      oi = e.oiAfter;
      cap = e.cap > 0n ? e.cap : cap;
    } else {
      const n = notional.get(e.position.toBase58());
      if (n === undefined || oi === null) continue;
      notional.delete(e.position.toBase58());
      oi = oi > n ? oi - n : 0n;
    }
    points.push({ ts: e.ts, oi, utilization: cap ? (oi * WAD) / cap : null });
  }
  return points;
}

/**
 * The logs of an address's most recent successful transactions, OLDEST
 * first. Signatures arrive newest first, and block times only have second
 * resolution, so the order has to be fixed here: a stable sort by time would
 * otherwise put a close before its open when both land in the same second.
 */
async function recentLogs(connection: Connection, address: PublicKey, limit: number) {
  const sigs = (await connection.getSignaturesForAddress(address, { limit }, "confirmed"))
    .filter((s) => s.err === null && s.blockTime != null)
    .reverse();
  const out: { ts: number; logs: string[] }[] = [];
  for (let i = 0; i < sigs.length; i += 25) {
    const batch = sigs.slice(i, i + 25);
    const txs = await Promise.all(
      batch.map((s) => connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })),
    );
    txs.forEach((tx, j) => out.push({ ts: batch[j]!.blockTime!, logs: tx?.meta?.logMessages ?? [] }));
  }
  return out;
}

/** The wallet's deposits and exits on `pool`, from its last `limit` transactions. */
export async function readLpEvents(connection: Connection, pool: PublicKey, wallet: PublicKey, limit = 300): Promise<LpEvent[]> {
  const txs = await recentLogs(connection, wallet, limit);
  return txs.flatMap((t) => lpEventsFromLogs(t.logs, pool, wallet, t.ts)).sort((a, b) => a.ts - b.ts);
}

/** The market's last `limit` transactions, as a utilisation series. */
export async function readUtilisation(connection: Connection, market: PublicKey, limit = 300): Promise<UtilisationPoint[]> {
  const txs = await recentLogs(connection, market, limit);
  return utilisationSeries(txs.flatMap((t) => marketEventsFromLogs(t.logs, t.ts)));
}
