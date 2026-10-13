"use client";

/**
 * Market data, read on the client.
 *
 * Deliberately a browser-side hook rather than a server component. A Solana
 * frontend reads accounts over RPC from the browser, with the user's wallet
 * and their endpoint — rendering this on the server would mean a second,
 * different data path that only exists in development, and `PublicKey` is a
 * class instance that cannot cross the server/client boundary anyway.
 *
 * So the loading and error states here are the real ones the app will use,
 * not placeholders.
 */

import { useEffect, useState } from "react";
import { IS_SAMPLE, loadMarket, type MarketSnapshot } from "./market";

const REFRESH_MS = IS_SAMPLE ? 5_000 : 10_000;
const FAILURES_BEFORE_ERROR = 3;

export interface MarketQuery {
  data: MarketSnapshot | null;
  loading: boolean;
  error: string | null;
  reload(): void;
}

type State = Omit<MarketQuery, "reload">;

// One poll for the whole page: each component that reads the market subscribes to it.
let state: State = { data: null, loading: true, error: null };
let timer: ReturnType<typeof setInterval> | null = null;
let reading = false;
let queued = false;
let failures = 0;
const listeners = new Set<(next: State) => void>();

function publish(next: State) {
  state = next;
  listeners.forEach((listener) => listener(next));
}

function reload() {
  if (reading) {
    queued = true;
    return;
  }
  reading = true;
  loadMarket()
    .then((data) => {
      failures = 0;
      publish({ data, loading: false, error: null });
    })
    .catch((e) => {
      failures += 1;
      // A rate-limited read is common on a public RPC; the last snapshot stays up until it keeps failing.
      if (state.data && failures < FAILURES_BEFORE_ERROR) return;
      publish({ data: null, loading: false, error: e instanceof Error ? e.message : "Could not read market state." });
    })
    .finally(() => {
      reading = false;
      if (queued) {
        queued = false;
        reload();
      }
    });
}

function subscribe(listener: (next: State) => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    reload();
    timer = setInterval(() => document.hidden || reload(), REFRESH_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useMarket(): MarketQuery {
  const [current, setCurrent] = useState(state);
  useEffect(() => {
    setCurrent(state);
    return subscribe(setCurrent);
  }, []);
  return { ...current, reload };
}
