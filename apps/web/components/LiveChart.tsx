"use client";

import { useEffect, useRef, useState } from "react";
import { fmtPrice } from "@/lib/market";

type PriceAt = (ts: number) => bigint | null;

const WINDOW_MS = 90_000;
const NARROW_WINDOW_MS = 45_000;
const NARROW_PX = 480;
const STEP_MS = 500;
const FRAME_MS = 50;
const LABEL_STEPS_MS = [15_000, 30_000, 60_000];
const LABEL_GAP_PX = 76;
const HEAD = 0.86;
const AXIS = 62;
const FOOT = 24;
const MIN_PAD = 0.0004;

const niceStep = (span: number) => {
  const raw = span / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / pow;
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * pow;
};
const two = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

export function LiveChart({ priceAt }: { priceAt: PriceAt }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const at = useRef(priceAt);
  at.current = priceAt;

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;

    const style = getComputedStyle(el);
    const color = (name: string) => style.getPropertyValue(name).trim();
    const ink = color("--ink");
    const mute = color("--mute");
    const grid = color("--line-soft");
    const up = color("--up");
    const down = color("--down");
    const bg = color("--bg");
    const font = style.fontFamily;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const read = (ms: number) => {
      const v = at.current(ms / 1000);
      return v === null ? null : Number(v) / 1e6;
    };

    const pts: [number, number][] = [];
    let lo = 0;
    let hi = 0;
    let frame = 0;
    let timer = 0;
    let seen = true;
    let w = el.clientWidth;
    let h = el.clientHeight;

    const fill = (ms: number) => {
      const last = pts[pts.length - 1];
      if (last && ms - last[0] > WINDOW_MS) pts.length = 0;
      let t = pts.length ? pts[pts.length - 1]![0] + STEP_MS : ms - WINDOW_MS;
      for (; t <= ms; t += STEP_MS) {
        const p = read(t);
        if (p !== null) pts.push([t, p]);
      }
      while (pts.length > 2 && pts[1]![0] < ms - WINDOW_MS) pts.shift();
    };

    const paint = () => {
      const ms = Date.now();
      fill(ms);
      const head = read(ms) ?? pts[pts.length - 1]?.[1];
      const dpr = window.devicePixelRatio || 1;
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
        el.width = Math.round(w * dpr);
        el.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (head === undefined || pts.length === 0) return;

      const plotW = w - AXIS;
      const plotH = h - FOOT;
      const headX = plotW * HEAD;
      const span = plotW < NARROW_PX ? NARROW_WINDOW_MS : WINDOW_MS;
      const x = (t: number) => headX - ((ms - t) / span) * headX;

      let min = head;
      let max = head;
      for (const [t, p] of pts) {
        if (t < ms - span) continue;
        if (p < min) min = p;
        if (p > max) max = p;
      }
      const pad = Math.max((max - min) * 0.35, MIN_PAD);
      if (hi === lo) {
        lo = min - pad;
        hi = max + pad;
      } else {
        lo += (min - pad - lo) * 0.12;
        hi += (max + pad - hi) * 0.12;
      }
      const y = (p: number) => 8 + (1 - (p - lo) / (hi - lo)) * (plotH - 16);

      ctx.lineWidth = 1;
      ctx.textBaseline = "middle";
      ctx.font = `500 11.5px ${font}`;
      ctx.strokeStyle = grid;
      ctx.fillStyle = mute;
      ctx.textAlign = "right";
      ctx.setLineDash([3, 4]);
      const step = niceStep(hi - lo);
      for (let v = Math.ceil(lo / step) * step; v < hi; v += step) {
        const gy = Math.round(y(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(plotW, gy);
        ctx.stroke();
        ctx.fillText(v.toFixed(4), w - 4, gy);
      }
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(0, plotH + 0.5);
      ctx.lineTo(plotW, plotH + 0.5);
      ctx.stroke();

      ctx.textAlign = "center";
      const every = LABEL_STEPS_MS.find((gap) => (headX * gap) / span >= LABEL_GAP_PX) ?? 60_000;
      for (let t = Math.ceil((ms - span) / every) * every; t <= ms; t += every) {
        const tx = x(t);
        if (tx > 34 && tx < plotW - 34) ctx.fillText(clock(t), tx, h - FOOT / 2 + 2);
      }

      const hy = y(head);
      ctx.beginPath();
      pts.forEach(([t, p], i) => (i ? ctx.lineTo(x(t), y(p)) : ctx.moveTo(x(t), y(p))));
      ctx.lineTo(headX, hy);
      ctx.lineJoin = "round";
      ctx.lineWidth = 2;
      ctx.strokeStyle = ink;
      ctx.stroke();
      ctx.lineTo(headX, plotH);
      ctx.lineTo(x(pts[0]![0]), plotH);
      ctx.closePath();
      ctx.fillStyle = ink;
      ctx.globalAlpha = 0.06;
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.lineWidth = 1;
      ctx.strokeStyle = mute;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(headX, hy);
      ctx.lineTo(plotW, hy);
      ctx.stroke();
      ctx.setLineDash([]);

      const pulse = still ? 0.4 : (ms % 1600) / 1600;
      ctx.globalAlpha = 0.3 * (1 - pulse);
      ctx.beginPath();
      ctx.arc(headX, hy, 5 + pulse * 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(headX, hy, 4.5, 0, Math.PI * 2);
      ctx.fill();

      const before = pts[Math.max(0, pts.length - 1 - 60_000 / STEP_MS)]![1];
      ctx.fillStyle = head >= before ? up : down;
      ctx.beginPath();
      ctx.roundRect(plotW + 4, hy - 10, AXIS - 6, 20, 6);
      ctx.fill();
      ctx.fillStyle = bg;
      ctx.font = `600 11.5px ${font}`;
      ctx.fillText(head.toFixed(4), plotW + 4 + (AXIS - 6) / 2, hy + 0.5);
    };

    const loop = () => {
      paint();
      timer = window.setTimeout(() => {
        frame = requestAnimationFrame(loop);
      }, still ? 1000 : FRAME_MS);
    };
    const stop = () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
    const watch = new IntersectionObserver(([entry]) => {
      const visible = entry?.isIntersecting ?? true;
      if (visible === seen) return;
      seen = visible;
      stop();
      if (seen) frame = requestAnimationFrame(loop);
    });
    const sizes = new ResizeObserver(([entry]) => {
      if (!entry) return;
      w = entry.contentRect.width;
      h = entry.contentRect.height;
    });
    watch.observe(el);
    sizes.observe(el);
    frame = requestAnimationFrame(loop);
    return () => {
      stop();
      watch.disconnect();
      sizes.disconnect();
    };
  }, []);

  return <canvas ref={canvas} role="img" aria-label="Index price, live" />;
}

export function LivePrice({ priceAt }: { priceAt: PriceAt }) {
  const at = useRef(priceAt);
  at.current = priceAt;
  const last = useRef<string | null>(null);
  const [view, setView] = useState({ text: "-", tone: "" });

  useEffect(() => {
    const read = () => {
      const v = at.current(Date.now() / 1000);
      if (v === null) return;
      const text = fmtPrice(v);
      if (text === last.current) return;
      const tone = last.current === null ? "" : text > last.current ? "up" : "down";
      last.current = text;
      setView({ text, tone });
    };
    read();
    const timer = setInterval(read, 1000);
    return () => clearInterval(timer);
  }, []);

  return <span key={view.text} className={`tick ${view.tone}`} data-v={view.text}>{view.text}</span>;
}
