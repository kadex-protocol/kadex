"use client";

import { BRAND } from "@/lib/brand";
import { USD_LABEL } from "@/lib/cluster";
import { borrowSpread, CONSTITUENTS, fmtPrice, fmtUsd } from "@/lib/market";
import { useMarket } from "@/lib/useMarket";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowIcon } from "@/components/ArrowIcon";
import { useSearchParams } from "next/navigation";

const SEEN_KEY = "kadex.welcome.v1";
const FORCE_PARAM = "onboarding";

const CHART_W = 680;
const CHART_H = 210;
const ENTRY_AT = 19;
const EXAMPLE_SIZE = 5_000;

const CANDLES = (() => {
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const out: { open: number; close: number; high: number; low: number; volume: number }[] = [];
  let price = 1;
  for (let i = 0; i < 34; i++) {
    const drift = i > ENTRY_AT ? 0.0034 : -0.0004;
    const open = price;
    const close = open * (1 + drift + noise() * 0.0052);
    out.push({
      open,
      close,
      high: Math.max(open, close) * (1 + Math.abs(noise()) * 0.0026),
      low: Math.min(open, close) * (1 - Math.abs(noise()) * 0.0026),
      volume: 0.35 + Math.abs(noise()) * 0.65,
    });
    price = close;
  }
  const last = out[out.length - 1]!.close;
  return out.map((c) => ({ ...c, open: c.open / last, close: c.close / last, high: c.high / last, low: c.low / last }));
})();

const LOW = Math.min(...CANDLES.map((c) => c.low));
const HIGH = Math.max(...CANDLES.map((c) => c.high));
const STEP = (CHART_W - 96) / CANDLES.length;
const candleX = (i: number) => 10 + i * STEP + STEP / 2;
const priceY = (v: number) => 44 + (1 - (v - LOW) / (HIGH - LOW)) * (CHART_H - 100);
const ENTRY = CANDLES[ENTRY_AT]!.close;
const EXAMPLE_PNL = EXAMPLE_SIZE * (1 / ENTRY - 1);
const usd = (value: number, digits = 0) => value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const BASKET = [...CONSTITUENTS].sort((a, b) => b.weightBps - a.weightBps);

