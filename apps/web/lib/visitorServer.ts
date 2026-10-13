import type { TraceEvent, VisitorBatch, VisitorContext } from "./visitor";

const COLOR_HUMAN = 0x2ecc71;
const COLOR_SUSPICIOUS = 0xf1c40f;
const COLOR_BOT = 0x95a5a6;
const COLOR_WALLET = 0xf7931a;
const COLOR_ERROR = 0xd15a4c;
const COLOR_CRAWLER = 0x5865f2;

const SESSION_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_SESSIONS = 400;
const MAX_EVENTS = 150;
const TRACE_LINES = 28;
const GEO_TIMEOUT_MS = 1_500;
const PREVIEW_DEDUPE_MS = 10 * 60 * 1000;

const BOT_UA =
  /bot|crawl|spider|slurp|headless|phantomjs|puppeteer|playwright|selenium|python|curl|wget|okhttp|java\/|go-http|node-fetch|axios|http-?client|libwww|facebookexternalhit|whatsapp|telegrambot|bingpreview|preview|scan|monitor|uptime|pingdom|lighthouse|gtmetrix|semrush|ahrefs|dataprovider/i;
const MOBILE_UA = /iphone|ipad|android|mobile/i;

const SOCIAL_CRAWLERS: { pattern: RegExp; label: string }[] = [
  { pattern: /twitterbot/i, label: "X card crawler" },
  { pattern: /discordbot/i, label: "Discord embed crawler" },
  { pattern: /facebookexternalhit|meta-externalagent/i, label: "Meta crawler" },
  { pattern: /slackbot/i, label: "Slack unfurl" },
  { pattern: /whatsapp/i, label: "WhatsApp preview" },
  { pattern: /telegrambot/i, label: "Telegram preview" },
  { pattern: /linkedinbot/i, label: "LinkedIn crawler" },
  { pattern: /googlebot|google-inspectiontool/i, label: "Google crawler" },
];

const SOURCES: { pattern: RegExp; label: string }[] = [
  { pattern: /colosseum|arena\./i, label: "Colosseum" },
  { pattern: /(^|\.)(x|twitter)\.com$|^t\.co$/i, label: "X" },
  { pattern: /discord/i, label: "Discord" },
  { pattern: /github/i, label: "GitHub" },
  { pattern: /youtube|youtu\.be/i, label: "YouTube" },
  { pattern: /linkedin|lnkd\.in/i, label: "LinkedIn" },
  { pattern: /whatsapp|wa\.me/i, label: "WhatsApp" },
  { pattern: /telegram|t\.me/i, label: "Telegram" },
  { pattern: /google\./i, label: "Google search" },
  { pattern: /railway\.app|kc1t\.com/i, label: "Kadex (internal)" },
];

export interface Geo {
  ip: string | null;
  country: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  isp: string | null;
  hosting: boolean;
  proxy: boolean;
}

interface Field {
  name: string;
  value: string;
  inline?: boolean;
}

interface Embed {
  title: string;
  description?: string;
  color: number;
  fields: Field[];
  footer?: { text: string };
  timestamp?: string;
}

interface Session {
  sessionId: string;
  visitorId: string;
  visitCount: number;
  isNewVisitor: boolean;
  context: VisitorContext;
  geo: Geo;
  host: string;
  events: TraceEvent[];
  activeSeconds: number;
  firstSeen: number;
  lastSeen: number;
  messageId: string | null;
  work: Promise<void>;
}

interface DayStats {
  day: string;
  visitors: Set<string>;
  humans: Set<string>;
  wallets: Set<string>;
  sessions: number;
}

const sessions = new Map<string, Session>();
const geoCache = new Map<string, Geo>();
const previewSeen = new Map<string, number>();
let stats: DayStats = { day: "", visitors: new Set(), humans: new Set(), wallets: new Set(), sessions: 0 };

const clip = (value: string, max = 1000) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const webhookUrl = () => process.env.DISCORD_VISITOR_WEBHOOK_URL?.trim() || null;
export const isConfigured = () => webhookUrl() !== null;

