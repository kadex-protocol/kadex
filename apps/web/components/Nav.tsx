"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet, shortKey } from "@/lib/wallet";
import { IS_SAMPLE } from "@/lib/market";

const LINKS = [
  { href: "/", label: "Market" },
  { href: "/index-methodology", label: "Index" },
  { href: "/positions", label: "Positions" },
];

export function Nav() {
  const path = usePathname();
  const { status, publicKey, connect, disconnect } = useWallet();

  return (
    <nav className="nav">
      <Link href="/" className="wordmark" aria-label="SLAB, home">
        SLAB<span className="glyph" aria-hidden="true" />
      </Link>

      <div className="nav-links">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="nav-link"
            aria-current={path === l.href ? "page" : undefined}
          >
            {l.label}
          </Link>
        ))}
      </div>

      <span className="nav-spacer" />

      {IS_SAMPLE && <span className="nav-note">Concept preview · sample content</span>}

      {status === "connected" && publicKey ? (
        <button className="ghost" onClick={() => void disconnect()}>
          {shortKey(publicKey)}
        </button>
      ) : (
        <button className="ghost" onClick={() => void connect()} disabled={status === "connecting"}>
          {status === "connecting" ? "Connecting…" : "Connect wallet"}
        </button>
      )}
    </nav>
  );
}
