"use client";

import { useEffect, useRef, type CSSProperties, type PointerEvent } from "react";
import Link from "next/link";
import { IS_SAMPLE } from "@/lib/market";
import type { VaultCard } from "@/lib/collectorCrypt";

interface Slot {
  x: number;
  y: number;
  w: number;
  rx: number;
  ry: number;
  rz: number;
  depth: 0 | 1 | 2;
}

const SLOTS: Slot[] = [
  { x: 7, y: 34, w: 170, rx: 8, ry: 26, rz: -12, depth: 0 },
  { x: 86, y: 40, w: 180, rx: 6, ry: -28, rz: 11, depth: 0 },
  { x: 97, y: 96, w: 160, rx: -10, ry: -22, rz: -16, depth: 0 },
  { x: 20, y: 30, w: 105, rx: 4, ry: 18, rz: 7, depth: 1 },
  { x: 71, y: 24, w: 100, rx: 10, ry: -16, rz: -9, depth: 1 },
  { x: 15, y: 96, w: 115, rx: -14, ry: 24, rz: 18, depth: 1 },
  { x: 30, y: 8, w: 74, rx: 12, ry: 14, rz: -6, depth: 2 },
  { x: 62, y: 92, w: 80, rx: -8, ry: -12, rz: 10, depth: 2 },
  { x: 40, y: 98, w: 68, rx: -12, ry: 10, rz: -14, depth: 2 },
  { x: 99, y: 6, w: 84, rx: 10, ry: -20, rz: 20, depth: 2 },
];
const PARALLAX_PX = [22, 12, 5];

const trackPointer = (e: PointerEvent<HTMLElement>) => {
  const box = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--px", (((e.clientX - box.left) / box.width) * 2 - 1).toFixed(3));
  e.currentTarget.style.setProperty("--py", (((e.clientY - box.top) / box.height) * 2 - 1).toFixed(3));
};

function BannerArt({ cards }: { cards: VaultCard[] }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const watch = new IntersectionObserver(([entry]) => el.toggleAttribute("data-idle", !entry?.isIntersecting));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const art = cards.filter((c) => c.frontImage);
  return (
    <div className="hbanner-art" aria-hidden="true" ref={box}>
      {art.length > 0 && SLOTS.map((slot, i) => (
        <span
          key={i}
          className={`hslab-slot d${slot.depth}`}
          style={{
            "--x": `${slot.x}%`,
            "--y": `${slot.y}%`,
            "--w": `${slot.w}px`,
            "--rx": `${slot.rx}deg`,
            "--ry": `${slot.ry}deg`,
            "--rz": `${slot.rz}deg`,
            "--par": `${PARALLAX_PX[slot.depth]}px`,
            "--delay": `${-i * 1.3}s`,
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
  input?.scrollIntoView({ block: "center", behavior: "smooth" });
  input?.focus({ preventScroll: true });
};

export function HomeBanner({ cards }: { cards: VaultCard[] }) {
  return (
    <section className="panel hbanner" aria-labelledby="hbanner-h" onPointerMove={trackPointer}>
      <BannerArt cards={cards} />

      <div className="hbanner-in">
        <p className="tags">
          <span>On-chain index</span>
          {IS_SAMPLE && <span className="hi">Preview</span>}
        </p>
        <h1 id="hbanner-h">Trading cards. Traded.</h1>
        <p>
          Go long or short on one index of five graded cards. No card required: margin in USDC,
          5x, on Solana.
        </p>
        <div className="actions">
          <button type="button" className="btn accent" onClick={focusTicket}>Start trading</button>
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
