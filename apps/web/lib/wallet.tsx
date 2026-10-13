"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { CLUSTER, TEST_FUNDS } from "./cluster";
import { requestTestFunds } from "./faucet";
import { ArrowIcon } from "@/components/ArrowIcon";

const REMEMBER_KEY = "kadex.wallet";
const DEMO_KEY = "kadex.demo.v1";
const INSTALL_URL = "https://phantom.app/download";
const TIP_KEY = "kadex.testnet-tip";
const TEST_NETWORK = CLUSTER && CLUSTER.network !== "mainnet" ? CLUSTER.network : null;
const CHAIN = CLUSTER ? `solana:${CLUSTER.network === "local" ? "localnet" : CLUSTER.network}` : undefined;
const TESTNET_STEPS = "Settings → Developer Settings → Testnet Mode";
const PHANTOM_ICON = "/wallets/phantom.svg";

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
  signTransaction(input: { account: StandardAccount; transaction: Uint8Array; chain?: string }): Promise<{ signedTransaction: Uint8Array }[]>;
}
interface EventsFeature {
  on(event: "change", listener: (event: { accounts?: readonly StandardAccount[] }) => void): () => void;
}

interface InjectedProvider {
  isPhantom?: boolean;
  publicKey?: { toBytes(): Uint8Array } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toBytes(): Uint8Array } }>;
  disconnect(): Promise<void>;
  signTransaction(tx: Transaction): Promise<Transaction>;
  on?(event: "accountChanged", listener: (key: { toBytes(): Uint8Array } | null) => void): void;
  off?(event: "accountChanged", listener: (key: { toBytes(): Uint8Array } | null) => void): void;
}

interface Adapter {
  name: string;
  icon: string | null;
  note?: string;
  connect(silent: boolean): Promise<PublicKey | null>;
  disconnect(): Promise<void>;
  signTransaction(tx: Transaction): Promise<Transaction>;
  onAccountChange?(listener: (key: PublicKey | null) => void): () => void;
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
        chain: CHAIN,
      });
      if (!signed) throw new Error("The wallet returned no signature.");
      return Transaction.from(signed.signedTransaction);
    },
    onAccountChange(listener) {
      return feature<EventsFeature>("standard:events")?.on("change", (event) => {
        account = event.accounts?.[0] ?? wallet.accounts[0] ?? null;
        listener(account ? new PublicKey(account.publicKey) : null);
      }) ?? (() => {});
    },
  };
}

function injectedAdapter(provider: InjectedProvider): Adapter {
  return {
    name: provider.isPhantom ? "Phantom" : "Browser wallet",
    icon: provider.isPhantom ? PHANTOM_ICON : null,
    async connect(silent) {
      const result = await provider.connect(silent ? { onlyIfTrusted: true } : undefined);
      return new PublicKey(result.publicKey.toBytes());
    },
    disconnect: () => provider.disconnect(),
    signTransaction: (tx) => provider.signTransaction(tx),
    onAccountChange(listener) {
      const changed = (key: { toBytes(): Uint8Array } | null) => listener(key ? new PublicKey(key.toBytes()) : null);
      provider.on?.("accountChanged", changed);
      return () => provider.off?.("accountChanged", changed);
    },
  };
}

function withFallback(primary: Adapter, fallback: Adapter): Adapter {
  let current = primary;
  return {
    name: primary.name,
    icon: primary.icon,
    async connect(silent) {
      current = primary;
      try {
        return await primary.connect(silent);
      } catch (e) {
        if (silent || benign(e instanceof Error ? e.message : "")) throw e;
        console.error("Wallet Standard connect failed, trying the injected provider:", e);
        current = fallback;
        return fallback.connect(false);
      }
    },
    disconnect: () => current.disconnect(),
    signTransaction: (tx) => current.signTransaction(tx),
    onAccountChange: (listener) => current.onAccountChange?.(listener) ?? (() => {}),
  };
}

function demoKeypair(): Keypair {
  try {
    const stored = window.localStorage.getItem(DEMO_KEY);
    if (stored) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(stored) as number[]));
  } catch {}
  const fresh = Keypair.generate();
  try {
    window.localStorage.setItem(DEMO_KEY, JSON.stringify([...fresh.secretKey]));
  } catch {}
  return fresh;
}

function demoAdapter(): Adapter {
  let keypair: Keypair | null = null;
  return {
    name: "Demo wallet",
    icon: null,
    note: CLUSTER ? `No extension needed · test funds on ${CLUSTER.network}` : "No extension needed · simulated funds",
    async connect() {
      keypair = demoKeypair();
      return keypair.publicKey;
    },
    async disconnect() {
      keypair = null;
    },
    async signTransaction(tx) {
      if (!keypair) throw new Error("No wallet connected.");
      tx.partialSign(keypair);
      return tx;
    },
  };
}

const DEMO = demoAdapter();

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
    const standard = wallets.map((wallet) => {
      const adapter = standardAdapter(wallet);
      return legacy?.isPhantom && wallet.name === "Phantom" ? withFallback(adapter, injectedAdapter(legacy)) : adapter;
    });
    const real = standard.length > 0 || !legacy ? standard : [injectedAdapter(legacy)];
    return TEST_FUNDS ? [...real, DEMO] : real;
  }, [wallets, legacy]);
}

type Status = "disconnected" | "connecting" | "connected";

interface WalletState {
  status: Status;
  publicKey: PublicKey | null;
  walletName: string | null;
  detected: string[];
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  signTransaction(tx: Transaction): Promise<Transaction>;
  error: string | null;
}

