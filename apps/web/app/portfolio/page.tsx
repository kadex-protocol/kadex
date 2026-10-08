"use client";

/**
 * Portfolio.
 *
 * Serves role 1 (speculator, checking a position), role 2 (LP, the reason
 * anyone opens the app on day two) and role 3 (card owner, finding the card
 * they vaulted). One summary on top, one tab per kind of holding.
 *
 * With no wallet it says so. With a wallet and no positions it says that too —
 * which is the truthful state until the programs are deployed. Sample rows
 * appear only behind the preview flag in the chrome.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { CONSTITUENTS, fmtPrice, fmtUsd, loadPortfolio, type Portfolio } from "@/lib/market";
import { useWallet, shortKey } from "@/lib/wallet";
import { Slab, Thumb } from "@/components/Slab";

const card = (id: string) => CONSTITUENTS.find((c) => c.id === id) ?? CONSTITUENTS[0]!;
const signed = (x: bigint) => (x >= 0n ? "+" : "−") + fmtUsd(x < 0n ? -x : x, 2);

type Tab = "positions" | "cards" | "liquidity";

export default function PortfolioPage() {
  const { status, publicKey, connect } = useWallet();
  const [p, setP] = useState<Portfolio | null>(null);
  const [tab, setTab] = useState<Tab>("positions");

  useEffect(() => {
    setP(null);
    loadPortfolio(publicKey).then(setP);
  }, [publicKey]);

  const connected = status === "connected" && publicKey !== null;
  const denom = p && p.totalValue > 0n ? Number(p.totalValue) : 1;
  const longPct = p ? (Number(p.longNotional) / denom) * 100 : 0;
  const shortPct = p ? (Number(p.shortNotional) / denom) * 100 : 0;
  const cashPct = p ? (Number(p.cash) / denom) * 100 : 0;

  return (
    <div className="page wide">
      <header className="vmkt-head">
        <h1>
          Portfolio: <span>{connected ? shortKey(publicKey) : "your holdings"}</span>
        </h1>
        <p className="vmkt-total">
          Trading account <b>{connected && p ? `${fmtUsd(p.totalValue, 2)} $` : "—"}</b>
        </p>
      </header>

      {!connected ? (
        <div className="empty">
          <h3>Connect a wallet to see your portfolio</h3>
          <p>Positions, cards and pool shares are read from the chain against your address.</p>
          <button className="btn block" style={{ width: "auto", padding: "12px 28px" }} onClick={() => void connect()} disabled={status === "connecting"}>
            {status === "connecting" ? "Connecting…" : "Connect wallet"}
          </button>
        </div>
      ) : p === null ? (
        <div className="empty"><h3>Reading {shortKey(publicKey)}…</h3></div>
      ) : (
        <>
          <div className="stats">
            <div className="stat">
              <p className="k">Trading account</p>
              <p className="v lg">${fmtUsd(p.totalValue, 2)}</p>
              <p className="d">margin, cash and open PnL</p>
            </div>
            <div className="stat">
              <p className="k">Open PnL</p>
              <p className={`v lg ${p.totalPnl >= 0n ? "up" : "down"}`}>{signed(p.totalPnl)}</p>
              <p className="d">unrealised</p>
            </div>
            <div className="stat">
              <p className="k">Cards vaulted</p>
              <p className="v">{p.cards.length}</p>
              <p className="d">{fmtUsd(p.cards.reduce((a, c) => a + c.held, 0n))} fractions held</p>
            </div>
            <div className="stat">
              <p className="k">Pool shares</p>
              <p className="v">${fmtUsd(p.clpValue, 2)}</p>
              <p className="d">{fmtUsd(p.clp, 2)} CLP</p>
            </div>
          </div>

          <div className="tabs" role="tablist" aria-label="Portfolio sections">
            {([
              ["positions", "Positions", p.rows.length],
              ["cards", "My cards", p.cards.length],
              ["liquidity", "Liquidity", p.clp > 0n ? 1 : 0],
            ] as const).map(([id, label, n]) => (
              <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
                {label} <span className="count">{n}</span>
              </button>
            ))}
          </div>

          {tab === "positions" &&
            (p.rows.length === 0 ? (
              <div className="empty">
                <h3>No open positions</h3>
                <p>Go long or short on the index and it will show up here.</p>
                <Link href="/" className="btn accent">Trade the index →</Link>
              </div>
            ) : (
              <section className="panel">
                <div className="t-wrap">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Market</th>
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
                            <td><span className={`pill ${r.side}`}>{r.side}</span></td>
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

                <hr className="sep" style={{ margin: "20px 0" }} />
                <p className="kicker">Exposure</p>
                <div className="bar" style={{ marginBottom: 16 }}>
                  <i style={{ width: `${longPct}%`, background: "var(--up)" }} />
                  <i style={{ width: `${shortPct}%`, background: "var(--down)" }} />
                  <i style={{ width: `${cashPct}%`, background: "var(--mute-2)" }} />
                </div>
                <div className="legend row">
                  <div><span><span className="dot" style={{ background: "var(--up)" }} />Long</span><b>{longPct.toFixed(1)}%</b></div>
                  <div><span><span className="dot" style={{ background: "var(--down)" }} />Short</span><b>{shortPct.toFixed(1)}%</b></div>
                  <div><span><span className="dot" style={{ background: "var(--mute-2)" }} />Cash</span><b>{cashPct.toFixed(1)}%</b></div>
                </div>
              </section>
            ))}

          {tab === "cards" &&
            (p.cards.length === 0 ? (
              <div className="empty">
                <h3>No cards vaulted</h3>
                <p>Vault a graded card and it will appear here with its fractions.</p>
                <Link href="/vault" className="btn accent">Vault a card →</Link>
              </div>
            ) : (
              <div className="card-grid">
                {p.cards.map((h) => {
                  const c = card(h.constituentId);
                  const whole = h.held === h.minted;
                  return (
                    <section className="panel holding" key={h.constituentId}>
                      <Slab item={c} />
                      <div className="holding-body">
                        <div>
                          <p className="nm">{c.name}</p>
                          <p className="id">{c.year} · {c.grade}</p>
                        </div>
                        <div className="rows">
                          <div><span>Fractions minted</span><b>{fmtUsd(h.minted, 2)}</b></div>
                          <div><span>In your wallet</span><b>{fmtUsd(h.held, 2)}</b></div>
                          <div><span>In the pool</span><b>{fmtUsd(h.inPool, 2)}</b></div>
                        </div>
                        <p className={`hint${whole ? "" : " bad"}`} style={{ margin: 0 }}>
                          {whole
                            ? "You hold every fraction — the card can be redeemed."
                            : `Redeeming needs all ${fmtUsd(h.minted)}; ${fmtUsd(h.minted - h.held)} are elsewhere.`}
                        </p>
                        <div className="actions">
                          <Link href="/pool" className="btn">Deposit to earn</Link>
                          <button className="btn" disabled={!whole} title="Requires the programs to be deployed">Redeem card</button>
                        </div>
                      </div>
                    </section>
                  );
                })}
              </div>
            ))}

          {tab === "liquidity" &&
            (p.clp === 0n ? (
              <div className="empty">
                <h3>No pool shares</h3>
                <p>Deposit USDC or card fractions into the pool to earn trading fees.</p>
                <Link href="/pool" className="btn accent">Go to Earn →</Link>
              </div>
            ) : (
              <section className="panel">
                <div className="rows">
                  <div><span>CLP held</span><b>{fmtUsd(p.clp, 2)}</b></div>
                  <div className="hi"><span>Worth at current NAV</span><b>${fmtUsd(p.clpValue, 2)}</b></div>
                </div>
                <p className="hint">Withdrawing returns a proportional slice of USDC and card fractions.</p>
                <div className="actions" style={{ marginTop: 16 }}>
                  <Link href="/pool" className="btn">Deposit more</Link>
                  <Link href="/pool" className="btn">Withdraw</Link>
                </div>
              </section>
            ))}
        </>
      )}
    </div>
  );
}
