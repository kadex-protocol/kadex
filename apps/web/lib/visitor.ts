export type TraceKind = "page" | "click" | "wallet" | "error";

export interface TraceEvent {
  at: number;
  kind: TraceKind;
  label: string;
}

export interface VisitorContext {
  landing: string;
  referrer: string;
  userAgent: string;
  platform: string;
  hardwareConcurrency: number | null;
  screen: string;
  viewport: string;
  devicePixelRatio: number;
  languages: string[];
  timezone: string;
  timezoneOffset: number;
  colorScheme: string;
  touchPoints: number;
  network: string;
  doNotTrack: string | null;
  webdriver: boolean;
  wallets: string[];
}

export interface VisitorBatch {
  visitorId: string;
  sessionId: string;
  visitCount: number;
  isNewVisitor: boolean;
  activeSeconds: number;
  context: VisitorContext;
  events: TraceEvent[];
}

const ENDPOINT = "/api/visitor";
const VISITOR_KEY = "kadex.vid";
const VISITS_KEY = "kadex.visits";
const SESSION_KEY = "kadex.sid";
const FLUSH_DELAY_MS = 2_000;
const MAX_QUEUE = 40;
const MAX_LABEL = 140;

interface Session {
  visitorId: string;
  sessionId: string;
  visitCount: number;
  isNewVisitor: boolean;
  startedAt: number;
  landing: string;
  referrer: string;
}

let session: Session | null = null;
let queue: TraceEvent[] = [];
let timer: number | null = null;
let disabled = false;
let visibleSince: number | null = null;
let activeMs = 0;
let wallets: string[] = [];

const read = (storage: Storage, key: string) => {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
};
const write = (storage: Storage, key: string, value: string) => {
  try {
    storage.setItem(key, value);
  } catch {}
};

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function shouldTrack(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
  if (host.endsWith(".local") || host.endsWith(".localhost")) return false;
  return !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

function resolveSession(): Session {
  if (session) return session;
  let visitorId = read(window.localStorage, VISITOR_KEY);
  const isNewVisitor = !visitorId;
  if (!visitorId) {
    visitorId = randomId();
    write(window.localStorage, VISITOR_KEY, visitorId);
  }

  const stored = read(window.sessionStorage, SESSION_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Session;
      if (parsed.sessionId && parsed.visitorId === visitorId) {
        session = parsed;
        return parsed;
      }
    } catch {}
  }

  const visitCount = Number(read(window.localStorage, VISITS_KEY) ?? "0") + 1;
  write(window.localStorage, VISITS_KEY, String(visitCount));
  session = {
    visitorId,
    sessionId: randomId(),
    visitCount,
    isNewVisitor,
    startedAt: Date.now(),
    landing: `${window.location.pathname}${window.location.search}`,
    referrer: document.referrer,
  };
  write(window.sessionStorage, SESSION_KEY, JSON.stringify(session));
  return session;
}

function networkSummary(): string {
  const connection = (navigator as Navigator & {
    connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
  }).connection;
  if (!connection) return "unknown";
  return [
    connection.effectiveType ?? "unknown",
    typeof connection.downlink === "number" ? `${connection.downlink} Mbps` : null,
    typeof connection.rtt === "number" ? `${connection.rtt} ms` : null,
    connection.saveData ? "save-data" : null,
  ].filter(Boolean).join(" | ");
}

function context(current: Session): VisitorContext {
  return {
    landing: current.landing,
    referrer: current.referrer,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency || null,
    screen: `${window.screen.width}x${window.screen.height}`,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    devicePixelRatio: window.devicePixelRatio,
    languages: navigator.languages.length ? [...navigator.languages] : [navigator.language],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffset: new Date().getTimezoneOffset(),
    colorScheme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    touchPoints: navigator.maxTouchPoints,
    network: networkSummary(),
    doNotTrack: navigator.doNotTrack,
    webdriver: Boolean((navigator as Navigator & { webdriver?: boolean }).webdriver),
    wallets,
  };
}

function activeSeconds(): number {
  const running = visibleSince === null ? 0 : Date.now() - visibleSince;
  return Math.round((activeMs + running) / 1000);
}

export function setVisible(visible: boolean): void {
  if (visible && visibleSince === null) visibleSince = Date.now();
  if (!visible && visibleSince !== null) {
    activeMs += Date.now() - visibleSince;
    visibleSince = null;
  }
}

export function setDetectedWallets(names: string[]): void {
  wallets = names;
}

export function flush(beacon = false): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  if (disabled || !shouldTrack()) return;
  const current = resolveSession();
  const batch: VisitorBatch = {
    visitorId: current.visitorId,
    sessionId: current.sessionId,
    visitCount: current.visitCount,
    isNewVisitor: current.isNewVisitor,
    activeSeconds: activeSeconds(),
    context: context(current),
    events: queue,
  };
  queue = [];
  const body = JSON.stringify(batch);
  if (beacon && navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: "application/json" }))) return;
  void fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true })
    .then((res) => res.json())
    .then((reply: { configured?: boolean }) => {
      if (reply.configured === false) disabled = true;
    })
    .catch(() => {});
}

export function track(kind: TraceKind, label: string): void {
  if (disabled || !shouldTrack()) return;
  const current = resolveSession();
  const text = label.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
  if (!text) return;
  const at = Math.max(0, Math.round((Date.now() - current.startedAt) / 1000));
  const last = queue[queue.length - 1];
  if (last && last.kind === kind && last.label === text && at - last.at <= 2) return;
  queue.push({ at, kind, label: text });
  if (queue.length >= MAX_QUEUE) flush();
  else if (timer === null) timer = window.setTimeout(() => flush(), FLUSH_DELAY_MS);
}