const Ctx = createContext<WalletState>({
  status: "disconnected",
  publicKey: null,
  walletName: null,
  detected: [],
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
const explain = (name: string, message: string) =>
  /unexpected error/i.test(message) ? `${name} could not open its approval window. Open the ${name} extension, unlock it and try again.` : message;

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const adapters = useAdapters();
  const [active, setActive] = useState<Adapter | null>(null);
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tipSeen, setTipSeen] = useState(true);
  const restored = useRef(false);
  const connection = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  const use = useCallback(async (adapter: Adapter, silent: boolean) => {
    const attempt = ++connection.current;
    setError(null);
    setPending(adapter.name);
    try {
      const key = await adapter.connect(silent);
      if (attempt !== connection.current || !key) return;
      setActive(adapter);
      setPublicKey(key);
      remember(adapter.name);
      setPicking(false);
      void requestTestFunds(key).then((reply) => {
        if (attempt === connection.current && reply.error) setError(reply.error);
      });
    } catch (e) {
      if (attempt !== connection.current) return;
      const message = e instanceof Error ? e.message : "Connection was rejected.";
      if (!silent && !benign(message)) setError(explain(adapter.name, message));
    } finally {
      if (attempt === connection.current) setPending(null);
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
    const only = adapters.length === 1 && adapters[0] !== DEMO ? adapters[0] : undefined;
    if (only) await use(only, false);
    else {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPicking(true);
    }
  }, [adapters, use]);

  const disconnect = useCallback(async () => {
    connection.current += 1;
    setPending(null);
    setActive(null);
    setPublicKey(null);
    remember(null);
    await active?.disconnect().catch(() => {});
  }, [active]);

  useEffect(() => {
    if (!active) return;
    return active.onAccountChange?.((key) => {
      connection.current += 1;
      setPending(null);
      setPublicKey(key);
      if (!key) {
        setActive(null);
        remember(null);
      }
    });
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
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPicking(false);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener.current?.focus();
      opener.current = null;
    };
  }, [picking]);

  useEffect(() => {
    try {
      setTipSeen(window.localStorage.getItem(TIP_KEY) === "1");
    } catch {
      setTipSeen(false);
    }
  }, []);

  const dismissTip = useCallback(() => {
    setTipSeen(true);
    try {
      window.localStorage.setItem(TIP_KEY, "1");
    } catch {}
  }, []);

  const showTip = TEST_NETWORK !== null && !tipSeen && publicKey !== null && active !== null && active !== DEMO;

  const status: Status = publicKey ? "connected" : pending ? "connecting" : "disconnected";
  const value = useMemo(
    () => ({
      status,
      publicKey,
      walletName: active?.name ?? null,
      detected: adapters.filter((adapter) => adapter !== DEMO).map((adapter) => adapter.name),
      connect,
      disconnect,
      signTransaction,
      error,
    }),
    [status, publicKey, active, adapters, connect, disconnect, signTransaction, error],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {picking && (
        <div className="welcome-overlay" onClick={() => setPicking(false)}>
          <div className="welcome wconnect" role="dialog" aria-modal="true" aria-labelledby="wconnect-h" onClick={(e) => e.stopPropagation()}>
            <button ref={closeButton} type="button" className="wconnect-x" aria-label="Close" onClick={() => setPicking(false)}>×</button>
            <h2 id="wconnect-h">Connect a wallet</h2>
            <p className="wconnect-sub">Your wallet holds your margin, your pool shares and your cards. Nothing moves without your signature.</p>

            <ul className="wconnect-list">
              {adapters.map((adapter) => (
                <li key={adapter.name}>
                  <button type="button" disabled={pending !== null} onClick={() => void use(adapter, false)}>
                    {adapter.icon ? <img src={adapter.icon} alt="" /> : <span className="wconnect-ico" aria-hidden="true" />}
                    <span>
                      <b>{adapter.name}</b>
                      <em>{pending === adapter.name ? "Approve in your wallet…" : adapter.note ?? "Detected"}</em>
                    </span>
                    <i aria-hidden="true">›</i>
                  </button>
                </li>
              ))}
              {adapters.every((adapter) => adapter === DEMO) && (
                <li>
                  <a href={INSTALL_URL} target="_blank" rel="noreferrer">
                    <img src={PHANTOM_ICON} alt="" />
                    <span>
                      <b>Install Phantom</b>
                      <em>No Solana wallet detected in this browser</em>
                    </span>
                    <i aria-hidden="true"><ArrowIcon direction="external" /></i>
                  </a>
                </li>
              )}
            </ul>

            {error && <p className="hint bad" role="alert">{error}</p>}
            {TEST_NETWORK && adapters.some((adapter) => adapter !== DEMO) && (
              <p className="hint">
                Using your own wallet on {TEST_NETWORK}? Turn on its test network first ({TESTNET_STEPS} in Phantom), or the wallet blocks the transaction as unsafe.
              </p>
            )}
            <p className="wconnect-foot">Self-custody · Solana</p>
          </div>
        </div>
      )}
      {showTip && (
        <aside className="wallet-tip" role="status">
          <p>
            <b>Turn on Testnet Mode in {active?.name ?? "your wallet"}.</b> Kadex runs on {TEST_NETWORK}. Without it the wallet checks each transaction against mainnet and blocks it as unsafe. In Phantom: {TESTNET_STEPS}.
          </p>
          <button type="button" className="btn" onClick={dismissTip}>Got it</button>
        </aside>
      )}
    </Ctx.Provider>
  );
}

export const useWallet = () => useContext(Ctx);

export const shortKey = (k: PublicKey) => {
  const s = k.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};
