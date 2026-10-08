"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet, shortKey } from "@/lib/wallet";
import { fmtUsd, IS_SAMPLE, loadBalances } from "@/lib/market";
import { UiSwitch } from "@/components/UiSwitch";

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

const WAVE_R = 210;
const WAVE_COLS = 6;
const WAVE_ROWS = [0, 1, 2, 3];
const WAVE_RINGS = [0.86, 0.64, 0.42];

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
        <Link href="/" className="brand" aria-label="SLAB, home">
          <span className="star" aria-hidden="true" />
          SLAB
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

      <footer className="foot">
        <svg className="foot-waves" viewBox="0 0 1440 320" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
          {WAVE_ROWS.flatMap((row) =>
            Array.from({ length: WAVE_COLS }, (_, col) => {
              const cx = col * WAVE_R * 2 - WAVE_R * 2 + (row % 2 ? WAVE_R : 0);
              const cy = WAVE_R + 40 + row * (WAVE_R / 2);
              return (
                <g key={`${row}-${col}`}>
                  <circle className="disc" cx={cx} cy={cy} r={WAVE_R} />
                  {WAVE_RINGS.map((k) => (
                    <circle key={k} className="ring" cx={cx} cy={cy} r={WAVE_R * k} />
                  ))}
                </g>
              );
            }),
          )}
        </svg>

        <div className="foot-in">
          <div className="foot-brand">
            <Link href="/" className="brand" aria-label="SLAB, home">
              <span className="star" aria-hidden="true" />
              SLAB
            </Link>
            <p>© 2026 SLAB · Built on Solana</p>
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
