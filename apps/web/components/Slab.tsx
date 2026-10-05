/**
 * A graded card in its acrylic case.
 *
 * Drawn, not photographed. The reference mocks use real Pokemon, Magic and
 * Star Wars cards; shipping those would put third-party trademarks in the
 * repository, so the artwork here is original — archival pigments on dark
 * grounds, lit from the upper left as if under a vitrine lamp.
 *
 * To swap in real photography later, replace `<Art />` with an <img> inside
 * `.slab-win`. Nothing else has to change: the case, the certification label
 * and the barcode are all chrome around that one element.
 *
 * Every mark is deterministic. A collectible that redraws itself differently
 * on each load is not an object.
 */

import type { Constituent } from "@/lib/market";

const GOLD = "#b08b3f";
const BONE = "#ddd2bb";
const EMBER = "#b8452f";
const DEEP = "#14100d";

function Ascent() {
  return (
    <svg viewBox="0 0 100 140" role="img" aria-label="Archival artwork: sun above a ridge" style={{ display: "block", width: "100%", height: "100%" }}>
      <rect width="100" height="140" fill="#1d1813" />
      <circle cx="54" cy="44" r="22" fill={EMBER} opacity="0.85" />
      {[20, 24, 28].map((x) => (
        <line key={x} x1={x} y1="10" x2={x} y2="130" stroke={GOLD} strokeWidth="0.35" opacity="0.35" />
      ))}
      <path d="M0 140 L26 76 L44 106 L62 66 L100 140 Z" fill={DEEP} />
      <path d="M26 76 L34 94 L44 88 Z" fill={BONE} opacity="0.3" />
      <path d="M62 66 L72 88 L82 80 Z" fill={BONE} opacity="0.22" />
      <rect width="100" height="140" fill="none" stroke={GOLD} strokeWidth="1" opacity="0.22" />
    </svg>
  );
}

function Orbit() {
  return (
    <svg viewBox="0 0 100 140" role="img" aria-label="Archival artwork: orbits on a deep green field" style={{ display: "block", width: "100%", height: "100%" }}>
      <rect width="100" height="140" fill="#16241f" />
      <circle cx="50" cy="50" r="23" fill={GOLD} opacity="0.62" />
      <circle cx="50" cy="102" r="25" fill="none" stroke={BONE} strokeWidth="0.6" opacity="0.4" />
      <path d="M25 102 A25 25 0 0 0 75 102 Z" fill={BONE} opacity="0.55" />
      <line x1="14" y1="76" x2="86" y2="76" stroke={GOLD} strokeWidth="0.5" opacity="0.5" />
      <ellipse cx="50" cy="76" rx="29" ry="7" fill="none" stroke={GOLD} strokeWidth="0.45" opacity="0.35" />
      <rect width="100" height="140" fill="none" stroke={BONE} strokeWidth="1" opacity="0.14" />
    </svg>
  );
}

function Fields() {
  return (
    <svg viewBox="0 0 100 140" role="img" aria-label="Archival artwork: colour fields in ember and bone" style={{ display: "block", width: "100%", height: "100%" }}>
      <rect width="100" height="140" fill="#20190f" />
      <rect x="8" y="8" width="32" height="84" fill={EMBER} opacity="0.82" />
      <rect x="8" y="92" width="32" height="40" fill={DEEP} />
      <rect x="40" y="8" width="26" height="124" fill={BONE} opacity="0.5" />
      <path d="M66 132 L66 8 L92 70 Z" fill={GOLD} opacity="0.45" />
      <circle cx="80" cy="30" r="7" fill={DEEP} />
      <rect width="100" height="140" fill="none" stroke={GOLD} strokeWidth="1" opacity="0.2" />
    </svg>
  );
}

function Meridian() {
  return (
    <svg viewBox="0 0 100 140" role="img" aria-label="Archival artwork: a meridian arc" style={{ display: "block", width: "100%", height: "100%" }}>
      <rect width="100" height="140" fill="#101a24" />
      <path d="M0 140 Q50 40 100 140 Z" fill={BONE} opacity="0.22" />
      <circle cx="50" cy="52" r="18" fill="none" stroke={GOLD} strokeWidth="0.8" opacity="0.7" />
      <circle cx="50" cy="52" r="7" fill={EMBER} opacity="0.75" />
      <line x1="50" y1="6" x2="50" y2="132" stroke={GOLD} strokeWidth="0.35" opacity="0.4" />
      <rect width="100" height="140" fill="none" stroke={BONE} strokeWidth="1" opacity="0.14" />
    </svg>
  );
}

function Relic() {
  return (
    <svg viewBox="0 0 100 140" role="img" aria-label="Archival artwork: a standing relic form" style={{ display: "block", width: "100%", height: "100%" }}>
      <rect width="100" height="140" fill="#231a1a" />
      <rect x="34" y="26" width="32" height="88" rx="16" fill={GOLD} opacity="0.5" />
      <rect x="42" y="44" width="16" height="52" rx="8" fill={EMBER} opacity="0.7" />
      <rect x="20" y="114" width="60" height="7" fill={DEEP} />
      <rect width="100" height="140" fill="none" stroke={GOLD} strokeWidth="1" opacity="0.2" />
    </svg>
  );
}

const ART = { ascent: Ascent, orbit: Orbit, fields: Fields, meridian: Meridian, relic: Relic };
export type ArtKey = keyof typeof ART;

/** Same reference, same bars, every render. */
function bars(seed: string, n: number) {
  return Array.from({ length: n }, (_, i) => 3 + ((seed.charCodeAt(i % seed.length) + i * 7) % 5));
}

export function Slab({ item }: { item: Constituent }) {
  const Art = ART[item.art];
  const [grade, num] = [item.grade.split(" ").slice(0, -1).join(" "), item.grade.split(" ").slice(-1)[0]];
  return (
    <figure className="slab-case" style={{ margin: 0 }}>
      <div className="slab-cert">
        <span>{item.year} {item.series.toUpperCase()}</span>
        <span className="g">#{item.id}</span>
        <span>{item.name.toUpperCase()}</span>
        <span className="g">{grade}</span>
        <span className="bars" aria-hidden="true">
          {bars(item.ref, 26).map((h, i) => (
            <span key={i} style={{ height: `${h}px`, opacity: i % 3 === 0 ? 0.5 : 1 }} />
          ))}
        </span>
        <span className="g">{num}</span>
        <span style={{ gridColumn: "1 / -1", textAlign: "right" }}>{item.ref}</span>
      </div>
      <div className="slab-win">
        <Art />
      </div>
    </figure>
  );
}

/** The small square used inside tables. */
export function Thumb({ art }: { art: ArtKey }) {
  const Art = ART[art];
  return (
    <span className="thumb">
      <Art />
    </span>
  );
}