export function clientIp(headers: Headers): string | null {
  const ip = headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim() || null;
  return ip ? ip.replace(/^::ffff:/, "") : null;
}

const isPrivateIp = (ip: string) =>
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i.test(ip);

const emptyGeo = (ip: string | null): Geo => ({
  ip, country: null, countryCode: null, region: null, city: null, latitude: null, longitude: null, timezone: null, isp: null, hosting: false, proxy: false,
});

export async function lookupGeo(ip: string | null): Promise<Geo> {
  if (!ip || isPrivateIp(ip)) return emptyGeo(ip);
  const cached = geoCache.get(ip);
  if (cached) return cached;
  let geo = emptyGeo(ip);
  try {
    const fields = "status,country,countryCode,regionName,city,lat,lon,timezone,isp,org,proxy,hosting";
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=${fields}`, { signal: AbortSignal.timeout(GEO_TIMEOUT_MS) });
    const data = (await res.json()) as Record<string, unknown>;
    if (data.status === "success") {
      const text = (key: string) => (typeof data[key] === "string" && data[key] ? (data[key] as string) : null);
      const num = (key: string) => (typeof data[key] === "number" ? (data[key] as number) : null);
      geo = {
        ip,
        country: text("country"),
        countryCode: text("countryCode"),
        region: text("regionName"),
        city: text("city"),
        latitude: num("lat"),
        longitude: num("lon"),
        timezone: text("timezone"),
        isp: text("org") ?? text("isp"),
        hosting: data.hosting === true,
        proxy: data.proxy === true,
      };
      if (geoCache.size > 2_000) geoCache.clear();
      geoCache.set(ip, geo);
    }
  } catch {}
  return geo;
}

function parseUserAgent(ua: string) {
  const socialCrawler = SOCIAL_CRAWLERS.find((c) => c.pattern.test(ua))?.label ?? null;
  const isBot = socialCrawler !== null || BOT_UA.test(ua);
  const browser = /edg\//i.test(ua) ? "Edge"
    : /opr\/|opera/i.test(ua) ? "Opera"
    : /brave/i.test(ua) ? "Brave"
    : /chrome\//i.test(ua) && !/chromium/i.test(ua) ? "Chrome"
    : /firefox\//i.test(ua) ? "Firefox"
    : /safari\//i.test(ua) && !/chrome/i.test(ua) ? "Safari"
    : "unknown";
  const os = /windows nt/i.test(ua) ? "Windows"
    : /android/i.test(ua) ? "Android"
    : /iphone|ipad|ipod/i.test(ua) ? "iOS"
    : /mac os x/i.test(ua) ? "macOS"
    : /cros/i.test(ua) ? "ChromeOS"
    : /linux/i.test(ua) ? "Linux"
    : "unknown";
  const deviceType = !ua ? "unknown" : isBot ? "bot" : /ipad|tablet/i.test(ua) ? "tablet" : /mobi|iphone|android/i.test(ua) ? "mobile" : "desktop";
  const inApp = /phantom/i.test(ua) ? "Phantom in-app browser" : /solflare/i.test(ua) ? "Solflare in-app browser" : null;
  return { browser, os, deviceType, isBot, socialCrawler, inApp };
}

function classify(context: VisitorContext, geo: Geo) {
  const reasons: string[] = [];
  let score = 0;
  const ua = context.userAgent;
  const mobile = MOBILE_UA.test(ua);
  const flag = (points: number, reason: string) => {
    score += points;
    reasons.push(reason);
  };

  if (context.webdriver) flag(4, "navigator.webdriver=true");
  if (BOT_UA.test(ua)) flag(4, "bot user-agent signature");
  if (mobile && /linux x86_64|win32|win64|macintel/i.test(context.platform)) flag(3, `platform "${context.platform}" ≠ mobile UA`);
  if (mobile && (context.hardwareConcurrency ?? 0) > 16) flag(2, `${context.hardwareConcurrency} cores on a mobile UA`);
  if (mobile && context.touchPoints === 0) flag(2, "mobile UA, 0 touch points");
  if (/posix/i.test(context.languages.join(","))) flag(3, "POSIX locale");
  if (context.timezone === "UTC" && context.timezoneOffset === 0) flag(1, "UTC timezone (offset 0)");
  if (geo.hosting) flag(2, "datacenter IP");
  if (geo.proxy) flag(1, "proxy or VPN IP");
  if (geo.timezone && context.timezone && geo.timezone !== context.timezone && context.timezone !== "UTC") {
    flag(0, `browser timezone ${context.timezone} ≠ IP timezone ${geo.timezone}`);
  }
  if (/^0x0$/.test(context.viewport) || /^0x/.test(context.screen)) flag(2, "zero-size screen");

  return { isBot: score >= 4, suspicious: score >= 2 && score < 4, score, reasons };
}

function describeSource(context: VisitorContext): string {
  const query = context.landing.includes("?") ? new URLSearchParams(context.landing.slice(context.landing.indexOf("?"))) : null;
  const utm = query
    ? ["utm_source", "utm_medium", "utm_campaign", "ref"].map((key) => (query.get(key) ? `${key.replace("utm_", "")}=${query.get(key)}` : null)).filter(Boolean)
    : [];
  let origin = "Direct (typed, bookmark or app)";
  if (context.referrer) {
    try {
      const host = new URL(context.referrer).hostname.replace(/^www\./, "");
      const known = SOURCES.find((source) => source.pattern.test(host))?.label;
      origin = known ? `${known} · ${host}` : host;
    } catch {
      origin = context.referrer;
    }
  }
  return [origin, utm.length ? utm.join(" · ") : null, `landed on \`${context.landing || "/"}\``].filter(Boolean).join("\n");
}

