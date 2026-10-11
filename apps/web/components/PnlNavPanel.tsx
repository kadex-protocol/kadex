import { fmtUsd, IS_SAMPLE, type MarketSnapshot, type Portfolio } from "@/lib/market";

const signed = (value: bigint) =>
  `${value < 0n ? "−" : "+"}$${fmtUsd(value < 0n ? -value : value, 2)}`;

export function PnlNavPanel({
  portfolio,
  snapshot,
}: {
  portfolio: Portfolio | null;
  snapshot: MarketSnapshot | null;
}) {
  const traderPnl = snapshot?.pool.traderPnl ?? 0n;

  return (
    <section className="stats" aria-label="Trader PnL and pool NAV" style={{ marginBottom: 20 }}>
      <div className="stat">
        <p className="k">Your open PnL</p>
        <p className={`v${portfolio ? (portfolio.totalPnl < 0n ? " down" : " up") : ""}`}>
          {portfolio ? signed(portfolio.totalPnl) : "—"}
        </p>
        <p className="d">After accrued borrow</p>
      </div>
      <div className="stat">
        <p className="k">Pool NAV</p>
        <p className="v">{snapshot ? `$${fmtUsd(snapshot.poolStats.nav, 2)}` : "—"}</p>
        <p className="d">{IS_SAMPLE ? "Sample market" : "Current pool value"}</p>
      </div>
      <div className="stat">
        <p className="k">{traderPnl < 0n ? "Traders owe pool" : "Pool owes traders"}</p>
        <p className="v">{snapshot ? `$${fmtUsd(traderPnl < 0n ? -traderPnl : traderPnl, 2)}` : "—"}</p>
        <p className="d">
          {traderPnl < 0n
            ? "Trader losses increase pool NAV only when realized"
            : "Unrealized trader gains reduce pool NAV"}
        </p>
      </div>
    </section>
  );
}
