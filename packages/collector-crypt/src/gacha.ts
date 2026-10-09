/**
 * Collector Crypt gacha: machines and their stock.
 *
 * A different host and a different auth from the marketplace API in
 * `index.ts`. The keyed endpoints (`/api/v1/*`) return the key holder's own
 * machines; the public ones return the house machines only. The key goes out
 * as `x-api-key` — the marketplace's `Authorization: Bearer` is not read here.
 *
 * The key is a secret: read on the server only, never in the browser.
 *
 * Amounts come as JSON numbers in dollars, EV with float noise
 * (54.86571367572274), so they are rounded to the nearest native USDC unit
 * once, here, and everything downstream stays BigInt.
 */

export const GACHA_API = "https://gacha.collectorcrypt.com";
export const GACHA_TIERS = ["common", "uncommon", "rare", "epic"] as const;
export type GachaTier = (typeof GACHA_TIERS)[number];

/** Whose machines: the key holder's (`/api/v1`, needs a key) or the house's (public). */
export type GachaScope = "mine" | "house";

export interface GachaOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Defaults to `COLLECTOR_CRYPT_GACHA_API_KEY`. */
  apiKey?: string;
  /** Defaults to "mine" with a key and "house" without one. */
  scope?: GachaScope;
}

export interface TierCount {
  remaining: number;
  /** Below the low-stock buffer. Null when the endpoint does not say. */
  low: boolean | null;
}

export interface GachaMachine {
  code: string;
  name: string;
  shortName: string;
  category: string | null;
  /** Price of one pull, native USDC. */
  priceUsdc: bigint;
  /** Cards per pull. */
  contains: number;
  /** Percent of a card's value paid on instant buyback. */
  instantBuybackPct: number;
  /** Expected value of one pull, native USDC. */
  evUsdc: bigint;
  fixedEv: boolean;
  public: boolean;
  isPartner: boolean;
  /** Wallet of a partner machine's owner; null for house machines. */
  owner: string | null;
  lowThreshold: number;
  odds: Record<GachaTier, number>;
  /** Value range a card in each tier falls in, native USDC. */
  tierRanges: Record<GachaTier, { startUsdc: bigint; endUsdc: bigint }>;
  stock: Record<GachaTier, TierCount>;
  /** Live status. Only the keyed endpoint reports it; null otherwise. */
  enabled: boolean | null;
  /** Any other boolean the endpoint sets (low, sells, …), kept as sent. */
  flags: Record<string, boolean>;
}

export interface GachaMachines {
  scope: GachaScope;
  machines: GachaMachine[];
  rejected: { code: string; reason: string }[];
}

export interface GachaStock {
  scope: GachaScope;
  /** Machine code → per-tier stock. */
  byMachine: Record<string, Record<GachaTier, TierCount>>;
  rejected: { code: string; reason: string }[];
}

export const gachaApiKeyFromEnv = (): string | undefined =>
  (typeof process !== "undefined" && process.env.COLLECTOR_CRYPT_GACHA_API_KEY?.trim()) || undefined;

type Raw = Record<string, unknown>;
const isRecord = (x: unknown): x is Raw => typeof x === "object" && x !== null && !Array.isArray(x);

/** Dollars as a JSON number → native USDC, rounded once to the nearest unit. */
export function usdcFromDollars(value: unknown, field: string): bigint {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} is not a dollar amount: ${JSON.stringify(value)}`);
  }
  return BigInt(Math.round(value * 1_000_000));
}

const str = (raw: Raw, key: string): string => {
  const v = raw[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`${key} is missing`);
  return v;
};
const num = (raw: Raw, key: string): number => {
  const v = raw[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${key} is not a number`);
  return v;
};
const optionalStr = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function perTier<T>(raw: unknown, field: string, read: (v: unknown, tier: GachaTier) => T): Record<GachaTier, T> {
  if (!isRecord(raw)) throw new Error(`${field} is missing`);
  const out = {} as Record<GachaTier, T>;
  for (const tier of GACHA_TIERS) out[tier] = read(raw[tier], tier);
  return out;
}

/**
 * One tier's stock. The public endpoint sends a bare count; the keyed one
 * adds the low-stock buffer, so an object with a count and a flag is read too.
 */
export function parseTierCount(v: unknown, where: string): TierCount {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return { remaining: v, low: null };
  if (isRecord(v)) {
    const count = [v.remaining, v.stock, v.count, v.qty, v.quantity].find((x) => typeof x === "number");
    const low = [v.low, v.isLow, v.lowStock, v.belowBuffer].find((x) => typeof x === "boolean");
    if (typeof count === "number" && Number.isInteger(count) && count >= 0) {
      return { remaining: count, low: typeof low === "boolean" ? low : null };
    }
  }
  throw new Error(`stock for ${where} is not a count: ${JSON.stringify(v)}`);
}

