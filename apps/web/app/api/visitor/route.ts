import { NextResponse } from "next/server";
import type { TraceEvent, VisitorBatch, VisitorContext } from "@/lib/visitor";
import { clientIp, isConfigured, recordBatch } from "@/lib/visitorServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 24_000;
const WINDOW_MS = 60_000;
const BATCHES_PER_WINDOW = 90;
const KINDS = new Set(["page", "click", "wallet", "error"]);
const hits = new Map<string, number[]>();

const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
const count = (value: unknown, max: number) => (typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(0, Math.round(value)), max) : 0);

function limited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((at) => now - at < WINDOW_MS);
  recent.push(now);
  if (hits.size > 5_000) hits.clear();
  hits.set(ip, recent);
  return recent.length > BATCHES_PER_WINDOW;
}

function parseContext(raw: unknown): VisitorContext | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.userAgent !== "string") return null;
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, 8).map((v) => v.slice(0, 40)) : []);
  return {
    landing: text(c.landing, 300),
    referrer: text(c.referrer, 300),
    userAgent: text(c.userAgent, 400),
    platform: text(c.platform, 60),
    hardwareConcurrency: typeof c.hardwareConcurrency === "number" ? count(c.hardwareConcurrency, 1024) : null,
    screen: text(c.screen, 20),
    viewport: text(c.viewport, 20),
    devicePixelRatio: typeof c.devicePixelRatio === "number" ? Math.round(c.devicePixelRatio * 100) / 100 : 1,
    languages: list(c.languages),
    timezone: text(c.timezone, 60),
    timezoneOffset: typeof c.timezoneOffset === "number" ? Math.max(-900, Math.min(900, Math.round(c.timezoneOffset))) : 0,
    colorScheme: c.colorScheme === "light" ? "light" : "dark",
    touchPoints: count(c.touchPoints, 64),
    network: text(c.network, 60),
    doNotTrack: typeof c.doNotTrack === "string" ? c.doNotTrack.slice(0, 12) : null,
    webdriver: c.webdriver === true,
    wallets: list(c.wallets),
  };
}

function parseBatch(raw: unknown): VisitorBatch | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const context = parseContext(b.context);
  const visitorId = text(b.visitorId, 64);
  const sessionId = text(b.sessionId, 64);
  if (!context || !visitorId || !sessionId || !Array.isArray(b.events)) return null;
  const events: TraceEvent[] = [];
  for (const item of b.events.slice(0, 60)) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const label = text(e.label, 160).replace(/[`\r\n]+/g, " ").trim();
    if (typeof e.kind === "string" && KINDS.has(e.kind) && label) events.push({ at: count(e.at, 86_400), kind: e.kind as TraceEvent["kind"], label });
  }
  return {
    visitorId,
    sessionId,
    visitCount: Math.max(1, count(b.visitCount, 100_000)),
    isNewVisitor: b.isNewVisitor === true,
    activeSeconds: count(b.activeSeconds, 86_400),
    context,
    events,
  };
}

export async function POST(request: Request) {
  if (!isConfigured()) return NextResponse.json({ ok: true, configured: false });
  if (limited(clientIp(request.headers) ?? "unknown")) return NextResponse.json({ ok: false }, { status: 429 });

  const raw = await request.text().catch(() => "");
  if (!raw || raw.length > MAX_BODY) return NextResponse.json({ ok: false }, { status: 400 });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {}
  const batch = parseBatch(parsed);
  if (!batch) return NextResponse.json({ ok: false }, { status: 400 });

  await recordBatch(batch, request.headers);
  return NextResponse.json({ ok: true, configured: true });
}
