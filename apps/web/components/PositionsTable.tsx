"use client";

import { useState } from "react";
import type { PositionView } from "@kadex/types";
import { fmtPrice, fmtUsd } from "@/lib/market";
import { closePosition } from "@/lib/actions";
import { explainTxError } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";

const COLUMNS = {
  side: "Side",
  size: "Size",
  margin: "Margin",
  entry: "Entry",
  mark: "Mark",
  liquidation: "Liq. price",
  pnl: "PnL",
};

export function PositionsTable({ positions, markPrice, onClosed }: { positions: PositionView[]; markPrice: bigint | null; onClosed(): void }) {
  const { publicKey, signTransaction } = useWallet();
  const [closing, setClosing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const close = async (position: PositionView) => {
    if (!publicKey) return;
    setClosing(position.address.toBase58());
    setError(null);
    try {
      await closePosition({ publicKey, sign: signTransaction }, position.address);
      onClosed();
    } catch (e) {
      setError(explainTxError(e));
    } finally {
      setClosing(null);
    }
  };

  return (
    <div className="t-wrap pos-table">
      <table className="t" role="table" aria-label="Open positions">
        <thead role="rowgroup">
          <tr role="row">
            <th>{COLUMNS.side}</th>
            <th className="r">{COLUMNS.size}</th>
            <th className="r">{COLUMNS.margin}</th>
            <th className="r">{COLUMNS.entry}</th>
            <th className="r">{COLUMNS.mark}</th>
            <th className="r">{COLUMNS.liquidation}</th>
            <th className="r">{COLUMNS.pnl}</th>
            <th><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {positions.map((p) => {
            const net = p.pnl - p.borrowOwed;
            const key = p.address.toBase58();
            return (
              <tr key={key} role="row">
                <td role="cell" data-label={COLUMNS.side}><span className={`pill ${p.side}`}>{p.side}</span></td>
                <td role="cell" data-label={COLUMNS.size} className="r n">${fmtUsd(p.notional, 2)}</td>
                <td role="cell" data-label={COLUMNS.margin} className="r n">${fmtUsd(p.margin, 2)}</td>
                <td role="cell" data-label={COLUMNS.entry} className="r n">{fmtPrice(p.entryPrice)}</td>
                <td role="cell" data-label={COLUMNS.mark} className="r n">{markPrice !== null ? fmtPrice(markPrice) : "-"}</td>
                <td role="cell" data-label={COLUMNS.liquidation} className="r n">{fmtPrice(p.liquidationPrice)}</td>
                <td role="cell" data-label={COLUMNS.pnl} className={`r n ${net >= 0n ? "up" : "down"}`}>{net >= 0n ? "+" : "−"}${fmtUsd(net >= 0n ? net : -net, 2)}</td>
                <td role="cell" className="r pos-actions">
                  <button type="button" className="btn" disabled={closing !== null} onClick={() => void close(p)}>
                    {closing === key ? "Closing…" : "Close"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error && <p className="hint bad" role="alert">{error}</p>}
    </div>
  );
}
