"use client";

import type { CSSProperties, PointerEvent } from "react";
import Link from "next/link";
import { CONSTITUENTS, IS_SAMPLE } from "@/lib/market";
import { USD_LABEL } from "@/lib/cluster";
import type { VaultCard } from "@/lib/collectorCrypt";

interface Slot {
  x: number;
  y: number;
  w: number;
  ry: number;
  rz: number;
  depth: 0 | 1 | 2;
}

const SLOTS: Slot[] = [
  { x: 7, y: 34, w: 170, ry: 26, rz: -12, depth: 0 },
  { x: 86, y: 40, w: 180, ry: -28, rz: 11, depth: 0 },
  { x: 97, y: 96, w: 160, ry: -22, rz: -16, depth: 0 },
  { x: 20, y: 30, w: 105, ry: 18, rz: 7, depth: 1 },
  { x: 71, y: 24, w: 100, ry: -16, rz: -9, depth: 1 },
  { x: 15, y: 96, w: 115, ry: 24, rz: 18, depth: 1 },
  { x: 30, y: 8, w: 74, ry: 14, rz: -6, depth: 2 },
  { x: 62, y: 92, w: 80, ry: -12, rz: 10, depth: 2 },
  { x: 40, y: 98, w: 68, ry: 10, rz: -14, depth: 2 },
  { x: 99, y: 6, w: 84, ry: -20, rz: 20, depth: 2 },
];
const PARALLAX_PX = [22, 12, 5];

let pointerFrame = 0;

const trackPointer = (e: PointerEvent<HTMLElement>) => {
  const art = e.currentTarget.querySelector<HTMLElement>(".hbanner-art");
  const { clientX, clientY } = e;
  if (!art || pointerFrame) return;
  pointerFrame = requestAnimationFrame(() => {
    pointerFrame = 0;
    const box = art.getBoundingClientRect();
    art.style.setProperty("--px", (((clientX - box.left) / box.width) * 2 - 1).toFixed(3));
    art.style.setProperty("--py", (((clientY - box.top) / box.height) * 2 - 1).toFixed(3));
  });
};

function BannerArt({ cards }: { cards: VaultCard[] }) {
  const art = cards.filter((c) => c.frontImage);
  return (
    <div className="hbanner-art" aria-hidden="true">
      {art.length > 0 && SLOTS.map((slot, i) => (
        <span
          key={i}
          className={`hslab-slot d${slot.depth}`}
          style={{
            "--x": `${slot.x}%`,
            "--y": `${slot.y}%`,
            "--w": `${slot.w}px`,
            "--ry": `${slot.ry}deg`,
            "--rz": `${slot.rz}deg`,
            "--par": `${PARALLAX_PX[slot.depth]}px`,
          } as CSSProperties}
        >
          <span className="hslab">
            <img src={art[i % art.length]!.frontImage!} alt="" loading="lazy" />
            <i className="glare" />
          </span>
        </span>
      ))}
    </div>
  );
}

export const focusTicket = () => {
  const input = document.querySelector<HTMLInputElement>(".ticket input");
  const target = input ?? document.querySelector(".ticket") ?? document.querySelector(".chart");
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
  input?.focus({ preventScroll: true });
};

export function HomeBanner({ cards, marketAvailable }: { cards: VaultCard[]; marketAvailable: boolean }) {
  return (
    <section className="panel hbanner" aria-labelledby="hbanner-h" onPointerMove={trackPointer}>
      <BannerArt cards={cards} />

      <div className="hbanner-in">
        <p className="tags">
          <span>{IS_SAMPLE ? "Sample index" : "On-chain index"}</span>
          {IS_SAMPLE && <span className="hi">Preview</span>}
        </p>
        <h1 id="hbanner-h">Trading cards. Traded.</h1>
        <p>
          Go long or short on one index of {CONSTITUENTS.length} graded cards. No card required:
          margin in {USD_LABEL} on Solana.
        </p>
        <div className="actions">
          <button type="button" className="btn accent" onClick={focusTicket} disabled={!marketAvailable} title={!marketAvailable ? "Market unavailable" : undefined}>
            {marketAvailable ? "Start trading" : "Market unavailable"}
          </button>
          <Link href="/index-methodology" className="btn">See how it works</Link>
        </div>
      </div>
    </section>
  );
}

const scrollTo = (selector: string) => document.querySelector(selector)?.scrollIntoView({ block: "start", behavior: "smooth" });

export function VaultBanner({ cards }: { cards: VaultCard[] }) {
  return (
    <section className="panel hbanner" aria-labelledby="vbanner-h" onPointerMove={trackPointer}>
      <BannerArt cards={cards} />

      <div className="hbanner-in">
        <p className="tags">
          <span>Graded cards</span>
          {IS_SAMPLE && <span className="hi">Preview</span>}
        </p>
        <h1 id="vbanner-h">Your slab. Put to work.</h1>
        <p>
          Vault a graded card and receive fractions worth its appraised value. Deposit them to
          earn, and redeem the card when you hold them all.
        </p>
        <div className="actions">
          <button type="button" className="btn accent" onClick={() => scrollTo(".vmkt-bar")}>Browse cards</button>
          <button type="button" className="btn" onClick={() => scrollTo(".vmkt-faq")}>How vaulting works</button>
        </div>
      </div>
    </section>
  );
}
