"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet, shortKey } from "@/lib/wallet";
import { IS_SAMPLE } from "@/lib/market";

const NAV = [
  { href: "/", label: "Home" },
  { href: "/market", label: "Market" },
  { href: "/index-methodology", label: "Index" },
  { href: "/pool", label: "Pool" },
  { href: "/vault", label: "Vault" },
  { href: "/portfolio", label: "Portfolio" },
];

function WalletButton() {
  const { status, publicKey, connect, disconnect } = useWallet();
  const connected = status === "connected" && publicKey;
  return (
    <button
      className="btn"
      onClick={() => void (connected ? disconnect() : connect())}
      disabled={status === "connecting"}
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
      <aside className="side">
        <Link href="/" className="brand" aria-label="SLAB, home">
          <span className="star" aria-hidden="true" />
          SLAB
        </Link>

        <nav aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={path === n.href ? "page" : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="side-foot">
          <WalletButton />
          <span className="built">
            Built on
            <b>SOLANA</b>
          </span>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          {IS_SAMPLE && <span className="sample-flag">Concept preview · sample data</span>}
          <WalletButton />
        </div>
        {children}
      </div>
    </div>
  );
}
