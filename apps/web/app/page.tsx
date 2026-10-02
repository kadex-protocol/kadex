"use client";

import { CONSTITUENTS } from "@/lib/market";
import { useMarket } from "@/lib/useMarket";
import { Slab } from "@/components/Slab";
import { ConstituentTable } from "@/components/ConstituentTable";
import { TradeTicket } from "@/components/TradeTicket";

export default function MarketPage() {
  const { data, loading, error } = useMarket();

  return (
    <div className="columns">
      <main className="main-col">
        <p className="eyebrow">01 / Market</p>
        <h1 className="display">The collector&rsquo;s market.</h1>
        <p className="standfirst">Perpetual exposure to a collectible-card index.</p>

        <div className="slabs">
          {CONSTITUENTS.slice(0, 3).map((c) => (
            <Slab key={c.id} item={c} />
          ))}
        </div>

        <p className="slab-caption">
          The underlying collection
          <small>Illustrative artwork</small>
        </p>

        <ConstituentTable showWeights={false} />
      </main>

      <div className="side-col">
        {loading ? (
          <aside className="ticket">
            <p className="eyebrow" style={{ margin: 0 }}>Index / 001</p>
            <p className="body">Reading market state&hellip;</p>
          </aside>
        ) : error || !data ? (
          <aside className="ticket">
            <p className="eyebrow" style={{ margin: 0 }}>Index / 001</p>
            <h2>Unavailable</h2>
            <p className="body">{error ?? "Market state could not be read."}</p>
            <p className="fineprint">Trading is disabled until the market can be priced.</p>
          </aside>
        ) : (
          <TradeTicket snapshot={data} />
        )}
      </div>
    </div>
  );
}
