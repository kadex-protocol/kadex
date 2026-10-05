"use client";

import Link from "next/link";
import { CONSTITUENTS, fmtBps, fmtUsd, fmtPrice } from "@/lib/market";
import { useMarket } from "@/lib/useMarket";
import { Shelf } from "@/components/Shelf";
import { Thumb } from "@/components/Slab";

export default function Home() {
  const { data } = useMarket();

  return (
    <div className="page">
      <section className="hero">
        <div className="hero-note">
          Tokenized collectibles
          <br />
          on Solana
        </div>

        <div className="hero-copy">
          <p className="kicker">SLAB</p>
          <h1 className="display">
            The collector&rsquo;s
            <br />
            market.
          </h1>
          <p className="lede">
            Perpetual exposure to a curated index of tokenized collectibles.
          </p>
          <p style={{ marginTop: 26 }}>
            <Link href="/market" className="btn accent">
              Explore the index →
            </Link>
          </p>
        </div>

        <Shelf />
      </section>

      <section className="pillars">
        <div className="pillar">
          <h4>One index.</h4>
          <p>A curated basket of collectible assets.</p>
        </div>
        <div className="pillar">
          <h4>One market.</h4>
          <p>Long or short perpetual exposure.</p>
        </div>
        <div className="pillar">
          <h4>Onchain.</h4>
          <p>Built on Solana.</p>
        </div>
      </section>

      <section className="panel">
        <p className="kicker">SLAB Index / 001</p>
        <div className="panel-head" style={{ marginBottom: 24 }}>
          <h2 className="title">The Culture Index</h2>
          <Link href="/index-methodology" className="link">
            View index →
          </Link>
        </div>

        <div className="stats" style={{ border: "none", borderRadius: 0, background: "transparent" }}>
          <div className="stat" style={{ paddingLeft: 0 }}>
            <p className="k">Index value</p>
            <p className="v serif">{data ? fmtPrice(data.oracle.price) : "—"}</p>
          </div>
          <div className="stat">
            <p className="k">Open interest</p>
            <p className="v">{data ? fmtUsd(data.market.oiLong + data.market.oiShort) : "—"}</p>
          </div>
          <div className="stat">
            <p className="k">Constituents</p>
            <p className="v">{CONSTITUENTS.length}</p>
          </div>
          <div className="stat" style={{ borderRight: "none" }}>
            <p className="k">Pool NAV</p>
            <p className="v">{data ? fmtUsd(data.poolStats.nav) : "—"}</p>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="title">Constituents</h2>
            <p className="sub">What the index holds, and at what weight.</p>
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
                        <span className="id">
                          {c.year} · SLAB-{c.id}
                        </span>
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
  );
}