const clock = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const ICON: Record<TraceEvent["kind"], string> = { page: "→", click: "•", wallet: "◆", error: "✖" };

function trace(events: TraceEvent[]): string {
  if (events.length === 0) return "";
  const lines = events.map((event) => {
    const label = event.kind === "wallet" ? event.label.replace(/([1-9A-HJ-NP-Za-km-z]{4})[1-9A-HJ-NP-Za-km-z]{24,40}([1-9A-HJ-NP-Za-km-z]{4})/, "$1…$2") : event.label;
    return `${clock(event.at)} ${ICON[event.kind]} ${label}`;
  });
  const shown = lines.length > TRACE_LINES ? [...lines.slice(0, 4), `      ⋯ ${lines.length - TRACE_LINES} steps hidden ⋯`, ...lines.slice(-(TRACE_LINES - 4))] : lines;
  return `\`\`\`\n${clip(shown.join("\n"), 3_800)}\n\`\`\``;
}

function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

function dayStats(): DayStats {
  const day = today();
  if (stats.day !== day) stats = { day, visitors: new Set(), humans: new Set(), wallets: new Set(), sessions: 0 };
  return stats;
}

function walletOf(events: TraceEvent[]): { name: string; address: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const match = events[i]!.kind === "wallet" ? /^(.+) connected · (\S+)$/.exec(events[i]!.label) : null;
    if (match) return { name: match[1]!, address: match[2]! };
  }
  return null;
}

