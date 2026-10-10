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

import { useCallback, useEffect, useState } from "react";
import { IS_SAMPLE, loadMarket, type MarketSnapshot } from "./market";

const REFRESH_MS = IS_SAMPLE ? 5_000 : 10_000;

export interface MarketQuery {
  data: MarketSnapshot | null;
  loading: boolean;
  error: string | null;
  reload(): void;
}

export function useMarket(): MarketQuery {
  const [state, setState] = useState<Omit<MarketQuery, "reload">>({ data: null, loading: true, error: null });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    const timer = setInterval(() => document.hidden || reload(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  useEffect(() => {
    let live = true;
    loadMarket()
      .then((data) => live && setState({ data, loading: false, error: null }))
      .catch((e) =>
        live &&
        setState({
          data: null,
          loading: false,
          error: e instanceof Error ? e.message : "Could not read market state.",
        }),
      );
    return () => {
      live = false;
    };
  }, [version]);

  return { ...state, reload };
}
