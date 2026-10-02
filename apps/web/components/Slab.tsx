/**
 * A graded card in its acrylic case.
 *
 * The artwork is drawn rather than loaded: there are no real card images in
 * the repository, and a stock NFT thumbnail would undo the whole visual
 * argument. Three compositions in archival pigments — vermilion, bone, ink,
 * oxidised gold — so the row reads as a curated set rather than a grid of
 * tokens.
 *
 * Every mark is deterministic. Nothing animates, nothing randomises: a
 * collectible that redraws itself differently on each load is not an object.
 */

import type { Constituent } from "@/lib/market";

const INK = "#1b1a18";
const BONE = "#e8e0cd";
const VERMILION = "#c0392b";
const GOLD = "#b08b3f";
const FOREST = "#1f3b33";

function Sun() {
  return (
    <svg viewBox="0 0 100 140" role="img" aria-label="Archival artwork: sun over a mountain range" style={{ display: "block", width: "100%", height: "100%" }}>
      <rect width="100" height="140" fill="#e9dfc8" />
      {/* hairline rules, the way a printed plate carries its register marks */}
      {[22, 26, 30, 34].map((x) => (
        <line key={x} x1={x} y1="8" x2={x} y2="132" stroke={GOLD} strokeWidth="0.4" opacity="0.5" />
      ))}
      <circle cx="54" cy="46" r="23" fill={VERMILION} opacity="0.88" />
      <circle cx="54" cy="46" r="23" fill="none" stroke={INK} strokeWidth="0.5" opacity="0.3" />
      <path d="M0 140 L26 78 L44 108 L62 68 L100 140 Z" fill={INK} />
      <path d="M26 78 L34 96 L44 90 Z" fill={BONE} opacity="0.55" />
      <path d="M62 68 L72 90 L82 82 Z" fill={BONE} opacity="0.4" />
      <rect width="100" height="140" fill="none" stroke={INK} strokeWidth="1.5" opacity="0.2" />
    </svg>
  );
}

function Orbit() {
  return (
    <svg viewBox="0 0 100 140" role="img" aria-label="Archival artwork: concentric orbits on a dark field" style={{ display: "block", width: "100%", height: "100%" }}>
      <rect width="100" height="140" fill={FOREST} />
      <circle cx="50" cy="52" r="24" fill={GOLD} opacity="0.75" />
      <circle cx="50" cy="52" r="24" fill="none" stroke={BONE} strokeWidth="0.5" opacity="0.5" />
      <circle cx="50" cy="104" r="26" fill="none" stroke={BONE} strokeWidth="0.7" opacity="0.65" />
      <path d="M24 104 A26 26 0 0 0 76 104 Z" fill={BONE} opacity="0.82" />
      <line x1="14" y1="78" x2="86" y2="78" stroke={GOLD} strokeWidth="0.6" opacity="0.7" />
      <path d="M32 78 L50 92 L68 78" fill="none" stroke={GOLD} strokeWidth="0.6" opacity="0.7" />
      <ellipse cx="50" cy="78" rx="30" ry="7" fill="none" stroke={GOLD} strokeWidth="0.5" opacity="0.5" />
      <rect width="100" height="140" fill="none" stroke={BONE} strokeWidth="1" opacity="0.25" />
    </svg>
  );
}

function Blocks() {
  return (
    <svg viewBox="0 0 100 140" role="img" aria-label="Archival artwork: vermilion and bone colour fields" style={{ display: "block", width: "100%", height: "100%" }}>
      <rect width="100" height="140" fill="#ded3b8" />
      <rect x="8" y="8" width="34" height="86" fill={VERMILION} opacity="0.9" />
      <rect x="8" y="94" width="34" height="38" fill={INK} />
      <rect x="42" y="8" width="26" height="124" fill={BONE} opacity="0.75" />
      <path d="M68 132 L68 8 L92 70 Z" fill={GOLD} opacity="0.62" />
      <circle cx="80" cy="30" r="8" fill={INK} />
      <line x1="42" y1="8" x2="42" y2="132" stroke={INK} strokeWidth="0.5" opacity="0.35" />
      <rect width="100" height="140" fill="none" stroke={INK} strokeWidth="1.5" opacity="0.2" />
    </svg>
  );
}

const ART = { sun: Sun, orbit: Orbit, blocks: Blocks };

/** A deterministic barcode: same reference, same bars, every render. */
function Barcode({ seed }: { seed: string }) {
  const bars = Array.from({ length: 34 }, (_, i) => {
    const c = seed.charCodeAt(i % seed.length) + i * 7;
    return 5 + (c % 9);
  });
  return (
    <div className="barcode" aria-hidden="true">
      {bars.map((h, i) => (
        <span key={i} style={{ height: `${h}px`, opacity: i % 3 === 0 ? 0.55 : 1 }} />
      ))}
    </div>
  );
}

export function Slab({ item }: { item: Constituent }) {
  const Art = ART[item.art];
  return (
    <figure className="slab" style={{ margin: 0 }}>
      <div className="slab-label">
        <span className="brand">
          SLAB<i aria-hidden="true" />
        </span>
        <span className="ref">#{item.id}</span>
        <span className="meta">{item.name.toUpperCase()}</span>
        <span className="grade">{item.grade.split(" ").slice(0, -1).join(" ")}</span>
        <span className="meta">ARCHIVAL EDITION</span>
        <span className="grade">{item.grade.split(" ").slice(-1)}</span>
        <Barcode seed={item.ref} />
        <span className="ref" style={{ alignSelf: "end" }}>
          {item.ref}
        </span>
      </div>
      <div className="slab-art">
        <Art />
      </div>
    </figure>
  );
}
