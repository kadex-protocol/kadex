"use client";

import { useState } from "react";
import type { PositionView } from "@kadex/types";
import { fmtPrice, fmtUsd } from "@/lib/market";
import { closePosition } from "@/lib/actions";
import { explainTxError } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";

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
      <table className="t">
        <thead>
          <tr>
            <th>Side</th>
            <th className="r">Size</th>
            <th className="r">Margin</th>
            <th className="r">Entry</th>
            <th className="r">Mark</th>
            <th className="r">Liq. price</th>
            <th className="r">PnL</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const net = p.pnl - p.borrowOwed;
            const key = p.address.toBase58();
            return (
              <tr key={key}>
                <td><span className={`pill ${p.side}`}>{p.side}</span></td>
                <td className="r n">${fmtUsd(p.notional, 2)}</td>
                <td className="r n">${fmtUsd(p.margin, 2)}</td>
                <td className="r n">{fmtPrice(p.entryPrice)}</td>
                <td className="r n">{markPrice !== null ? fmtPrice(markPrice) : "-"}</td>
                <td className="r n">{fmtPrice(p.liquidationPrice)}</td>
                <td className={`r n ${net >= 0n ? "up" : "down"}`}>{net >= 0n ? "+" : "−"}${fmtUsd(net >= 0n ? net : -net, 2)}</td>
                <td className="r">
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
