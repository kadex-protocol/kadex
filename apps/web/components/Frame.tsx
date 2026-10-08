"use client";

import { BRAND } from "@/lib/brand";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet, shortKey } from "@/lib/wallet";
import { fmtUsd, IS_SAMPLE, loadBalances } from "@/lib/market";
import { UiSwitch } from "@/components/UiSwitch";
import { WelcomeDialog } from "@/components/WelcomeDialog";

/**
 * Four destinations, each named for what you do there. Anything that is
 * reference rather than action (the index methodology) is linked from the
 * page it explains instead of competing for a slot here.
 */
const NAV = [
  { href: "/", label: "Trade", match: ["/", "/index-methodology"] },
  { href: "/pool", label: "Earn", match: ["/pool"] },
  { href: "/vault", label: "Vault", match: ["/vault"] },
  { href: "/portfolio", label: "Portfolio", match: ["/portfolio"] },
];

const FAN_PIVOT = { x: 720, y: 2470 };
const FAN_RADIUS = 2400;
const FAN_STEP_DEG = 3;
const FAN_SLABS = Array.from({ length: 13 }, (_, i) => (i - 6) * FAN_STEP_DEG);
const STAR = "M0 -17 L4.5 -4.5 L17 0 L4.5 4.5 L0 17 L-4.5 4.5 L-17 0 L-4.5 -4.5 Z";

export function WalletButton({ className = "btn" }: { className?: string }) {
  const { status, publicKey, connect, disconnect } = useWallet();
  const connected = status === "connected" && publicKey;
  return (
    <button
      className={connected ? "chip key" : className}
      onClick={() => void (connected ? disconnect() : connect())}
      disabled={status === "connecting"}
      title={connected ? "Disconnect" : undefined}
    >
      {connected ? (
        <span className="avatar" aria-hidden="true" />
      ) : (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1.5" y="3.5" width="13" height="10" rx="2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M11 8.5h1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
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
    loadBalances(publicKey).then((b) => live && setUsdc(b.usdc));
    return () => {
      live = false;
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
          <span>
            Preview on sample data. Nothing is signed or settled yet.{" "}
            <Link href="/index-methodology">See how the index works</Link>.
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
            <Link key={n.href} href={n.href} aria-current={n.match.includes(path) ? "page" : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="top-right">
          <Link href="/pool" className="chip opt">Deposit</Link>
          <Link href="/pool" className="chip opt">Withdraw</Link>
          {connected && <span className="chip num">{usdc !== null ? fmtUsd(usdc, 2) : "—"} $</span>}
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
              <path className="mark" d={STAR} transform="translate(0 169)" />
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
                ? "Concept preview. Figures are sample data; nothing is signed or settled."
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
