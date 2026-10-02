"use client";

import { CONSTITUENTS, fmtPct, fmtUsd } from "@/lib/market";
import { useMarket } from "@/lib/useMarket";
import { ConstituentTable } from "@/components/ConstituentTable";
import { Slab } from "@/components/Slab";

export default function IndexPage() {
  const { data, loading } = useMarket();

  return (
    <div className="columns">
      <main className="main-col">
        <p className="eyebrow">02 / Index</p>
        <h1 className="display">Composition &amp; methodology.</h1>
        <p className="standfirst">What the index holds, and the rules it holds it by.</p>

        <div className="slabs" style={{ marginTop: 26 }}>
          {CONSTITUENTS.slice(0, 3).map((c) => (
            <Slab key={c.id} item={c} />
          ))}
        </div>

        <ConstituentTable />

        <div className="prose" style={{ marginTop: 34 }}>
          <h3>Selection</h3>
          <p>
            Constituents are professionally graded, tokenized and held under custody. A card enters
            the basket by whitelist and keeps a fixed weight; the set does not rebalance on its own.
            A fixed basket is a security decision rather than a simplification — a basket whose
            membership can move is a basket an attacker can move into.
          </p>

          <h3>Pricing</h3>
          <p>
            The index price is the time-weighted average of an on-chain pool of card fractions,
            clamped so it cannot travel more than five per cent between readings. External sale
            data is consulted only as a sanity bound, never as the price itself. If that feed goes
            quiet the market loses one defence and keeps running.
          </p>

          <h3>Capacity</h3>
          <p>
            Open interest is limited by two independent ceilings, and the lower one always governs.
            One is the pool&rsquo;s liquid reserve, so a winning position is always paid from assets
            that can actually be paid out. The other is the depth of the pricing pool, so that
            moving the price far enough to force liquidations costs more than the liquidations
            would pay.
          </p>
        </div>
      </main>

      <div className="side-col">
        <aside className="ticket">
          <p className="eyebrow" style={{ margin: 0 }}>
            Index / 001
          </p>
          <div>
            <h2>Statistics</h2>
            <p className="subhead">Live composition</p>
          </div>

          {loading || !data ? (
            <p className="body">Reading index state&hellip;</p>
          ) : (
            <>
              <div className="readout">
                <div>
                  <span>Index price</span>
                  <b>{(Number(data.oracle.price) / 1e6).toFixed(4)}</b>
                </div>
                <div>
                  <span>Oracle state</span>
                  <b>{data.oracle.state}</b>
                </div>
                <div>
                  <span>Pool NAV</span>
                  <b>{fmtUsd(data.poolStats.nav)}</b>
                </div>
                <div>
                  <span>Card sleeve</span>
                  <b>{fmtPct(data.poolStats.cardSleeveShare, 1)}</b>
                </div>
                <div>
                  <span>USDC sleeve</span>
                  <b>{fmtPct(data.poolStats.usdcSleeveShare, 1)}</b>
                </div>
              </div>

              <hr className="rule" />

              <h3 className="section-title">Capacity</h3>
              <div className="readout">
                <div>
                  <span>Solvency ceiling</span>
                  <b>{fmtUsd(data.capacity.capSolvency)}</b>
                </div>
                <div>
                  <span>Depth ceiling</span>
                  <b>{fmtUsd(data.capacity.capDepth)}</b>
                </div>
                <div>
                  <span>Binding</span>
                  <b>{data.capacity.binding}</b>
                </div>
                <div>
                  <span>Utilisation</span>
                  <b>{fmtPct(data.capacity.utilization, 1)}</b>
                </div>
              </div>
            </>
          )}

          <p className="fineprint">
            Sample composition. Figures are computed by the production pricing library from
            placeholder account data.
          </p>
        </aside>
      </div>
    </div>
  );
}
