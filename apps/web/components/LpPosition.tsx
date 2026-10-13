"use client";

import { useEffect, useRef, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import { lpReturn, readLpEvents, readUtilisation, type LpEvent, type UtilisationPoint } from "@kadex/sdk";
import { CLUSTER, USD_LABEL } from "@/lib/cluster";
import type { IndexHistoryWire } from "@/lib/history";
import { fmtPct, fmtUsd, quoteWithdraw, type Balances, type MarketSnapshot } from "@/lib/market";

// A public RPC answers about ten getTransaction calls per ten seconds, and both readers below spend from that.
const LP_TRANSACTIONS = 5;
const MARKET_TRANSACTIONS = 3;
const SETTLE_MS = 2_500;
const RETRY_MS = 11_000;
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const sharesOf = (events: readonly LpEvent[]) => events.reduce((sum, e) => sum + (e.kind === "deposit" ? e.shares : -e.shares), 0n);
const day = (ts: number) => new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** Utilisation through time as a line, with the current value at the end. */
function Trend({ points, now }: { points: UtilisationPoint[]; now: bigint }) {
  const values = [...points.filter((p) => p.utilization !== null).map((p) => Number(p.utilization) / 1e6), Number(now) / 1e6];
  if (values.length < 2) return <p className="sub">Not enough positions yet to draw a trend.</p>;
  const max = Math.max(...values, 0.0001);
  const w = 240;
  const h = 48;
  const d = values.map((v, i) => `${i === 0 ? "M" : "L"}${((i / (values.length - 1)) * w).toFixed(1)} ${(h - (v / max) * (h - 4) - 2).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label={`Utilisation over the last ${values.length - 1} position events`}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * An LP's position: what the CLP held returns from each sleeve now, the
 * return since the first deposit (from the wallet's own Deposited /
 * Withdrawn events), and utilisation through time (from the market's
 * position events). Renders nothing without a wallet, a cluster and shares.
 */
export function LpPosition({ data, balances, wallet }: { data: MarketSnapshot | null; balances: Balances | null; wallet: PublicKey | null }) {
  const [events, setEvents] = useState<LpEvent[] | null>(null);
  const [trend, setTrend] = useState<UtilisationPoint[]>([]);
  const [history, setHistory] = useState<IndexHistoryWire["points"]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const lastRead = useRef<bigint | null>(null);

  const pool = data?.pool.address.toBase58() ?? null;
  const market = data?.market.address.toBase58() ?? null;
  const held = balances?.clp ?? 0n;
  const holds = held > 0n;
  useEffect(() => {
    let live = true;
    if (!CLUSTER || !data || !holds) return;
    Promise.all([
      readUtilisation(CLUSTER.connection, data.market.address, MARKET_TRANSACTIONS),
      fetch("/api/index-history").then((r) => {
        if (!r.ok) throw new Error("Could not read the index history.");
        return r.json() as Promise<IndexHistoryWire>;
      }),
    ])
      .then(([t, h]) => {
        if (!live) return;
        setTrend(t);
        setHistory(h.points);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, market, holds]);

  useEffect(() => {
    let live = true;
    const connection = CLUSTER?.connection;
    if (!connection || !wallet || !data || !holds) return;
    setError(null);
    setReading(true);
    // A deposit or exit that just confirmed takes a moment to reach the wallet's history.
    const moved = lastRead.current !== null && lastRead.current !== held;
    lastRead.current = held;
    const read = async () => {
      if (moved) await pause(SETTLE_MS);
      for (const wait of [0, RETRY_MS]) {
        if (wait) await pause(wait);
        if (!live) return;
        const found = await readLpEvents(connection, data.pool.address, wallet, LP_TRANSACTIONS);
        if (!live) return;
        setEvents(found);
        if (sharesOf(found) === held) return;
      }
    };
    read()
      .catch(() => live && setError("Could not read your pool history right now."))
      .finally(() => live && setReading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, wallet?.toBase58(), held]);

  if (!CLUSTER || !wallet || !data || !balances) return null;
  if (balances.clp === 0n && (events?.length ?? 0) === 0) return null;

  const quote = quoteWithdraw(data, balances.clp);
  // A fraction deposit's event carries no price: take the last index price at
  // or before it from the 24h history, or the current one, and say it is close.
  const priceAt = (ts: number) => {
    const before = history.filter((p) => p.ts <= ts).at(-1);
    return { price: before ? BigInt(before.price) : data.oracle.price, exact: false };
  };
  const reconciled = events !== null && sharesOf(events) === balances.clp;
  const r = events && reconciled ? lpReturn(events, quote.totalValue, priceAt) : null;
  const hasFractionDeposit = events?.some((e) => e.kind === "deposit" && e.fractions > 0n) ?? false;
  const gain = r ? r.return >= 0n : true;

  return (
    <section className="panel" aria-labelledby="lp-h">
      <h2 className="title sm" id="lp-h">Your position</h2>
      {error && <p className="hint bad" role="alert">{error}</p>}
      <div className="spec">
        <div><span>Shares held</span><b>{fmtUsd(balances.clp, 2)} CLP</b></div>
        <div><span>Worth now, at the withdrawal price</span><b>${fmtUsd(quote.totalValue, 2)}</b></div>
        <div><span>A full withdrawal returns</span><b>{fmtUsd(quote.usdc, 2)} {USD_LABEL} + {fmtUsd(quote.fractions, 2)} fractions</b></div>
      </div>
      {r && (
        <div className="spec">
          <div><span>Return since {r.firstDepositTs ? day(r.firstDepositTs) : "your first deposit"}</span><b className={gain ? "up" : "down"}>{gain ? "+" : "−"}${fmtUsd(gain ? r.return : -r.return, 2)}</b></div>
          <div><span>You put in</span><b>${fmtUsd(r.contributed, 2)}</b></div>
          <div><span>You took out</span><b>${fmtUsd(r.withdrawn, 2)}</b></div>
        </div>
      )}
      {events && !reconciled && (
        <p className="fine">
          {reading
            ? "Updating your return…"
            : `Return is not shown: your last ${LP_TRANSACTIONS} transactions do not account for every share you hold.`}
        </p>
      )}
      <p className="fine">
        Return is fees and trader PnL together, net of the card-deposit haircut: both move the value of a share, so
        the pool cannot say which part was fees. It is read from your last {LP_TRANSACTIONS} transactions.
        {hasFractionDeposit && " Card deposits are valued at the index price nearest before them, so that part is approximate."}
      </p>
      <h3 className="kicker" style={{ marginTop: 12 }}>Utilisation · now {fmtPct(data.capacity.utilization, 1)}</h3>
      <Trend points={trend} now={data.capacity.utilization} />
      <p className="fine">At each position opened and closed, from the market&apos;s own events, then now.</p>
    </section>
  );
}
