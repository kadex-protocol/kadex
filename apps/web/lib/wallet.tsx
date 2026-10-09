"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey, Transaction } from "@solana/web3.js";

const REMEMBER_KEY = "kadex.wallet";
const INSTALL_URL = "https://phantom.app/download";

interface StandardAccount {
  address: string;
  publicKey: Uint8Array;
}

interface StandardWallet {
  name: string;
  icon: string;
  accounts: readonly StandardAccount[];
  features: Record<string, unknown>;
}

interface ConnectFeature {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly StandardAccount[] }>;
}
interface DisconnectFeature {
  disconnect(): Promise<void>;
}
interface SignTransactionFeature {
  signTransaction(input: { account: StandardAccount; transaction: Uint8Array }): Promise<{ signedTransaction: Uint8Array }[]>;
}

interface InjectedProvider {
  publicKey?: { toBytes(): Uint8Array } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toBytes(): Uint8Array } }>;
  disconnect(): Promise<void>;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

interface Adapter {
  name: string;
  icon: string | null;
  connect(silent: boolean): Promise<PublicKey | null>;
  disconnect(): Promise<void>;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

function standardAdapter(wallet: StandardWallet): Adapter {
  let account: StandardAccount | null = null;
  const feature = <T,>(name: string) => wallet.features[name] as T | undefined;
  return {
    name: wallet.name,
    icon: wallet.icon,
    async connect(silent) {
      const { accounts } = await feature<ConnectFeature>("standard:connect")!.connect(silent ? { silent: true } : undefined);
      account = accounts[0] ?? wallet.accounts[0] ?? null;
      return account ? new PublicKey(account.publicKey) : null;
    },
    async disconnect() {
      account = null;
      await feature<DisconnectFeature>("standard:disconnect")?.disconnect();
    },
    async signTransaction(tx) {
      if (!account) throw new Error("No wallet connected.");
      const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      const [signed] = await feature<SignTransactionFeature>("solana:signTransaction")!.signTransaction({
        account,
        transaction: new Uint8Array(bytes),
      });
      if (!signed) throw new Error("The wallet returned no signature.");
      return Transaction.from(signed.signedTransaction);
    },
  };
}

function injectedAdapter(provider: InjectedProvider): Adapter {
  return {
    name: "Browser wallet",
    icon: null,
    async connect(silent) {
      const result = await provider.connect(silent ? { onlyIfTrusted: true } : undefined);
      return new PublicKey(result.publicKey.toBytes());
    },
    disconnect: () => provider.disconnect(),
    signTransaction: (tx) => provider.signTransaction(tx),
  };
}

const usable = (wallet: StandardWallet) =>
  "standard:connect" in wallet.features && "solana:signTransaction" in wallet.features;

function injectedProvider(): InjectedProvider | null {
  const w = window as unknown as { solana?: InjectedProvider; phantom?: { solana?: InjectedProvider } };
  return w.phantom?.solana ?? w.solana ?? null;
}

function useAdapters(): Adapter[] {
  const [wallets, setWallets] = useState<StandardWallet[]>([]);
  const [legacy, setLegacy] = useState<InjectedProvider | null>(null);

  useEffect(() => {
    const seen = new Set<StandardWallet>();
    const api = {
      register(...incoming: StandardWallet[]) {
        for (const wallet of incoming) seen.add(wallet);
        setWallets([...seen].filter(usable));
        return () => {};
      },
    };
    const onRegister = (event: Event) => (event as CustomEvent<(api: unknown) => void>).detail(api);
    window.addEventListener("wallet-standard:register-wallet", onRegister);
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
    setLegacy(injectedProvider());
    return () => window.removeEventListener("wallet-standard:register-wallet", onRegister);
  }, []);

  return useMemo(() => {
    const standard = wallets.map(standardAdapter);
    return standard.length > 0 || !legacy ? standard : [injectedAdapter(legacy)];
  }, [wallets, legacy]);
}

type Status = "unsupported" | "disconnected" | "connecting" | "connected";

interface WalletState {
  status: Status;
  publicKey: PublicKey | null;
  walletName: string | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  signTransaction(tx: Transaction): Promise<Transaction>;
  error: string | null;
}

const Ctx = createContext<WalletState>({
  status: "disconnected",
  publicKey: null,
  walletName: null,
  connect: async () => {},
  disconnect: async () => {},
  signTransaction: async () => {
    throw new Error("No wallet connected.");
  },
  error: null,
});

const remembered = () => {
  try {
    return window.localStorage.getItem(REMEMBER_KEY);
  } catch {
    return null;
  }
};
const remember = (name: string | null) => {
  try {
    if (name) window.localStorage.setItem(REMEMBER_KEY, name);
    else window.localStorage.removeItem(REMEMBER_KEY);
  } catch {}
};

const benign = (message: string) => /reject|denied|cancel|closed/i.test(message);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const adapters = useAdapters();
  const [active, setActive] = useState<Adapter | null>(null);
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restored = useRef(false);