function buildEmbed(session: Session): Embed {
  const { context, geo, events } = session;
  const cls = classify(context, geo);
  const device = parseUserAgent(context.userAgent);
  const wallet = walletOf(events);
  const errors = events.filter((event) => event.kind === "error");
  const pages = [...new Set(events.filter((event) => event.kind === "page").map((event) => event.label.split("?")[0]!))];
  const clicks = events.filter((event) => event.kind === "click").length;
  const today = dayStats();
  const human = !cls.isBot;
  const onSite = Math.max(Math.round((session.lastSeen - session.firstSeen) / 1000), events[events.length - 1]?.at ?? 0, session.activeSeconds);

  const kind = cls.isBot ? "🤖 Bot" : cls.suspicious ? "🚧 Suspicious" : "🧑 Human";
  const visit = session.isNewVisitor && session.visitCount <= 1 ? "✨ New visitor" : `🔁 Returning · visit #${session.visitCount}`;
  const place = [geo.city, geo.countryCode].filter(Boolean).join(", ");
  const stage = wallet ? "👛 Wallet connected" : clicks > 0 ? "🖱️ Engaged" : "👀 Browsing";
  const color = cls.isBot ? COLOR_BOT : wallet ? COLOR_WALLET : errors.length > 0 ? COLOR_ERROR : cls.suspicious ? COLOR_SUSPICIOUS : COLOR_HUMAN;

  const location = [
    [geo.city, geo.region, geo.country].filter(Boolean).join(", ") || "unknown",
    geo.isp ? `${geo.isp}${geo.hosting ? " · datacenter" : ""}${geo.proxy ? " · proxy/VPN" : ""}` : null,
    [geo.ip ? `\`${geo.ip}\`` : null, geo.latitude !== null && geo.longitude !== null ? `[map](https://www.google.com/maps?q=${geo.latitude},${geo.longitude})` : null].filter(Boolean).join(" · ") || null,
  ].filter(Boolean).join("\n");

  const engagement = [
    `${duration(session.activeSeconds)} active · ${duration(onSite)} on site`,
    `${pages.length} page${pages.length === 1 ? "" : "s"}${pages.length ? ` (${pages.join(" ")})` : ""} · ${clicks} click${clicks === 1 ? "" : "s"}`,
    wallet ? `wallet ${wallet.name} \`${wallet.address}\`` : context.wallets.length ? `wallets detected: ${context.wallets.join(", ")} · not connected` : "no wallet extension detected",
    errors.length ? `${errors.length} error${errors.length === 1 ? "" : "s"} · last: ${errors[errors.length - 1]!.label}` : null,
  ].filter(Boolean).join("\n");

  const offsetHours = -context.timezoneOffset / 60;
  const fields: Field[] = [
    { name: "👤 Identity", value: `\`${session.visitorId.replace(/-/g, "").slice(0, 8)}\` · ${visit}`, inline: true },
    { name: "🎯 Stage", value: stage, inline: true },
    { name: "🧭 Source", value: describeSource(context) },
    { name: "📍 Location (IP)", value: location },
    { name: "📊 Engagement", value: engagement },
    {
      name: "💻 Device",
      value: [
        `${device.browser} on ${device.os} (${device.deviceType})${device.inApp ? ` · ${device.inApp}` : ""}`,
        `${context.platform} · ${context.hardwareConcurrency ?? "?"} cores · ${context.touchPoints} touch`,
        `${context.screen} / ${context.viewport} · ${context.devicePixelRatio}x`,
      ].join("\n"),
      inline: true,
    },
    {
      name: "🌐 Locale",
      value: [
        context.languages.slice(0, 4).join(", "),
        `${context.timezone} (UTC${offsetHours >= 0 ? "+" : ""}${offsetHours})`,
        `${context.colorScheme} · ${context.network}${context.doNotTrack === "1" ? " · DNT" : ""}`,
      ].join("\n"),
      inline: true,
    },
  ];
  if (cls.reasons.length > 0) fields.push({ name: `🚩 Signals (score ${cls.score})`, value: cls.reasons.map((reason) => `• ${reason}`).join("\n") });
  fields.push({ name: "User agent", value: context.userAgent || "unknown" });
  fields.push({
    name: `📈 Today (${today.day}, since last deploy)`,
    value: `${today.visitors.size} visitor${today.visitors.size === 1 ? "" : "s"} · ${today.humans.size} human · ${today.sessions} sessions · ${today.wallets.size} wallet${today.wallets.size === 1 ? "" : "s"} connected`,
  });

  return {
    title: clip(`${kind} · ${visit}${place ? ` · ${place}` : ""}`, 250),
    description: trace(events) || undefined,
    color,
    fields: fields.map((field) => ({ ...field, value: clip(field.value || "unknown") })),
    footer: { text: `${session.host} · session ${session.sessionId.replace(/-/g, "").slice(0, 8)}${human ? "" : " · bot"}` },
    timestamp: new Date(session.lastSeen).toISOString(),
  };
}

