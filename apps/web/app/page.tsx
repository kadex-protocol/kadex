"use client";

/**
 * Trade — the landing page.
 *
 * Opening the app lands you on the one thing it exists to do, the way a swap
 * screen does: the market on the left, the ticket on the right, and three
 * steps underneath for anyone who has not done this before.
 */

import Link from "next/link";
import { CONSTITUENTS, fmtBps, fmtPct, fmtPrice, fmtUsd } from "@/lib/market";
import { useMarket } from "@/lib/useMarket";
import { Shelf } from "@/components/Shelf";
import { Thumb } from "@/components/Slab";
import { TradeTicket } from "@/components/TradeTicket";

export default function TradePage() {
  const { data, loading, error } = useMarket();

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="display">Trade the Culture Index</h1>
        <p className="lede">
          One price for five graded collectibles. Go long if you think they rise, short if you
          think they fall — without buying a single card.
        </p>
      </header>

      <div className="layout">
        <div className="col">
          <section className="market-card">
            <div className="market-head">
              <div>
                <p className="kicker">SLAB Index / 001</p>
                <p className="price">{data ? fmtPrice(data.oracle.price) : "—"}</p>
                <p className="sub">
                  <span className="dot" style={{ background: data?.oracle.state === "ok" ? "var(--up)" : "var(--down)" }} />
                  Oracle {data?.oracle.state ?? "—"}
                </p>
              </div>
              <Link href="/index-methodology" className="link">How the index works →</Link>
            </div>
            <Shelf />
          </section>

          <div className="stats">
            <div className="stat">
              <p className="k">Open interest</p>
              <p className="v">{data ? fmtUsd(data.market.oiLong + data.market.oiShort) : "—"}</p>
              <p className="d">{data ? `${fmtUsd(data.market.oiLong)} long · ${fmtUsd(data.market.oiShort)} short` : "—"}</p>
            </div>
            <div className="stat">
              <p className="k">Capacity left</p>
              <p className="v">{data ? fmtUsd(data.capacity.free) : "—"}</p>
              <p className="d">USDC</p>
            </div>
            <div className="stat">
              <p className="k">Utilisation</p>
              <p className="v">{data ? fmtPct(data.capacity.utilization, 1) : "—"}</p>
              <p className="d">of the ceiling</p>
            </div>
          </div>

          <section className="panel">
            <div className="panel-head">
              <h2 className="title sm">What&rsquo;s in the index</h2>
              <span className="sub">{CONSTITUENTS.length} cards · fixed weights</span>
            </div>
            <ul className="weights">
              {CONSTITUENTS.map((c) => (
                <li key={c.id}>
                  <span className="asset">
                    <Thumb art={c.art} />
                    <span>
                      <span className="nm">{c.name}</span>
                      <span className="id">{c.year} · {c.series} · {c.grade}</span>
                    </span>
                  </span>
                  <span className="w">
                    <span className="bar"><i style={{ width: `${(c.weightBps / CONSTITUENTS[0]!.weightBps) * 100}%`, background: "var(--ember)" }} /></span>
                    <b>{fmtBps(c.weightBps)}</b>
                  </span>
                </li>
              ))}
            </ul>
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
          <TradeTicket snapshot={data} />
        )}
      </div>

      <section className="steps" aria-label="How it works">
        <div><span>1</span><h4>Connect a wallet</h4><p>Any Solana wallet. Margin is posted in USDC.</p></div>
        <div><span>2</span><h4>Pick a side and a size</h4><p>The ticket shows your entry and liquidation price before you sign.</p></div>
        <div><span>3</span><h4>Track it in Portfolio</h4><p>Open positions, PnL, your vaulted cards and pool shares live there.</p></div>
      </section>
    </div>
  );
}