const KNOWN = new Set(["public", "isPartner", "adoptable", "freeSpins", "turboMode", "fixedEv", "enabled"]);

export function parseMachine(raw: unknown): GachaMachine {
  if (!isRecord(raw)) throw new Error("machine is not an object");
  const flags: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "boolean" && !KNOWN.has(k)) flags[k] = v;
  return {
    code: str(raw, "code"),
    name: str(raw, "name"),
    shortName: optionalStr(raw.shortName) ?? str(raw, "name"),
    category: optionalStr(raw.menuCategory),
    priceUsdc: usdcFromDollars(raw.price, "price"),
    contains: num(raw, "contains"),
    instantBuybackPct: num(raw, "instantBuyback"),
    evUsdc: usdcFromDollars(raw.ev, "ev"),
    fixedEv: raw.fixedEv === true,
    public: raw.public === true,
    isPartner: raw.isPartner === true,
    owner: optionalStr(raw.owner),
    lowThreshold: typeof raw.lowThreshold === "number" ? raw.lowThreshold : 0,
    odds: perTier(raw.odds, "odds", (v, tier) => {
      if (typeof v !== "number" || v < 0 || v > 1) throw new Error(`odds.${tier} is not a probability`);
      return v;
    }),
    tierRanges: perTier(raw.tierRanges, "tierRanges", (v, tier) => {
      if (!isRecord(v)) throw new Error(`tierRanges.${tier} is missing`);
      return { startUsdc: usdcFromDollars(v.start, `tierRanges.${tier}.start`), endUsdc: usdcFromDollars(v.end, `tierRanges.${tier}.end`) };
    }),
    stock: perTier(raw.stock, "stock", (v, tier) => parseTierCount(v, tier)),
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : null,
    flags,
  };
}

function resolve(opts: GachaOptions) {
  const apiKey = opts.apiKey ?? gachaApiKeyFromEnv();
  const scope: GachaScope = opts.scope ?? (apiKey ? "mine" : "house");
  if (scope === "mine" && !apiKey) {
    throw new Error("Your gacha machines need COLLECTOR_CRYPT_GACHA_API_KEY; without it only the house machines are readable.");
  }
  return { apiKey, scope };
}

async function getGacha(resource: "machines" | "stock", opts: GachaOptions): Promise<{ scope: GachaScope; body: unknown }> {
  const { apiKey, scope } = resolve(opts);
  const path = scope === "mine" ? `/api/v1/${resource}` : `/api/${resource}`;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const res = await doFetch(`${opts.baseUrl ?? GACHA_API}${path}`, {
    headers: { accept: "application/json", ...(scope === "mine" && apiKey ? { "x-api-key": apiKey } : {}) },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Collector Crypt gacha ${path} refused the API key (${res.status}). Check COLLECTOR_CRYPT_GACHA_API_KEY.`);
  }
  if (!res.ok) throw new Error(`Collector Crypt gacha ${path} answered ${res.status}`);
  return { scope, body: await res.json() };
}

/** Every machine the scope can see. A malformed machine is reported, not fatal. */
export async function fetchGachaMachines(opts: GachaOptions = {}): Promise<GachaMachines> {
  const { scope, body } = await getGacha("machines", opts);
  const list = isRecord(body) && Array.isArray(body.machines) ? body.machines : Array.isArray(body) ? body : null;
  if (!list) throw new Error("Collector Crypt gacha /machines changed shape: machines is missing");
  const machines: GachaMachine[] = [];
  const rejected: GachaMachines["rejected"] = [];
  for (const item of list) {
    try {
      machines.push(parseMachine(item));
    } catch (e) {
      rejected.push({ code: isRecord(item) && typeof item.code === "string" ? item.code : "?", reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { scope, machines, rejected };
}

/** Stock remaining per machine and tier. */
export async function fetchGachaStock(opts: GachaOptions = {}): Promise<GachaStock> {
  const { scope, body } = await getGacha("stock", opts);
  const map = isRecord(body) && isRecord(body.stock) ? body.stock : body;
  if (!isRecord(map)) throw new Error("Collector Crypt gacha /stock changed shape: not an object of machines");
  const byMachine: GachaStock["byMachine"] = {};
  const rejected: GachaStock["rejected"] = [];
  for (const [code, tiers] of Object.entries(map)) {
    try {
      byMachine[code] = perTier(tiers, code, (v, tier) => parseTierCount(v, `${code}.${tier}`));
    } catch (e) {
      rejected.push({ code, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { scope, byMachine, rejected };
}
