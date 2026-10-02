import { Nav } from "./Nav";

export function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <div className="frame">
        <Nav />
        {children}
        <footer className="foot">
          <span className="mark">SLAB</span>
          <span>Built on Solana</span>
        </footer>
      </div>
      <p className="colophon">SLAB / Visual study 01 — Collector&rsquo;s exchange</p>
    </div>
  );
}
