"use client";

/**
 * Portfolio.
 *
 * Serves role 1 (speculator, checking a position) and role 2 (LP, the reason
 * anyone opens the app on day two). Both were missing entirely.
 *
 * With no wallet it says so. With a wallet and no positions it says that too —
 * which is the truthful state until the programs are deployed. Sample rows
 * appear only behind the preview flag in the chrome.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { CONSTITUENTS, fmtPrice, fmtUsd, loadPortfolio, type Portfolio } from "@/lib/market";
import { useWallet, shortKey } from "@/lib/wallet";
import { Thumb } from "@/components/Slab";

const card = (id: string) => CONSTITUENTS.find((c) => c.id === id) ?? CONSTITUENTS[0]!;
const signed = (x: bigint) => (x >= 0n ? "+" : "−") + fmtUsd(x < 0n ? -x : x, 2);

export default function PortfolioPage() {
  const { status, publicKey, connect } = useWallet();
  const [p, setP] = useState<Portfolio | null>(null);

  useEffect(() => {
    setP(null);
    loadPortfolio(publicKey).then(setP);
  }, [publicKey]);

  const connected = status === "connected" && publicKey !== null;
  const exposure = p ? p.longNotional + p.shortNotional : 0n;
  const denom = p && p.totalValue > 0n ? Number(p.totalValue) : 1;
  const longPct = p ? (Number(p.longNotional) / denom) * 100 : 0;
  const shortPct = p ? (Number(p.shortNotional) / denom) * 100 : 0;
  const cashPct = p ? (Number(p.cash) / denom) * 100 : 0;

  return (
    <div className="page">
      <section className="hero" style={{ minHeight: 300, gridTemplateColumns: "minmax(0,1fr) minmax(0,.8fr)" }}>
        <div className="hero-copy">
          <p className="kicker">Portfolio</p>
          <h1 className="display">
            Your collection,
            <br />
            trades, and exposure.
          </h1>
          <p className="lede">
            Track your positions, follow your PnL and manage your exposure — all in one place.
          </p>
        </div>
        <div className="hero-art" style={{ display: "flex", justifyContent: "center" }}>
          <div style={{ width: 150 }}>
            <Thumb art="ascent" />
          </div>
        </div>
      </section>

      {!connected ? (
        <div className="empty">
          <h3>No wallet connected</h3>
          <p>Positions are read from the chain against your address.</p>
          <button className="btn accent" onClick={() => void connect()} disabled={status === "connecting"}>
            {status === "connecting" ? "Connecting…" : "Connect wallet"}
          </button>
        </div>
      ) : p === null ? (
        <div className="empty">
          <h3>Reading positions…</h3>
        </div>
      ) : p.rows.length === 0 ? (
        <div className="empty">
          <h3>Nothing open for {shortKey(publicKey)}</h3>
          <p>The programs are not deployed to this cluster yet, so there is nothing to read.</p>
          <Link href="/market" className="btn accent">
            Go to the market →
          </Link>
        </div>
      ) : (
        <>
          <div className="stats">
            <div className="stat">
              <p className="k">Total value</p>
              <p className="v serif">${fmtUsd(p.totalValue, 2)}</p>
              <p className="d">margin, cash and open PnL</p>
            </div>
            <div className="stat">
              <p className="k">Total PnL</p>
              <p className={`v serif ${p.totalPnl >= 0n ? "up" : "down"}`}>{signed(p.totalPnl)}</p>
              <p className="d">unrealised</p>
            </div>
            <div className="stat">
              <p className="k">Positions</p>
              <p className="v">{p.rows.length}</p>
              <p className="d">open</p>
            </div>
            <div className="stat">
              <p className="k">Exposure</p>
              <p className="v">{((Number(exposure) / denom) * 100).toFixed(1)}%</p>
              <p className="d">of portfolio value</p>
            </div>
          </div>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="title">Positions</h2>
                <p className="sub">Your open positions in the SLAB index.</p>
              </div>
            </div>
            <div className="t-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Side</th>
                    <th>Size</th>
                    <th className="r">Entry</th>
                    <th className="r">Mark</th>
                    <th className="r">PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {p.rows.map((r, i) => {
                    const c = card(r.constituentId);
                    return (
                      <tr key={i}>
                        <td>
                          <span className="asset">
                            <Thumb art={c.art} />
                            <span>
                              <span className="nm">{c.name}</span>
                              <span className="id">Index: SLAB-{c.id}</span>
                            </span>
                          </span>
                        </td>
                        <td>
                          <span className={`pill ${r.side}`}>{r.side}</span>
                        </td>
                        <td className="n">
                          {fmtUsd(r.notional, 2)}
                          <span className="id" style={{ display: "block" }}>{r.leverage}×</span>
                        </td>
                        <td className="r n">{fmtPrice(r.entryPrice)}</td>
                        <td className="r n">{fmtPrice(r.markPrice)}</td>
                        <td className={`r n ${r.pnl >= 0n ? "up" : "down"}`}>
                          {r.pnlPct >= 0 ? "+" : ""}
                          {r.pnlPct.toFixed(2)}%
                          <span style={{ display: "block", fontSize: 11 }}>{signed(r.pnl)}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="title">Exposure</h2>
                <p className="sub">How your value is currently allocated.</p>
              </div>
            </div>
            <div className="bar" style={{ marginBottom: 20 }}>
              <i style={{ width: `${longPct}%`, background: "var(--up)" }} />
              <i style={{ width: `${shortPct}%`, background: "var(--down)" }} />
              <i style={{ width: `${cashPct}%`, background: "var(--mute-2)" }} />
            </div>
            <div className="legend">
              <div>
                <span>
                  <span className="dot" style={{ background: "var(--up)" }} />
                  Long exposure
                </span>
                <b>{longPct.toFixed(1)}%</b>
              </div>
              <div>
                <span>
                  <span className="dot" style={{ background: "var(--down)" }} />
                  Short exposure
                </span>
                <b>{shortPct.toFixed(1)}%</b>
              </div>
              <div>
                <span>
                  <span className="dot" style={{ background: "var(--mute-2)" }} />
                  Cash
                </span>
                <b>{cashPct.toFixed(1)}%</b>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
