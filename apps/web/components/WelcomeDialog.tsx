"use client";

import { BRAND } from "@/lib/brand";
import { useEffect, useRef, useState, type ReactNode } from "react";

const SEEN_KEY = "kadex.welcome.v1";
const FORCE_PARAM = "onboarding";

const INDEX_LINE = "M0 96 L40 88 L78 92 L116 70 L150 76 L190 52 L228 60 L268 38 L306 44 L346 22 L384 30 L420 12";

export function TradeStage() {
  return (
    <div className="wstage">
      <svg className="wchart" viewBox="0 0 420 120" preserveAspectRatio="none" aria-hidden="true">
        <path className="area" d={`${INDEX_LINE} L420 120 L0 120 Z`} />
        <path className="line" d={INDEX_LINE} pathLength={1} />
      </svg>
      <div className="wtrade">
        <span className="wpill up">Long</span>
        <span className="wprice">1.0432</span>
        <span className="wpill down">Short</span>
      </div>
    </div>
  );
}

export function EarnStage() {
  return (
    <div className="wstage">
      <div className="wpool">
        <div className="wsleeve usdc">
          <b>USDC</b>
          <span>pays winning trades</span>
        </div>
        <div className="wsleeve cards">
          <b>Card fractions</b>
          <span>graded cards</span>
        </div>
      </div>
      <div className="wflow" aria-hidden="true">↓</div>
      <div className="wclp">
        <span className="star" />
        CLP · your share of the pool
      </div>
    </div>
  );
}

export function VaultStage() {
  return (
    <div className="wstage wvault">
      <div className="wslab">
        <i />
        <span className="star" />
      </div>
      <div className="wflow side" aria-hidden="true">→</div>
      <div className="wfractions" aria-hidden="true">
        {Array.from({ length: 24 }, (_, i) => (
          <i key={i} style={{ animationDelay: `${i * 45}ms` }} />
        ))}
      </div>
    </div>
  );
}

const IconTrade = (
  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M3 14l4.5-5 3 3L17 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12.5 5H17v4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IconEarn = (
  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <ellipse cx="10" cy="6" rx="6" ry="2.6" stroke="currentColor" strokeWidth="1.6" />
    <path d="M4 6v4c0 1.4 2.7 2.6 6 2.6s6-1.2 6-2.6V6M4 10v4c0 1.4 2.7 2.6 6 2.6s6-1.2 6-2.6v-4" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);
const IconVault = (
  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <rect x="5" y="2.5" width="10" height="15" rx="2" stroke="currentColor" strokeWidth="1.6" />
    <path d="M7.5 5.5h5M7.5 8.5h5v6h-5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
);

interface Step {
  icon: ReactNode;
  stage: ReactNode;
  headline: string;
  body: string;
}

const STEPS: Step[] = [
  {
    icon: IconTrade,
    stage: <TradeStage />,
    headline: "Trade the card market, not a card",
    body: "One index tracks five graded cards. Go long or short with USDC margin at 5x. You never have to own, ship or store a slab.",
  },
  {
    icon: IconEarn,
    stage: <EarnStage />,
    headline: "Be the other side and earn",
    body: "Deposit USDC or card fractions into the pool and receive CLP. The pool takes the other side of every trade and collects the borrow and trading fees.",
  },
  {
    icon: IconVault,
    stage: <VaultStage />,
    headline: "Put your own slab to work",
    body: "Vault a graded card and receive fractions worth its appraised value. Deposit them to earn, and redeem the card when you hold them all.",
  },
];

export function WelcomeDialog() {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const primary = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const forced = new URLSearchParams(window.location.search).get(FORCE_PARAM) === "true";
    let seen = true;
    try {
      seen = window.localStorage.getItem(SEEN_KEY) === "1";
      if (!seen) window.localStorage.setItem(SEEN_KEY, "1");
    } catch {}
    if (forced || !seen) setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    primary.current?.focus();
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  const step = STEPS[index]!;
  const isLast = index === STEPS.length - 1;
  const two = (n: number) => String(n).padStart(2, "0");

  return (
    <div className="welcome-overlay">
      <div className="welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-h" aria-describedby="welcome-p">
        <div className="welcome-media" key={index}>{step.stage}</div>

        <div className="welcome-body">
          <div className="welcome-progress">
            {STEPS.map((_, i) => (
              <span key={i} className={i <= index ? "on" : undefined} />
            ))}
            <em>{two(index + 1)} / {two(STEPS.length)}</em>
          </div>

          <div className="welcome-copy" key={index}>
            <div className="welcome-head">
              <span className="welcome-ico">{step.icon}</span>
              <h2 id="welcome-h">{step.headline}</h2>
            </div>
            <p id="welcome-p">{step.body}</p>
          </div>

          <div className="welcome-nav">
            {index === 0 ? (
              <button type="button" className="welcome-ghost" onClick={() => setOpen(false)}>Skip</button>
            ) : (
              <button type="button" className="welcome-ghost" onClick={() => setIndex(index - 1)}>← Back</button>
            )}
            <button
              ref={primary}
              type="button"
              className="btn accent welcome-next"
              onClick={() => (isLast ? setOpen(false) : setIndex(index + 1))}
            >
              {isLast ? `Enter ${BRAND}` : "Next"} →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
