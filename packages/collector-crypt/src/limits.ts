/**
 * Staying inside Collector Crypt's limits: 300 requests a minute per IP
 * without a key, 3,000 with one. Responses say `cache-control: max-age=30`,
 * so a 30 s cache is the provider's own terms, not a guess.
 *
 * Opt-in through `ClientOptions.limits`: a process that talks to the API on a
 * schedule (the feed, the web routes) shares one `collectorCryptLimits()`.
 */

/** A token bucket: `take()` resolves when one request may go out. */
export interface RequestBudget {
  take(): Promise<void>;
}

export function requestBudget(perMinute: number, burst = Math.max(1, Math.floor(perMinute / 6))): RequestBudget {
  const perMs = perMinute / 60_000;
  let tokens = burst;
  let last = Date.now();
  let queue: Promise<void> = Promise.resolve();
  const refill = () => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + (now - last) * perMs);
    last = now;
  };
  return {
    take() {
      const turn = queue.then(async () => {
        refill();
        if (tokens < 1) {
          await new Promise((r) => setTimeout(r, Math.ceil((1 - tokens) / perMs)));
          refill();
        }
        tokens -= 1;
      });
      queue = turn;
      return turn;
    },
  };
}

/**
 * Parsed responses by key for `ttlMs`, and one request in flight per key: ten
 * callers asking for the same card at once cost one request. Failures are not
 * cached.
 */
export class JsonCache {
  private readonly entries = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(
    readonly ttlMs = 30_000,
    private readonly maxEntries = 5_000,
  ) {}

  get(key: string, load: () => Promise<unknown>): Promise<unknown> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = load();
    this.entries.set(key, { at: Date.now(), value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    if (this.entries.size > this.maxEntries) {
      for (const [k, e] of this.entries) if (Date.now() - e.at >= this.ttlMs) this.entries.delete(k);
      while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    }
    return value;
  }
}

export interface CollectorLimits {
  cache?: JsonCache;
  budget?: RequestBudget;
  /**
   * Retries on 429, any 5xx, a timeout or a network error, waiting
   * `Retry-After` (capped at `maxRetryAfterMs`) or 1 s, 2 s, 4 s.
   */
  retries?: number;
  /** Per attempt. A hung connection otherwise stalls the caller forever. */
  timeoutMs?: number;
  /** Longest `Retry-After` honoured; a larger one gives up instead. */
  maxRetryAfterMs?: number;
}

/** Applied whether or not `limits` is given. */
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;

/** Whether an HTTP status is worth asking again. */
export const isRetryableStatus = (status: number) => status === 429 || (status >= 500 && status <= 599);

let shared: CollectorLimits | null = null;

/** One cache and budget per process, sized to 80% of the documented limit. */
export function collectorCryptLimits(hasKey = Boolean(typeof process !== "undefined" && process.env.COLLECTOR_CRYPT_API_KEY)): CollectorLimits {
  shared ??= {
    cache: new JsonCache(30_000),
    budget: requestBudget(hasKey ? 2_400 : 240),
    retries: 3,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxRetryAfterMs: DEFAULT_MAX_RETRY_AFTER_MS,
  };
  return shared;
}

/** Runs `work` over `items` with at most `n` at a time, keeping order. */
export async function mapLimited<T, R>(items: readonly T[], n: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
  return out;
}
