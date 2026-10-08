"use client";

import { BRAND } from "@/lib/brand";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  borrowSpread, fmtPct, fmtPrice, fmtUsd, IS_SAMPLE, loadIndexHistory, loadPortfolio, loadPositions,
  type IndexPoint, type Portfolio,
} from "@/lib/market";
import { useMarket } from "@/lib/useMarket";
import { useWallet } from "@/lib/wallet";
import type { PositionView } from "@slab/types";
import { CLUSTER } from "@/lib/cluster";
import { sendClosePosition } from "@/lib/tradeTx";
import { explainTxError } from "@/lib/tx";
import { loadVaultCards, type VaultCard } from "@/lib/collectorCrypt";
import { CardRail } from "@/components/CardRail";
import { focusTicket, HomeBanner } from "@/components/HomeBanner";
import { HowItWorks } from "@/components/HowItWorks";
import { IndexChart } from "@/components/IndexChart";
import { TradeTicket } from "@/components/TradeTicket";

const CARDS_SHOWN = 24;

type AccountTab = "positions" | "cards" | "shares";

const EMPTY: Record<AccountTab, string> = {
  positions: "No open positions. Pick a side and a size in the ticket.",
  cards: "No cards vaulted yet.",
  shares: "No pool shares yet.",
};

function accountLine(tab: AccountTab, p: Portfolio | null) {
  if (!p) return EMPTY[tab];
  if (tab === "positions" && p.rows.length > 0) {
    const pnl = p.totalPnl < 0n ? -p.totalPnl : p.totalPnl;
    return `${p.rows.length} open, ${p.totalPnl >= 0n ? "+" : "−"}${fmtUsd(pnl, 2)} USDC unrealised.`;
  }
  if (tab === "cards" && p.cards.length > 0) return `${p.cards.length} cards vaulted.`;
  if (tab === "shares" && p.clp > 0n) return `${fmtUsd(p.clp, 2)} CLP, worth ${fmtUsd(p.clpValue, 2)} USDC.`;
  return EMPTY[tab];
}

