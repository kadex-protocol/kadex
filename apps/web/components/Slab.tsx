/**
 * A graded card in its acrylic case.
 *
 * The artwork is photographic, cropped from the project's own reference
 * renders. The case, certification label and barcode around it are drawn, so
 * the image only ever has to supply the card face — which is what makes the
 * crops reusable at any size.
 *
 * Deterministic: the barcode is derived from the reference string, so the same
 * card renders identically every time. A collectible that redraws itself
 * differently on each load is not an object.
 */

import type { Constituent } from "@/lib/market";

export type ArtKey = "charizard" | "pikachu" | "jordan" | "lotus" | "luke";

/** Same reference, same bars, every render. */
function bars(seed: string, n: number) {
  return Array.from({ length: n }, (_, i) => 3 + ((seed.charCodeAt(i % seed.length) + i * 7) % 5));
}

export function Slab({ item }: { item: Constituent }) {
  const parts = item.grade.split(" ");
  const grade = parts.slice(0, -1).join(" ");
  const num = parts[parts.length - 1];

  return (
    <figure className="slab-case" style={{ margin: 0 }}>
      <div className="slab-cert">
        <span>
          {item.year} {item.series.toUpperCase()}
        </span>
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
        <img src={`/cards/${item.art}.jpg`} alt={`${item.name}, graded ${item.grade}`} loading="lazy" />
      </div>
    </figure>
  );
}

/** The small square used inside tables. */
export function Thumb({ art, alt = "" }: { art: ArtKey; alt?: string }) {
  return (
    <span className="thumb">
      <img src={`/cards/${art}.jpg`} alt={alt} loading="lazy" />
    </span>
  );
}
