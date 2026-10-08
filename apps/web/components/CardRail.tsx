"use client";

import { useRef } from "react";
import Link from "next/link";
import { fmtUsd } from "@/lib/market";
import type { VaultCard } from "@/lib/collectorCrypt";
import { askOverAppraisal, titleParts } from "@/lib/cardText";
import { TiltSlab } from "@/components/TiltSlab";

export function CardRail({ cards }: { cards: VaultCard[] }) {
  const track = useRef<HTMLDivElement>(null);

  const scroll = (direction: 1 | -1) => {
    const el = track.current;
    el?.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: "smooth" });
  };

  return (
    <section className="panel hrail" aria-labelledby="rail-h">
      <div className="rail-head">
        <div className="t">
          <h2 className="title sm" id="rail-h">Vaultable cards</h2>
          <span className="sub">
            {cards.length > 0 ? `${cards.length} live from Collector Crypt · appraised value, ask vs appraisal` : "Loading from Collector Crypt…"}
          </span>
        </div>
        <div className="rail-nav">
          <button type="button" aria-label="Previous cards" onClick={() => scroll(-1)}>‹</button>
          <button type="button" aria-label="Next cards" onClick={() => scroll(1)}>›</button>
        </div>
      </div>

      <div className="rail-track" ref={track}>
        {cards.map((c) => {
          const premium = askOverAppraisal(c);
          return (
            <Link key={c.nftAddress} href={`/vault/${c.nftAddress}`} className="rcard">
              <TiltSlab src={c.frontImage} />
              <span className="cap">
                <span className="n">{titleParts(c).title}</span>
              </span>
              <span className="cap sub2" title={premium ? "Appraised value, and asking price against it" : "Appraised value"}>
                <b className="v">${fmtUsd(c.insuredValueUsdc)}</b>
                {premium && <b className={premium.startsWith("−") ? "down" : "up"}>ask {premium}</b>}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