export default function HomePage() {
  const { data, loading, error, reload } = useMarket();
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [closing, setClosing] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const { status, publicKey, connect, signTransaction } = useWallet();
  const [history, setHistory] = useState<IndexPoint[]>([]);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [tab, setTab] = useState<AccountTab>("positions");
  const [cards, setCards] = useState<VaultCard[]>([]);

  useEffect(() => {
    let live = true;
    loadVaultCards(null, { search: "", owner: null, group: null })
      .then((page) => live && setCards(page.cards.slice(0, CARDS_SHOWN)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    loadPortfolio(publicKey).then((p) => live && setPortfolio(p));
    return () => {
      live = false;
    };
  }, [publicKey]);

  useEffect(() => {
    if (!data) return;
    let live = true;
    loadIndexHistory(data).then((points) => live && setHistory(points));
    return () => {
      live = false;
    };
  }, [data]);

  useEffect(() => {
    let live = true;
    loadPositions(publicKey, data).then((list) => live && setPositions(list)).catch(() => live && setPositions([]));
    return () => {
      live = false;
    };
  }, [publicKey, data]);

  const close = async (position: PositionView) => {
    if (!CLUSTER || !publicKey) return;
    setClosing(position.address.toBase58());
    setCloseError(null);
    try {
      await sendClosePosition(CLUSTER, publicKey, signTransaction, position.address);
      reload();
    } catch (e) {
      setCloseError(explainTxError(e));
    } finally {
      setClosing(null);
    }
  };

  const connected = status === "connected" && publicKey !== null;
  const openCount = IS_SAMPLE ? portfolio?.rows.length ?? 0 : positions.length;
  const spread = data ? borrowSpread(data) : null;
  const dayChange =
    history.length > 1
      ? (Number(history[history.length - 1]!.price - history[0]!.price) / Number(history[0]!.price)) * 100
      : null;
  const oracleOk = data?.oracle.state === "ok";

  return (
    <div className="page home">
      <div className="dash">
        <div className="col">
          <HomeBanner cards={cards} />

          <IndexChart
            points={history}
            head={
              <>
                <p className="chart-pair">
                  <span className="mark" aria-hidden="true"><span className="star" /></span>
                  {BRAND} Index <em>/ USD</em> <span className="lev">5x</span>
                </p>
                <p className="chart-px">
                  <b>{data ? fmtPrice(data.oracle.price) : "—"}</b>
                  {dayChange !== null && (
                    <span className={dayChange >= 0 ? "up" : "down"}>
                      {dayChange >= 0 ? "▲" : "▼"} {Math.abs(dayChange).toFixed(2)}% <em>24h</em>
                    </span>
                  )}
                </p>
                <p className={`chart-st ${data ? (oracleOk ? "up" : "down") : ""}`}>
                  <i /> Oracle {data?.oracle.state ?? "—"} · five graded cards
                </p>
              </>
            }
            stats={
              <dl className="chart-stats">
                <div><dt>TWAP</dt><dd>{data ? fmtPrice(data.oracle.twap) : "—"}</dd></div>
                <div><dt>Open interest</dt><dd>{data ? `${fmtUsd(data.market.oiLong + data.market.oiShort)} $` : "—"}</dd></div>
                <div><dt>Capacity left</dt><dd>{data ? `${fmtUsd(data.capacity.free)} $` : "—"}</dd></div>
                <div className="util">
                  <dt>Utilisation</dt>
                  <dd>
                    {data ? fmtPct(data.capacity.utilization, 1) : "—"}
                    <span className="meter"><i style={{ width: data ? fmtPct(data.capacity.utilization, 1) : "0%" }} /></span>
                  </dd>
                </div>
                <div>
                  <dt>Borrow / month</dt>
                  <dd>
                    {spread ? (
                      <>
                        <span className={spread.crowded === "long" ? "down" : "up"}>L {spread.longMonthly.toFixed(2)}%</span>
                        {" · "}
                        <span className={spread.crowded === "short" ? "down" : "up"}>S {spread.shortMonthly.toFixed(2)}%</span>
                      </>
                    ) : "—"}
                  </dd>
                </div>
              </dl>
            }
          />

          <CardRail cards={cards} />

          <section className="panel acct" aria-label="Your account">
            <div className="tabs" role="group" aria-label="Holdings">
              {([
                ["positions", "Positions", openCount],
                ["cards", "Vaulted cards", portfolio?.cards.length ?? 0],
                ["shares", "Pool shares", portfolio && portfolio.clp > 0n ? 1 : 0],
              ] as const).map(([id, label, n]) => (
                <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>
                  {label} ({n})
                </button>
              ))}
            </div>
            <div className="acct-body">
              {!connected ? (
                <button type="button" className="link" onClick={() => void connect()} disabled={status === "connecting"}>
                  {status === "connecting" ? "Connecting…" : "Connect a wallet to view open positions"}
                </button>
              ) : tab === "positions" && positions.length > 0 ? (
                <div className="t-wrap pos-table">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Side</th>
                        <th className="r">Size</th>
                        <th className="r">Entry</th>
                        <th className="r">Mark</th>
                        <th className="r">Liq. price</th>
                        <th className="r">PnL</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {positions.map((p) => {
                        const net = p.pnl - p.borrowOwed;
                        const key = p.address.toBase58();
                        return (
                          <tr key={key}>
                            <td><span className={`pill ${p.side}`}>{p.side}</span></td>
                            <td className="r n">${fmtUsd(p.notional, 2)}</td>
                            <td className="r n">{fmtPrice(p.entryPrice)}</td>
                            <td className="r n">{data ? fmtPrice(data.oracle.price) : "—"}</td>
                            <td className="r n">{fmtPrice(p.liquidationPrice)}</td>
                            <td className={`r n ${net >= 0n ? "up" : "down"}`}>{net >= 0n ? "+" : "−"}${fmtUsd(net >= 0n ? net : -net, 2)}</td>
                            <td className="r">
                              <button type="button" className="btn" disabled={closing !== null} onClick={() => void close(p)}>
                                {closing === key ? "Closing…" : "Close"}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {closeError && <p className="hint bad" role="alert">{closeError}</p>}
                </div>
              ) : (
                <>
                  <p className="sub">{accountLine(tab, portfolio)}</p>
                  <Link href="/portfolio" className="link">Open Portfolio →</Link>
                </>
              )}
            </div>
          </section>
        </div>

        {loading ? (
          <aside className="panel ticket"><p className="sub">Reading market state…</p></aside>
        ) : error || !data ? (
          <aside className="panel ticket">
            <h2 className="title sm">Market unavailable</h2>
            <p className="sub">{error ?? "Market state could not be read."}</p>
            <p className="fine">Trading is disabled until the market can be priced.</p>
          </aside>
        ) : (
          <TradeTicket snapshot={data} onOpened={reload} />
        )}
      </div>

      <HowItWorks cards={cards} data={data} onTrade={focusTicket} />

      <footer className="statusbar">
        <span>
          <i className={oracleOk ? "up" : "down"} /> Oracle {data?.oracle.state ?? "—"}
          <i className="up" /> Solana
          {IS_SAMPLE && <em>Preview · sample data</em>}
        </span>
        <span>
          <Link href="/index-methodology">Index methodology</Link>
          <Link href="/pool">Earn</Link>
          <Link href="/vault">Vault</Link>
        </span>
      </footer>
    </div>
  );
}
