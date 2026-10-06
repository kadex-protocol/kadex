"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet, shortKey } from "@/lib/wallet";
import { IS_SAMPLE } from "@/lib/market";

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

export function WalletButton({ className = "btn" }: { className?: string }) {
  const { status, publicKey, connect, disconnect } = useWallet();
  const connected = status === "connected" && publicKey;
  return (
    <button
      className={connected ? "btn" : className}
      onClick={() => void (connected ? disconnect() : connect())}
      disabled={status === "connecting"}
      title={connected ? "Disconnect" : undefined}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="1.5" y="3.5" width="13" height="10" rx="2" stroke="currentColor" strokeWidth="1.2" />
        <path d="M11 8.5h1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      {status === "connecting" ? "Connecting…" : connected ? shortKey(publicKey) : "Connect wallet"}
    </button>
  );
}

export function Frame({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <div className="app">
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
          {IS_SAMPLE && <span className="sample-flag">Preview · sample data</span>}
          <WalletButton className="btn accent" />
        </div>
      </header>

      <main className="main">{children}</main>

      <footer className="foot">
        <div className="foot-in">
          <div className="foot-brand">
            <Link href="/" className="brand" aria-label="SLAB, home">
              <span className="star" aria-hidden="true" />
              SLAB
            </Link>
            <p>Perpetual exposure to a curated index of tokenized collectibles.</p>
          </div>

          <nav className="foot-links" aria-label="Footer">
            <div>
              <h4>Use</h4>
              {NAV.map((n) => (
                <Link key={n.href} href={n.href}>{n.label}</Link>
              ))}
            </div>
            <div>
              <h4>Learn</h4>
              <Link href="/index-methodology">Index methodology</Link>
              <Link href="/pool">How the pool works</Link>
              <Link href="/vault">How vaulting works</Link>
            </div>
          </nav>
        </div>

        <div className="foot-bar">
          <span>Built on <b>Solana</b></span>
          <span>
            {IS_SAMPLE
              ? "Concept preview. Figures are sample data; nothing is signed or settled."
              : "Trading perpetuals carries risk of total loss of margin."}
          </span>
        </div>
      </footer>
    </div>
  );
}
