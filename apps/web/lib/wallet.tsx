"use client";

/**
 * Minimal wallet connection over the injected provider.
 *
 * The repository had no wallet integration to reuse, and the brief says to
 * prefer existing dependencies. `@solana/wallet-adapter-react-ui` would bring
 * its own stylesheet and modal, which would fight the design for no gain at
 * this stage — Phantom, Solflare and Backpack all expose the same injected
 * interface, so this is enough to connect, read a public key and sign.
 *
 * Swap this file for the adapter when more than one wallet needs supporting.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";

interface InjectedProvider {
  isPhantom?: boolean;
  publicKey?: { toBytes(): Uint8Array } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toBytes(): Uint8Array } }>;
  disconnect(): Promise<void>;
  on?(event: string, handler: () => void): void;
}

type Status = "unsupported" | "disconnected" | "connecting" | "connected";

interface WalletState {
  status: Status;
  publicKey: PublicKey | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  error: string | null;
}

const Ctx = createContext<WalletState>({
  status: "disconnected",
  publicKey: null,
  connect: async () => {},
  disconnect: async () => {},
  error: null,
});

function injected(): InjectedProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { solana?: InjectedProvider; phantom?: { solana?: InjectedProvider } };
  return w.phantom?.solana ?? w.solana ?? null;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("disconnected");
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reconnect silently if this site was already trusted, so a refresh does not
  // look like a disconnection.
  useEffect(() => {
    const p = injected();
    if (!p) {
      setStatus("unsupported");
      return;
    }
    p.connect({ onlyIfTrusted: true })
      .then((r) => {
        setPublicKey(new PublicKey(r.publicKey.toBytes()));
        setStatus("connected");
      })
      .catch(() => setStatus("disconnected"));

    p.on?.("disconnect", () => {
      setPublicKey(null);
      setStatus("disconnected");
    });
  }, []);

  const connect = useCallback(async () => {
    const p = injected();
    if (!p) {
      setStatus("unsupported");
      setError("No Solana wallet found in this browser.");
      return;
    }
    setError(null);
    setStatus("connecting");
    try {
      const r = await p.connect();
      setPublicKey(new PublicKey(r.publicKey.toBytes()));
      setStatus("connected");
    } catch (e) {
      setStatus("disconnected");
      setError(e instanceof Error ? e.message : "Connection was rejected.");
    }
  }, []);

  const disconnect = useCallback(async () => {
    await injected()?.disconnect().catch(() => {});
    setPublicKey(null);
    setStatus("disconnected");
  }, []);

  const value = useMemo(
    () => ({ status, publicKey, connect, disconnect, error }),
    [status, publicKey, connect, disconnect, error],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useWallet = () => useContext(Ctx);

export const shortKey = (k: PublicKey) => {
  const s = k.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};
