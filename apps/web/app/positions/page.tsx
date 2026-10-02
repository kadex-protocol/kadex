"use client";

/**
 * Positions.
 *
 * Three states, all of them real: no wallet, a wallet with nothing open, and a
 * table. The empty state is not a placeholder for a table that exists
 * elsewhere — until the programs are deployed it is the correct answer, and it
 * says so rather than inventing rows.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import type { PositionView } from "@slab/types";
import { useWallet, shortKey } from "@/lib/wallet";
import { loadPositions, fmtPrice, fmtUsd } from "@/lib/market";

export default function PositionsPage() {
  const { status, publicKey, connect } = useWallet();
  const [rows, setRows] = useState<PositionView[] | null>(null);

  useEffect(() => {
    let live = true;
    setRows(null);
    loadPositions(publicKey).then((r) => {
      if (live) setRows(r);
    });
    return () => {
      live = false;
    };
  }, [publicKey]);

  const connected = status === "connected" && publicKey !== null;

  return (
    <div className="columns">
      <main className="main-col">
        <p className="eyebrow">03 / Positions</p>
        <h1 className="display">Your book.</h1>
        <p className="standfirst">Open exposure, margin and the price that closes you out.</p>

        <div style={{ marginTop: 30 }}>
          {!connected ? (
            <div className="empty">
              <p>No wallet connected.</p>
              <p className="fineprint" style={{ marginBottom: 16 }}>
                Positions are read from the chain against your address.
              </p>
              <button className="ghost" onClick={() => void connect()} disabled={status === "connecting"}>
                {status === "connecting" ? "Connecting…" : "Connect wallet"}
              </button>
            </div>
          ) : rows === null ? (
            <div className="empty">
              <p>Reading positions…</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="empty">
              <p>No open positions for {shortKey(publicKey)}.</p>
              <p className="fineprint" style={{ marginBottom: 16 }}>
                The programs are not deployed to this cluster yet, so there is nothing to read.
              </p>
              <Link href="/" className="link-action">
                Go to the market&nbsp;→
              </Link>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="ledger">
                <thead>
                  <tr>
                    <th scope="col">Direction</th>
                    <th scope="col" className="num">Size</th>
                    <th scope="col" className="num">Margin</th>
                    <th scope="col" className="num">Entry</th>
                    <th scope="col" className="num">Liquidation</th>
                    <th scope="col" className="num">PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p, i) => (
                    <tr key={i}>
                      <td className={p.side === "long" ? "dir-long" : "dir-short"}>
                        {p.side === "long" ? "Long" : "Short"}
                      </td>
                      <td className="num">{fmtUsd(p.notional)}</td>
                      <td className="num">{fmtUsd(p.margin, 2)}</td>
                      <td className="num">{fmtPrice(p.entryPrice)}</td>
                      <td className="num">—</td>
                      <td className="num">—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      <div className="side-col">
        <aside className="ticket">
          <p className="eyebrow" style={{ margin: 0 }}>Risk / notes</p>
          <div>
            <h2>Two roles</h2>
            <p className="subhead">They are not the same product</p>
          </div>

          <p className="body">
            <b>Index trader.</b> You take directional exposure to the basket. Your margin is at
            risk and the position closes automatically if the index moves against you far enough.
          </p>

          <p className="body">
            <b>Liquidity provider.</b> You are the other side of those trades. You earn trading
            fees and you lose when traders are collectively right.
          </p>

          <hr className="rule" />

          <p className="body">
            Providing liquidity to the card pool itself is a third thing again. If a card&rsquo;s
            price moves sharply in either direction you will hold less of the winning side than if
            you had simply kept your cards. Swap fees are what you are paid for that.
          </p>

          <p className="fineprint">
            A card doubling costs a pool provider roughly 5.7% against holding it outright.
          </p>
        </aside>
      </div>
    </div>
  );
}