async function send(embed: Embed, messageId: string | null): Promise<string | null> {
  const url = webhookUrl();
  if (!url) return null;
  const body = JSON.stringify({ username: "Kadex", embeds: [embed], allowed_mentions: { parse: [] } });
  const headers = { "Content-Type": "application/json" };
  try {
    if (messageId) {
      const edited = await fetch(`${url}/messages/${messageId}`, { method: "PATCH", headers, body });
      if (edited.ok || edited.status === 429) return messageId;
    }
    const created = await fetch(`${url}?wait=true`, { method: "POST", headers, body });
    if (!created.ok) return messageId;
    return ((await created.json()) as { id?: string }).id ?? null;
  } catch {
    return messageId;
  }
}

function prune(now: number): void {
  for (const [id, session] of sessions) if (now - session.lastSeen > SESSION_TTL_MS) sessions.delete(id);
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
}

export async function recordBatch(batch: VisitorBatch, headers: Headers): Promise<void> {
  const now = Date.now();
  let session = sessions.get(batch.sessionId);
  if (!session) {
    prune(now);
    session = {
      sessionId: batch.sessionId,
      visitorId: batch.visitorId,
      visitCount: batch.visitCount,
      isNewVisitor: batch.isNewVisitor,
      context: batch.context,
      geo: await lookupGeo(clientIp(headers)),
      host: headers.get("x-forwarded-host") ?? headers.get("host") ?? "kadex",
      events: [],
      activeSeconds: 0,
      firstSeen: now - (batch.events[batch.events.length - 1]?.at ?? 0) * 1000,
      lastSeen: now,
      messageId: null,
      work: Promise.resolve(),
    };
    const existing = sessions.get(batch.sessionId);
    if (existing) session = existing;
    else {
      sessions.set(batch.sessionId, session);
      dayStats().sessions += 1;
    }
  }

  session.context = { ...batch.context, landing: session.context.landing, referrer: session.context.referrer };
  session.activeSeconds = Math.max(session.activeSeconds, batch.activeSeconds);
  session.lastSeen = now;
  session.events = [...session.events, ...batch.events].slice(-MAX_EVENTS);

  const today = dayStats();
  today.visitors.add(session.visitorId);
  if (!classify(session.context, session.geo).isBot) today.humans.add(session.visitorId);
  const wallet = walletOf(session.events);
  if (wallet) today.wallets.add(wallet.address);

  const current = session;
  current.work = current.work.then(async () => {
    current.messageId = await send(buildEmbed(current), current.messageId);
  });
  await current.work;
}

export async function notifySharePreview(headers: Headers, path: string): Promise<void> {
  if (!isConfigured()) return;
  const userAgent = headers.get("user-agent") ?? "";
  const ip = clientIp(headers);
  const key = `${ip}|${userAgent}`;
  const now = Date.now();
  if (now - (previewSeen.get(key) ?? 0) < PREVIEW_DEDUPE_MS) return;
  if (previewSeen.size > 1_000) previewSeen.clear();
  previewSeen.set(key, now);

  const device = parseUserAgent(userAgent);
  const geo = await lookupGeo(ip);
  const kind = device.socialCrawler ? `🔗 ${device.socialCrawler}` : device.isBot ? "🤖 Bot" : "🧑 Human";
  await send(
    {
      title: `${kind} · share cover fetched`,
      color: device.socialCrawler ? COLOR_CRAWLER : device.isBot ? COLOR_BOT : COLOR_HUMAN,
      fields: [
        { name: "What this means", value: device.socialCrawler ? "Someone pasted a Kadex link there and the preview card was built." : "The cover image was opened directly." },
        { name: "📍 Location (IP)", value: clip([[geo.city, geo.region, geo.country].filter(Boolean).join(", ") || "unknown", geo.isp, geo.ip ? `\`${geo.ip}\`` : null].filter(Boolean).join("\n")) },
        { name: "Referrer", value: clip(headers.get("referer") || "(none)"), inline: true },
        { name: "Image", value: path, inline: true },
        { name: "User agent", value: clip(userAgent || "unknown") },
      ],
      footer: { text: headers.get("x-forwarded-host") ?? headers.get("host") ?? "kadex" },
      timestamp: new Date(now).toISOString(),
    },
    null,
  );
}
