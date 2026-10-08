"use client";

import { useMemo, useState, type ReactNode } from "react";
import { fmtPrice, HISTORY_STEP_SECS, IS_SAMPLE, type IndexPoint } from "@/lib/market";

const WIDTH = 1200;
const HEIGHT = 400;
const PAD = 14;
const Y_TICKS = 5;
const X_TICKS = 8;

const TIMEFRAMES = [
  { label: "15m", secs: 900 },
  { label: "30m", secs: 1800 },
  { label: "1h", secs: 3600 },
  { label: "4h", secs: 14400 },
] as const;

interface Candle {
  ts: number;
  open: number;
  close: number;
  high: number;
  low: number;
}

function toCandles(points: IndexPoint[], secs: number): Candle[] {
  const size = Math.max(1, Math.round(secs / HISTORY_STEP_SECS));
  const candles: Candle[] = [];
  for (let i = 0; i < points.length; i += size) {
    const bucket = points.slice(i, i + size).map((p) => Number(p.price));
    const open = i === 0 ? bucket[0]! : Number(points[i - 1]!.price);
    const close = bucket[bucket.length - 1]!;
    candles.push({ ts: points[i]!.ts, open, close, high: Math.max(open, ...bucket), low: Math.min(open, ...bucket) });
  }
  return candles;
}

const price = (n: number) => fmtPrice(BigInt(Math.round(n)));
const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

type Mode = "line" | "candles";

export function IndexChart({ points, head, stats }: { points: IndexPoint[]; head?: ReactNode; stats?: ReactNode }) {
  const [secs, setSecs] = useState<number>(900);
  const [mode, setMode] = useState<Mode>("line");
  const candles = useMemo(() => toCandles(points, secs), [points, secs]);

  if (points.length < 2) {
    return (
      <section className="panel chart">
        {head && <div className="chart-head"><div className="chart-id">{head}</div></div>}
        {stats}
        <p className="sub">No price history yet.</p>
      </section>
    );
  }

  const min = Math.min(...candles.map((c) => c.low));
  const max = Math.max(...candles.map((c) => c.high));
  const span = max - min || 1;
  const y = (value: number) => PAD + (1 - (value - min) / span) * (HEIGHT - PAD * 2);
  const slot = WIDTH / candles.length;
  const body = Math.max(2, slot * 0.62);
  const current = candles[candles.length - 1]!;
  const rising = current.close >= current.open;
  const move = ((current.close - current.open) / current.open) * 100;
  const yTicks = Array.from({ length: Y_TICKS }, (_, i) => max - (span * i) / (Y_TICKS - 1));
  const xStep = Math.max(1, Math.floor(candles.length / X_TICKS));
  const line = candles.map((c, i) => `${i === 0 ? "M" : "L"}${(i * slot + slot / 2).toFixed(1)} ${y(c.close).toFixed(1)}`).join(" ");
  const lastX = (candles.length - 0.5) * slot;
  const area = `${line} L${lastX.toFixed(1)} ${HEIGHT} L${(slot / 2).toFixed(1)} ${HEIGHT} Z`;
  const tone = mode === "line" ? "accent" : rising ? "up" : "down";

  return (
    <section className="panel chart" aria-label="Index price">
      <div className="chart-head">
        <div className="chart-id">{head}</div>
        <div className="chart-tools">
          <div className="chart-tf" role="group" aria-label="Interval">
            {TIMEFRAMES.map((t) => (
              <button key={t.label} type="button" aria-pressed={secs === t.secs} onClick={() => setSecs(t.secs)}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="chart-tf" role="group" aria-label="Chart type">
            <button type="button" aria-pressed={mode === "line"} onClick={() => setMode("line")}>Line</button>
            <button type="button" aria-pressed={mode === "candles"} onClick={() => setMode("candles")}>Candles</button>
          </div>
          <span className="chart-tag">Mark price{IS_SAMPLE && " · sample"}</span>
        </div>
      </div>

      {stats}

      {mode === "candles" && (
        <p className="chart-ohlc">
          O<b className={rising ? "up" : "down"}>{price(current.open)}</b>
          H<b className={rising ? "up" : "down"}>{price(current.high)}</b>
          L<b className={rising ? "up" : "down"}>{price(current.low)}</b>
          C<b className={rising ? "up" : "down"}>{price(current.close)}</b>
          <b className={rising ? "up" : "down"}>{move >= 0 ? "+" : "−"}{Math.abs(move).toFixed(2)}%</b>
        </p>
      )}

      <div className="chart-plot">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label="Index price over the last 24 hours">
          <defs>
            <linearGradient id="chart-fade" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#fff" stopOpacity="1" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
            <pattern id="chart-hatch" width="7" height="7" patternUnits="userSpaceOnUse">
              <line x1="0.5" y1="0" x2="0.5" y2="7" />
            </pattern>
            <mask id="chart-mask">
              <rect width={WIDTH} height={HEIGHT} fill="url(#chart-fade)" />
            </mask>
          </defs>
          <g className="grid">
            {yTicks.map((t) => (
              <line key={`y${t}`} x1={0} x2={WIDTH} y1={y(t)} y2={y(t)} />
            ))}
            {candles.map((c, i) =>
              i % xStep === 0 ? <line key={`x${c.ts}`} x1={i * slot + slot / 2} x2={i * slot + slot / 2} y1={0} y2={HEIGHT} /> : null,
            )}
          </g>
          {mode === "line" && (
            <g className="trace">
              <path className="fill" d={area} mask="url(#chart-mask)" />
              <path className="hatch" d={area} fill="url(#chart-hatch)" mask="url(#chart-mask)" />
              <path className="stroke" d={line} />
            </g>
          )}
          {mode === "candles" && candles.map((c, i) => {
            const cx = i * slot + slot / 2;
            const top = y(Math.max(c.open, c.close));
            const height = Math.max(1.5, Math.abs(y(c.open) - y(c.close)));
            return (
              <g key={c.ts} className={c.close >= c.open ? "up" : "down"}>
                <line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} />
                <rect x={cx - body / 2} y={top} width={body} height={height} />
              </g>
            );
          })}
          <line className={`last ${tone}`} x1={0} x2={WIDTH} y1={y(current.close)} y2={y(current.close)} />
        </svg>
        <div className="chart-y" aria-hidden="true">
          {yTicks.map((t) => (
            <span key={t}>{price(t)}</span>
          ))}
        </div>
        {mode === "line" && (
          <i className="chart-dot" style={{ top: `${(y(current.close) / HEIGHT) * 100}%`, left: `calc((100% - 62px) * ${(lastX / WIDTH).toFixed(4)})` }} />
        )}
        <span className={`chart-last ${tone}`} style={{ top: `${(y(current.close) / HEIGHT) * 100}%` }}>
          {price(current.close)}
        </span>
      </div>

      <div className="chart-x" aria-hidden="true">
        {candles.map((c, i) => (i % xStep === 0 ? <span key={c.ts} style={{ left: `${((i + 0.5) / candles.length) * 100}%` }}>{clock(c.ts)}</span> : null))}
      </div>
    </section>
  );
}