  const use = useCallback(async (adapter: Adapter, silent: boolean) => {
    setError(null);
    setPending(adapter.name);
    try {
      const key = await adapter.connect(silent);
      if (!key) return;
      setActive(adapter);
      setPublicKey(key);
      remember(adapter.name);
      setPicking(false);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Connection was rejected.";
      if (!silent && !benign(message)) setError(message);
    } finally {
      setPending(null);
    }
  }, []);

  useEffect(() => {
    if (restored.current || adapters.length === 0) return;
    const name = remembered();
    const adapter = adapters.find((a) => a.name === name);
    if (!adapter) return;
    restored.current = true;
    void use(adapter, true);
  }, [adapters, use]);

  const connect = useCallback(async () => {
    setError(null);
    const only = adapters.length === 1 ? adapters[0] : undefined;
    if (only) await use(only, false);
    else setPicking(true);
  }, [adapters, use]);

  const disconnect = useCallback(async () => {
    await active?.disconnect().catch(() => {});
    setActive(null);
    setPublicKey(null);
    remember(null);
  }, [active]);

  const signTransaction = useCallback(
    async (tx: Transaction) => {
      if (!active) throw new Error("No wallet connected.");
      return active.signTransaction(tx);
    },
    [active],
  );

  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPicking(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking]);

  const status: Status = publicKey ? "connected" : pending ? "connecting" : "disconnected";
  const value = useMemo(
    () => ({ status, publicKey, walletName: active?.name ?? null, connect, disconnect, signTransaction, error }),
    [status, publicKey, active, connect, disconnect, signTransaction, error],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {picking && (
        <div className="welcome-overlay" onClick={() => setPicking(false)}>
          <div className="welcome wconnect" role="dialog" aria-modal="true" aria-labelledby="wconnect-h" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="wconnect-x" aria-label="Close" onClick={() => setPicking(false)}>×</button>
            <h2 id="wconnect-h">Connect a wallet</h2>
            <p className="wconnect-sub">Your wallet holds your margin, your pool shares and your cards. Nothing moves without your signature.</p>

            {adapters.length > 0 ? (
              <ul className="wconnect-list">
                {adapters.map((adapter) => (
                  <li key={adapter.name}>
                    <button type="button" disabled={pending !== null} onClick={() => void use(adapter, false)}>
                      {adapter.icon ? <img src={adapter.icon} alt="" /> : <span className="wconnect-ico" aria-hidden="true" />}
                      <span>
                        <b>{adapter.name}</b>
                        <em>{pending === adapter.name ? "Approve in your wallet…" : "Detected"}</em>
                      </span>
                      <i aria-hidden="true">›</i>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="wconnect-list">
                <li>
                  <a href={INSTALL_URL} target="_blank" rel="noreferrer">
                    <span className="wconnect-ico" aria-hidden="true" />
                    <span>
                      <b>Install Phantom</b>
                      <em>No Solana wallet detected in this browser</em>
                    </span>
                    <i aria-hidden="true">↗</i>
                  </a>
                </li>
              </ul>
            )}

            {error && <p className="hint bad" role="alert">{error}</p>}
            <p className="wconnect-foot">Self-custody · Solana</p>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

export const useWallet = () => useContext(Ctx);

export const shortKey = (k: PublicKey) => {
  const s = k.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};
