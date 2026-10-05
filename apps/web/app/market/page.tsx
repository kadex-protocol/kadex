"use client";

import { CONSTITUENTS, fmtBps, fmtPct, fmtPrice, fmtUsd } from "@/lib/market";
import { useMarket } from "@/lib/useMarket";
import { Shelf } from "@/components/Shelf";
import { Thumb } from "@/components/Slab";
import { TradeTicket } from "@/components/TradeTicket";

export default function MarketPage() {
  const { data, loading, error } = useMarket();

  return (
    <div className="page">
      <div>
        <p className="kicker">01 / Market</p>
        <h1 className="display">Trade the index.</h1>
        <p className="lede">
          One basket, one market. Long or short, without owning a single card.
        </p>
      </div>

      <div className="stats">
        <div className="stat">
          <p className="k">Index price</p>
          <p className="v serif">{data ? fmtPrice(data.oracle.price) : "—"}</p>
          <p className="d">Oracle {data?.oracle.state ?? "—"}</p>
        </div>
        <div className="stat">
          <p className="k">Open interest</p>
          <p className="v">{data ? fmtUsd(data.market.oiLong + data.market.oiShort) : "—"}</p>
          <p className="d">
            {data ? `${fmtUsd(data.market.oiLong)} long · ${fmtUsd(data.market.oiShort)} short` : "—"}
          </p>
        </div>
        <div className="stat">
          <p className="k">Capacity left</p>
          <p className="v">{data ? fmtUsd(data.capacity.free) : "—"}</p>
          <p className="d">{data ? `${data.capacity.binding} binds` : "—"}</p>
        </div>
        <div className="stat">
          <p className="k">Utilisation</p>
          <p className="v">{data ? fmtPct(data.capacity.utilization, 1) : "—"}</p>
          <p className="d">of the ceiling</p>
        </div>
      </div>

      <div className="trade-layout">
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ background: "linear-gradient(118deg,#15110e,#0d0a08)", padding: "30px 24px 0" }}>
              <Shelf />
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="title">The underlying</h2>
                <p className="sub">
                  Graded, vaulted and fractionalised. Illustrative artwork.
                </p>
              </div>
            </div>
            <div className="t-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Category</th>
                    <th>Grade</th>
                    <th className="r">Weight</th>
                  </tr>
                </thead>
                <tbody>
                  {CONSTITUENTS.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <span className="asset">
                          <Thumb art={c.art} />
                          <span>
                            <span className="nm">{c.name}</span>
                            <span className="id">{c.year} · SLAB-{c.id}</span>
                          </span>
                        </span>
                      </td>
                      <td>{c.category}</td>
                      <td>{c.grade}</td>
                      <td className="r n">{fmtBps(c.weightBps)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        {loading ? (
          <aside className="panel ticket">
            <p className="sub">Reading market state…</p>
          </aside>
        ) : error || !data ? (
          <aside className="panel ticket">
            <h2 className="title">Unavailable</h2>
            <p className="sub">{error ?? "Market state could not be read."}</p>
            <p className="fine">Trading is disabled until the market can be priced.</p>
          </aside>
        ) : (
          <TradeTicket snapshot={data} />
        )}
      </div>
    </div>
  );
}
