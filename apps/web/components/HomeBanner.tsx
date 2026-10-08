"use client";

import Link from "next/link";
import { IS_SAMPLE } from "@/lib/market";
import type { VaultCard } from "@/lib/collectorCrypt";

const ART_SHOWN = 5;

const focusTicket = () => {
  const input = document.querySelector<HTMLInputElement>(".ticket input");
  input?.scrollIntoView({ block: "center", behavior: "smooth" });
  input?.focus({ preventScroll: true });
};

export function HomeBanner({ cards }: { cards: VaultCard[] }) {
  const art = cards.filter((c) => c.frontImage).slice(0, ART_SHOWN);
  return (
    <section className="panel hbanner" aria-labelledby="hbanner-h">
      <div className="hbanner-art" aria-hidden="true">
        {art.map((c) => (
          <img key={c.nftAddress} src={c.frontImage!} alt="" loading="lazy" />
        ))}
      </div>

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
  const art = cards.filter((c) => c.frontImage).slice(0, ART_SHOWN);
  return (
    <section className="panel hbanner" aria-labelledby="vbanner-h">
      <div className="hbanner-art" aria-hidden="true">
        {art.map((c) => (
          <img key={c.nftAddress} src={c.frontImage!} alt="" loading="lazy" />
        ))}
      </div>

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
