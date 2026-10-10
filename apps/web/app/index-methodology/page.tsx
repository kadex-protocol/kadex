"use client";

import { CONSTITUENTS, fmtBps, fmtPct, fmtPrice, fmtUsd } from "@/lib/market";
import { useMarket } from "@/lib/useMarket";
import { Thumb } from "@/components/Slab";

export default function IndexPage() {
  const { data } = useMarket();

  return (
    <div className="page wide">
      <header className="vmkt-head">
        <h1>
          Index: <span>methodology</span>
        </h1>
        <p className="vmkt-total">
          Index value <b>{data ? fmtPrice(data.oracle.price) : "—"}</b>
        </p>
      </header>

      <div className="stats">
        <div className="stat">
          <p className="k">Index value</p>
          <p className="v lg">{data ? fmtPrice(data.oracle.price) : "—"}</p>
        </div>
        <div className="stat">
          <p className="k">Pool NAV</p>
          <p className="v">{data ? fmtUsd(data.poolStats.nav) : "—"}</p>
        </div>
        <div className="stat">
          <p className="k">Card sleeve</p>
          <p className="v">{data ? fmtPct(data.poolStats.cardSleeveShare, 1) : "—"}</p>
        </div>
        <div className="stat">
          <p className="k">Constituents</p>
          <p className="v">{CONSTITUENTS.length}</p>
        </div>
      </div>

      <div className="layout meth">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2 className="title">Composition</h2>
              <p className="sub">Fixed weights. The basket does not rebalance on its own.</p>
            </div>
          </div>
          <div className="t-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Constituent</th>
                  <th>Reference</th>
                  <th>Grade</th>
                  <th className="r">Weight</th>
                </tr>
              </thead>
              <tbody>
                {CONSTITUENTS.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span className="asset">
                        <Thumb src={c.image} />
                        <span>
                          <span className="nm">{c.name}</span>
                          <span className="id">{c.year} · {c.category}</span>
                        </span>
                      </span>
                    </td>
                    <td className="n">{c.ref}</td>
                    <td>{c.grade}</td>
                    <td className="r n">{fmtBps(c.weightBps)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2 className="title">Capacity</h2>
              <p className="sub">The lower ceiling is the real one.</p>
            </div>
          </div>
          <div className="rows">
            <div>
              <span>Solvency ceiling</span>
              <b>{data ? fmtUsd(data.capacity.capSolvency) : "—"}</b>
            </div>
            <div>
              <span>Depth ceiling</span>
              <b>{data ? fmtUsd(data.capacity.capDepth) : "—"}</b>
            </div>
            <div className="hi">
              <span>Binding</span>
              <b>{data?.capacity.binding ?? "—"}</b>
            </div>
            <div>
              <span>Open interest</span>
              <b>{data ? fmtUsd(data.capacity.oiTotal) : "—"}</b>
            </div>
            <div>
              <span>Utilisation</span>
              <b>{data ? fmtPct(data.capacity.utilization, 1) : "—"}</b>
            </div>
          </div>
          <hr className="sep" style={{ margin: "20px 0" }} />
          <p className="fine">
            Depth binds far before solvency. Adding USDC to the pool barely moves market size;
            adding liquidity to the pricing pool moves all of it.
          </p>
        </section>
      </div>

      <section className="panel prose">
        <h2 className="title">Methodology</h2>
        <div className="prose-cols">
          <div>
            <h3>Selection</h3>
            <p>
              Constituents are professionally graded, tokenized and held under custody. A card
              enters by whitelist and keeps a fixed weight. A fixed basket is a security decision
              rather than a simplification — a basket whose membership can move is a basket an
              attacker can move into.
            </p>
          </div>
          <div>
            <h3>Pricing</h3>
            <p>
              The index price is a time-weighted average of an on-chain pool of card fractions,
              clamped so it cannot travel more than five per cent between readings. External sale
              data is a sanity bound, never the price itself. If that feed goes quiet the market
              loses one defence and keeps running.
            </p>
          </div>
          <div>
            <h3>Capacity</h3>
            <p>
              Open interest is limited by two independent ceilings and the lower one always
              governs. One is the pool&rsquo;s liquid reserve, so a winning position is paid from
              assets that can actually be paid out. The other is the depth of the pricing pool, so
              that moving the price far enough to force liquidations <em>costs more than it pays</em>.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
