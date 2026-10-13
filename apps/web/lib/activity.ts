import type { Connection, PublicKey } from "@solana/web3.js";
import { lpEventsFromLogs, marketEventsFromLogs, utilisationSeries, type LpEvent, type UtilisationPoint } from "@kadex/sdk";

interface Logged {
  ts: number;
  order: number;
  logs: string[];
}

// A transaction never changes, and a public RPC answers about ten getTransaction calls per ten seconds: each one is fetched once.
const logged = new Map<string, Map<string, Logged>>();
let order = 0;

async function recentLogs(connection: Connection, address: PublicKey, limit: number): Promise<Logged[]> {
  const key = address.toBase58();
  const known = logged.get(key) ?? new Map<string, Logged>();
  logged.set(key, known);
  const listed = (await connection.getSignaturesForAddress(address, { limit }, "confirmed"))
    .filter((s) => s.err === null && s.blockTime != null)
    .reverse();
  const missing = listed.filter((s) => !known.has(s.signature));
  const txs = await Promise.all(
    missing.map((s) => connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })),
  );
  missing.forEach((s, i) => {
    const logs = txs[i]?.meta?.logMessages;
    if (logs) known.set(s.signature, { ts: s.blockTime!, order: (order += 1), logs });
  });
  return [...known.values()].sort((a, b) => a.ts - b.ts || a.order - b.order);
}

export async function walletLpEvents(connection: Connection, pool: PublicKey, wallet: PublicKey, limit: number): Promise<LpEvent[]> {
  return (await recentLogs(connection, wallet, limit)).flatMap((t) => lpEventsFromLogs(t.logs, pool, wallet, t.ts));
}

export async function marketUtilisation(connection: Connection, market: PublicKey, limit: number): Promise<UtilisationPoint[]> {
  return utilisationSeries((await recentLogs(connection, market, limit)).flatMap((t) => marketEventsFromLogs(t.logs, t.ts)));
}
