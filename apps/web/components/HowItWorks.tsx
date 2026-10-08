"use client";

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { fmtPct, fmtPrice, fmtUsd, type MarketSnapshot } from "@/lib/market";
import type { VaultCard } from "@/lib/collectorCrypt";

const SPARK = "M0 58 L22 52 L44 55 L66 40 L88 44 L110 30 L132 35 L154 20 L176 25 L198 10 L220 15 L240 4";
const FRACTION_DOTS = 28;

function Bar({ label, value, share }: { label: string; value: string; share: string }) {
  return (
    <div className="hbar">
      <div>
        <span>{label}</span>
        <b>{value}</b>
      </div>
      <i><i style={{ width: share }} /></i>
    </div>
  );
}

function Tile({ art, children, title, body }: { art: string | null; children: ReactNode; title: string; body: string }) {
  return (
    <>
      <span className="hcard-bg" style={art ? ({ "--art": `url("${art}")` } as CSSProperties) : undefined} aria-hidden="true" />
      <div className="hglass">{children}</div>
      <div className="hcard-txt">
        <b>{title}</b>
        <span>{body}</span>
      </div>
    </>
  );
}

export function HowItWorks({ cards, data, onTrade }: { cards: VaultCard[]; data: MarketSnapshot | null; onTrade(): void }) {
  const art = cards.filter((c) => c.frontImage);
  const picture = (i: number) => (art.length ? art[i % art.length]!.frontImage : null);
  const slab = art.find((c) => c.vaultable) ?? art[0] ?? null;

  return (
    <section className="how" aria-labelledby="how-h">
      <header className="how-head">
        <h2 id="how-h"><em>Three</em> ways in</h2>
        <p>
          <b>One market for graded cards.</b>
          Trade the index, back the pool, or bring a slab of your own.
        </p>
        <Link href="/index-methodology" className="how-more">More about the index</Link>
      </header>

      <div className="how-cards">
        <button type="button" className="hcard" onClick={onTrade}>
          <Tile
            art={picture(0)}
            title="Trade the index"
            body="Go long or short on five graded cards at 5x, with USDC as margin."
          >
            <p className="hglass-k">{BRAND} Index · USD</p>
            <p className="hglass-v">{data ? fmtPrice(data.oracle.price) : "1.0000"}</p>
            <svg className="hspark" viewBox="0 0 240 64" preserveAspectRatio="none" aria-hidden="true">
              <path className="a" d={`${SPARK} L240 64 L0 64 Z`} />
              <path className="l" d={SPARK} />
            </svg>
            <div className="hsides">
              <span className="up">Long</span>
              <span className="down">Short</span>
            </div>
          </Tile>
        </button>

        <Link href="/pool" className="hcard">
          <Tile
            art={picture(3)}
            title="Earn as the house"
            body="Deposit into the pool and collect the fees every trade pays."
          >
            <p className="hglass-k">CLP pool</p>
            <div className="hglass-row">
              <span>Pool value</span>
              <b>{data ? `$${fmtUsd(data.poolStats.nav)}` : "—"}</b>
            </div>
            <Bar
              label="USDC"
              value={data ? fmtPct(data.poolStats.usdcSleeveShare, 1) : "—"}
              share={data ? fmtPct(data.poolStats.usdcSleeveShare, 1) : "0%"}
            />
            <Bar
              label="Card fractions"
              value={data ? fmtPct(data.poolStats.cardSleeveShare, 1) : "—"}
              share={data ? fmtPct(data.poolStats.cardSleeveShare, 1) : "0%"}
            />
            <Bar
              label="In use by traders"
              value={data ? fmtPct(data.capacity.utilization, 1) : "—"}
              share={data ? fmtPct(data.capacity.utilization, 1) : "0%"}
            />
          </Tile>
        </Link>

        <Link href="/vault" className="hcard">
          <Tile
            art={picture(6)}
            title="Put a slab to work"
            body="Vault a graded card for fractions worth its appraisal. Redeem it when you hold them all."
          >
            <p className="hglass-k">Your slab</p>
            <div className="hvault">
              {slab ? <img src={slab.frontImage!} alt="" loading="lazy" /> : <span className="hvault-blank" />}
              <div>
                <span>Appraised</span>
                <b>{slab ? `$${fmtUsd(slab.insuredValueUsdc, 2)}` : "—"}</b>
                <span>You receive</span>
                <b>{slab ? `${fmtUsd(slab.insuredValueUsdc, 2)} fractions` : "—"}</b>
              </div>
            </div>
            <div className="hdots" aria-hidden="true">
              {Array.from({ length: FRACTION_DOTS }, (_, i) => <i key={i} />)}
            </div>
          </Tile>
        </Link>
      </div>
    </section>
  );
}
