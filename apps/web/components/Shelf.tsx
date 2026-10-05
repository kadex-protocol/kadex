import { CONSTITUENTS } from "@/lib/market";
import { Slab } from "./Slab";

/** The five constituents on a plinth, as objects in a lit case. */
export function Shelf({ count = 5 }: { count?: number }) {
  return (
    <div className="hero-art">
      <div className="shelf">
        {CONSTITUENTS.slice(0, count).map((c) => (
          <Slab key={c.id} item={c} />
        ))}
      </div>
      <div className="plinth" />
    </div>
  );
}