export function TradeStage() {
  const { data } = useMarket();
  const mark = data ? Number(data.oracle.price) / 1e6 : null;
  const tip = CANDLES.length - 1;
  return (
    <div className="wstage ws-trade">
      <p className="ws-index">
        <span className="star" />
        {BRAND} Index
        {data && <em>{Number(data.pool.params.baseLeverage) / 1e6}x</em>}
      </p>
      <div className="ws-chart">
        <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" aria-hidden="true">
          <g className="ws-candles">
            {CANDLES.map((c, i) => {
              const tone = c.close >= c.open ? "up" : "down";
              const top = priceY(Math.max(c.open, c.close));
              return (
                <g key={i} className={tone}>
                  <rect className="vol" x={candleX(i) - STEP * 0.3} y={CHART_H - c.volume * 34} width={STEP * 0.6} height={c.volume * 34} />
                  <line x1={candleX(i)} x2={candleX(i)} y1={priceY(c.high)} y2={priceY(c.low)} />
                  <rect x={candleX(i) - STEP * 0.3} y={top} width={STEP * 0.6} height={Math.max(1.5, priceY(Math.min(c.open, c.close)) - top)} rx="1" />
                </g>
              );
            })}
          </g>
          <line className="ws-entry" x1={candleX(ENTRY_AT)} x2={CHART_W - 86} y1={priceY(ENTRY)} y2={priceY(ENTRY)} />
          <line className="ws-mark" x1={candleX(tip)} x2={CHART_W - 86} y1={priceY(1)} y2={priceY(1)} />
          <circle className="ws-tip" cx={candleX(tip)} cy={priceY(1)} r="4" />
        </svg>
        <span className="ws-tag entry" style={{ left: `${(candleX(ENTRY_AT) / CHART_W) * 100}%`, top: `${(priceY(ENTRY) / CHART_H) * 100}%` }}>
          Long · {usd(EXAMPLE_SIZE)} @ {mark === null ? "—" : (mark * ENTRY).toFixed(4)}
        </span>
        <span className="ws-tag pnl" style={{ left: `${(candleX(tip - 6) / CHART_W) * 100}%`, top: `${(priceY(1) / CHART_H) * 100}%` }}>
          Long +${usd(EXAMPLE_PNL, 2)}
        </span>
        <span className="ws-axis" style={{ top: `${(priceY(1) / CHART_H) * 100}%` }}>
          {data ? fmtPrice(data.oracle.price) : "—"}
        </span>
      </div>
      <ul className="ws-strip">
        {BASKET.slice(0, 5).map((card) => (
          <li key={card.id}>
            {card.image ? <img src={card.image} alt="" loading="lazy" /> : <i />}
            <span>
              <b>${usd(Number(card.appraisalUsd))}</b>
              <small>{(card.weightBps / 100).toFixed(1)}% of index</small>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function EarnStage() {
  const { data } = useMarket();
  const spread = data ? borrowSpread(data) : null;
  const cash = data ? Number(data.pool.usdcSleeve) : 0;
  const cards = data ? Number(data.pool.cardSleeveValue) : 0;
  const cashShare = cash + cards > 0 ? (cash / (cash + cards)) * 100 : 70;
  return (
    <div className="wstage ws-earn">
      <div className="ws-pool">
        <p className="ws-pool-head">
          <span>{BRAND} pool</span>
          <b>{data ? `$${fmtUsd(data.poolStats.nav, 2)}` : "—"}</b>
        </p>
        <div className="ws-split" aria-hidden="true">
          <i style={{ width: `${cashShare}%` }} />
        </div>
        <div className="ws-sleeves">
          <div className="ws-sleeve">
            <small>{USD_LABEL} · {cashShare.toFixed(0)}%</small>
            <b>{data ? `$${fmtUsd(data.pool.usdcSleeve, 0)}` : "—"}</b>
            <span>Pays winning trades</span>
          </div>
          <div className="ws-sleeve cards">
            <small>Card fractions · {(100 - cashShare).toFixed(0)}%</small>
            <b>{data ? `$${fmtUsd(data.pool.cardSleeveValue, 0)}` : "—"}</b>
            <span className="ws-thumbs" aria-hidden="true">
              {BASKET.slice(0, 4).map((card) => card.image && <img key={card.id} src={card.image} alt="" loading="lazy" />)}
            </span>
          </div>
        </div>
      </div>
      <div className="ws-clp">
        <span className="star" />
        <b>CLP</b>
        <span>Your share of the pool</span>
        {spread && <em>Borrow L {spread.longMonthly.toFixed(2)}% · S {spread.shortMonthly.toFixed(2)}% / mo</em>}
      </div>
    </div>
  );
}

function VaultStage() {
  const card = BASKET.find((c) => c.image) ?? BASKET[0];
  if (!card) return null;
  const value = Number(card.appraisalUsd);
  return (
    <div className="wstage ws-vault">
      <figure className="ws-slab">
        {card.image ? <img src={card.image} alt="" loading="lazy" /> : <i />}
        <figcaption>${usd(value)}</figcaption>
      </figure>
      <div className="ws-arrow" aria-hidden="true">→</div>
      <div className="ws-fractions">
        <small>{card.grade}</small>
        <p>{card.name}</p>
        <b>${usd(value, 2)}</b>
        <span>in fractions, at the appraised value</span>
        <div className="ws-dots" aria-hidden="true">
          {Array.from({ length: 30 }, (_, i) => (
            <i key={i} style={{ animationDelay: `${200 + i * 30}ms` }} />
          ))}
        </div>
        <ul>
          <li>Deposit them to earn CLP</li>
          <li>Hold them all to redeem the card</li>
        </ul>
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
    body: `One index tracks ${CONSTITUENTS.length} graded cards. Go long or short with ${USD_LABEL} margin. You never have to own, ship or store a slab.`,
  },
  {
    icon: IconEarn,
    stage: <EarnStage />,
    headline: "Be the other side and earn",
    body: `Deposit ${USD_LABEL} or card fractions into the pool and receive CLP. The pool takes the other side of every trade and collects the borrow and trading fees.`,
  },
  {
    icon: IconVault,
    stage: <VaultStage />,
    headline: "Put your own slab to work",
    body: "Vault a graded card and receive fractions worth its appraised value. Deposit them to earn, and redeem the card when you hold them all.",
  },
];

export function WelcomeDialog() {
  const searchParams = useSearchParams();
  const forced = searchParams.get(FORCE_PARAM) === "true";
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const primary = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let seen = true;
    try {
      seen = window.localStorage.getItem(SEEN_KEY) === "1";
      if (!seen) window.localStorage.setItem(SEEN_KEY, "1");
    } catch {}
    if (forced || !seen) setOpen(true);
  }, [forced]);

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
              <button type="button" className="welcome-ghost" onClick={() => setIndex(index - 1)}><ArrowIcon direction="left" /> Back</button>
            )}
            <button
              ref={primary}
              type="button"
              className="btn accent welcome-next"
              onClick={() => (isLast ? setOpen(false) : setIndex(index + 1))}
            >
              {isLast ? `Enter ${BRAND}` : "Next"} <ArrowIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
