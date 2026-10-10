"use client";

import { BRAND } from "@/lib/brand";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet, shortKey } from "@/lib/wallet";
import { fmtUsd, IS_SAMPLE, loadBalances } from "@/lib/market";
import { LEDGER_EVENT } from "@/lib/sim";
import { UiSwitch } from "@/components/UiSwitch";
import { WelcomeDialog } from "@/components/WelcomeDialog";

/**
 * Four destinations, each named for what you do there. Anything that is
 * reference rather than action (the index methodology) is linked from the
 * page it explains instead of competing for a slot here.
 */
const NAV = [
  { href: "/", label: "Trade", match: ["/", "/index-methodology"], icon: "M7 3v4m0 8v6M5 7h4v8H5zM17 3v2m0 10v6M15 5h4v10h-4z" },
  { href: "/pool", label: "Earn", match: ["/pool"], icon: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM9 15l6-6M9.3 9.3h.01M14.7 14.7h.01" },
  { href: "/vault", label: "Vault", match: ["/vault"], icon: "M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9.5 6.5h5M9 10h6v7.5H9z" },
  { href: "/portfolio", label: "Portfolio", match: ["/portfolio"], icon: "M4 8.5A2.5 2.5 0 0 1 6.5 6H17v3M4 8.5V17a2 2 0 0 0 2 2h14V9H6.5A2.5 2.5 0 0 1 4 8.5zM16.5 14h.01" },
];

const isCurrent = (match: string[], path: string) => match.some((m) => m === path || (m !== "/" && path.startsWith(`${m}/`)));

const FAN_PIVOT = { x: 720, y: 2470 };
const FAN_RADIUS = 2400;
const FAN_STEP_DEG = 3;
const FAN_SLABS = Array.from({ length: 13 }, (_, i) => (i - 6) * FAN_STEP_DEG);

export function WalletButton({ className = "btn" }: { className?: string }) {
  const { status, publicKey, walletName, connect, disconnect } = useWallet();
  const connected = status === "connected" && publicKey;
  return (
    <button
      className={connected ? "chip key" : className}
      onClick={() => void (connected ? disconnect() : connect())}
      disabled={status === "connecting"}
      title={connected ? "Disconnect" : undefined}
    >
      {connected && walletName !== "Phantom" ? (
        <span className="avatar" aria-hidden="true" />
      ) : (
        <img className="wallet-ico" src="/wallets/phantom.svg" alt="" width={20} height={20} />
      )}
      {status === "connecting" ? "Connecting…" : connected ? shortKey(publicKey) : "Connect wallet"}
    </button>
  );
}

export function Frame({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { status, publicKey } = useWallet();
  const [notice, setNotice] = useState(IS_SAMPLE);
  const [usdc, setUsdc] = useState<bigint | null>(null);
  const connected = status === "connected" && publicKey !== null;

  useEffect(() => {
    let live = true;
    const read = () => void loadBalances(publicKey).then((b) => live && setUsdc(b.usdc));
    read();
    window.addEventListener(LEDGER_EVENT, read);
    return () => {
      live = false;
      window.removeEventListener(LEDGER_EVENT, read);
    };
  }, [publicKey]);

  return (
    <div className="app">
      {notice && (
        <p className="notice">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.3" />
            <path d="M8 7.2v3.6M8 5.1v.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="notice-full">
            Preview on a simulated ledger kept in this browser. Nothing is signed or settled on-chain yet.{" "}
            <Link href="/index-methodology">See how the index works</Link>.
          </span>
          <span className="notice-short">
            Simulated preview. <Link href="/index-methodology">How it works</Link>
          </span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(false)}>✕</button>
        </p>
      )}
      <header className="top">
        <Link href="/" className="brand" aria-label={`${BRAND}, home`}>
          <span className="star" aria-hidden="true" />
          {BRAND}
        </Link>

        <nav aria-label="Main" className="tabs-nav">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={isCurrent(n.match, path) ? "page" : undefined}>
              <svg className="nav-ico" viewBox="0 0 24 24" aria-hidden="true"><path d={n.icon} /></svg>
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="top-right">
          <Link href="/pool" className="chip opt">Deposit</Link>
          <Link href="/pool" className="chip opt">Withdraw</Link>
          {connected && <span className="chip num">{usdc !== null ? fmtUsd(usdc, 2) : "-"} $</span>}
          <WalletButton className="btn accent" />
          <UiSwitch />
        </div>
      </header>

      <main className="main">{children}</main>
      <WelcomeDialog />

      <footer className="foot">
        <svg className="foot-slabs" viewBox="0 0 1440 320" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
          {FAN_SLABS.map((deg) => (
            <g key={deg} transform={`rotate(${deg} ${FAN_PIVOT.x} ${FAN_PIVOT.y}) translate(${FAN_PIVOT.x} ${FAN_PIVOT.y - FAN_RADIUS})`}>
              <rect className="case" x="-85" y="0" width="170" height="286" rx="12" />
              <rect className="part" x="-73" y="12" width="146" height="44" rx="4" />
              <path className="part" d="M-63 28 H-5 M-63 40 H-25" />
              <rect className="part" x="45" y="20" width="20" height="28" rx="3" />
              <rect className="part" x="-73" y="66" width="146" height="206" rx="6" />
              <image className="mark" href="/logo.png" x="-38" y="131" width="76" height="76" />
            </g>
          ))}
        </svg>

        <div className="foot-in">
          <div className="foot-brand">
            <Link href="/" className="brand" aria-label={`${BRAND}, home`}>
              <span className="star" aria-hidden="true" />
              {BRAND}
            </Link>
            <p>© 2026 {BRAND} · Built on Solana</p>
            <p className="fine">
              {IS_SAMPLE
                ? "Concept preview. Balances and trades are simulated in this browser; nothing is signed or settled."
                : "Trading perpetuals carries risk of total loss of margin."}
            </p>
          </div>

          <nav className="foot-links" aria-label="Footer">
            <div>
              <h4>Pages</h4>
              {NAV.map((n) => (
                <Link key={n.href} href={n.href}>{n.label}</Link>
              ))}
            </div>
            <div>
              <h4>Resources</h4>
              <Link href="/index-methodology">Index methodology</Link>
              <Link href="/pool">How the pool works</Link>
              <Link href="/vault">How vaulting works</Link>
              <a href="https://collectorcrypt.com" target="_blank" rel="noreferrer">Collector Crypt ↗</a>
              <a href="https://solana.com" target="_blank" rel="noreferrer">Solana ↗</a>
            </div>
          </nav>
        </div>
      </footer>
    </div>
  );
}
