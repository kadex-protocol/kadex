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
import { loadMarket, type MarketSnapshot } from "./market";

export interface MarketQuery {
  data: MarketSnapshot | null;
  loading: boolean;
  error: string | null;
}

export function useMarket(): MarketQuery {
  const [state, setState] = useState<MarketQuery>({ data: null, loading: true, error: null });

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
  }, []);

  return state;
}
