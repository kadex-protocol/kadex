"use client";

/**
 * The trading ticket.
 *
 * Shaped like an instrument slip rather than a form: the instrument is named
 * at the top, the methodology sits under it, and the controls are the last
 * thing rather than the first.
 *
 * Nothing here pretends a trade happened. With no wallet it asks for one; with
 * a wallet it says plainly that settlement needs the programs deployed. A
 * button that reports success it cannot verify is worse than one that admits
 * what it cannot do.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import type { Side } from "@slab/types";
import { useWallet } from "@/lib/wallet";
import { fmtPrice, fmtUsd, quote, type MarketSnapshot } from "@/lib/market";

export function TradeTicket({ snapshot }: { snapshot: MarketSnapshot }) {
  const { status, publicKey, connect, error } = useWallet();
  const [side, setSide] = useState<Side>("long");
  const [amount, setAmount] = useState("");

  const notional = useMemo(() => {
    const n = Number(amount.replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return BigInt(Math.trunc(n * 1e6));
  }, [amount]);

  const q = useMemo(() => quote(snapshot, side, notional), [snapshot, side, notional]);
  const connected = status === "connected" && publicKey !== null;
  const hasAmount = notional > 0n;
  const blocked = q.problem !== null;

  return (
    <aside className="ticket" aria-labelledby="ticket-heading">
      <p className="eyebrow" style={{ margin: 0 }}>
        Index / 001
      </p>

      <div>
        <h2 id="ticket-heading">SLAB Index</h2>
        <p className="subhead">Composition &amp; methodology</p>
      </div>

      <p className="body">Explore the collection behind the market.</p>
      <p className="body">
        The SLAB Index provides perpetual exposure to a curated basket of tokenized collectible
        cards, selected for cultural significance, liquidity and long-term relevance.
      </p>

      <Link href="/index-methodology" className="link-action">
        Inspect index&nbsp;→
      </Link>

      <hr className="rule" />

      <h3 className="section-title">Trade the index</h3>

      <div className="segmented" role="group" aria-label="Position direction">
        <button
          type="button"
          className="long"
          aria-pressed={side === "long"}
          onClick={() => setSide("long")}
        >
          Long
        </button>
        <button
          type="button"
          className="short"
          aria-pressed={side === "short"}
          onClick={() => setSide("short")}
        >
          Short
        </button>
      </div>

      <div className="field">
        <label htmlFor="amount">Amount · USDC</label>
        <input
          id="amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="—"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ""))}
          aria-describedby="amount-help"
        />
        <p id="amount-help" className={`helper${blocked && hasAmount ? " warn" : ""}`}>
          {!connected
            ? "Connect a wallet to continue"
            : blocked && hasAmount
              ? q.problem
              : hasAmount
                ? `Margin ${fmtUsd(q.margin)} USDC at ${Number(snapshot.pool.params.baseLeverage) / 1e6}× · fee ${fmtUsd(q.fee, 2)}`
                : "Enter a notional to see margin and liquidation"}
        </p>
      </div>

      {hasAmount && (
        <div className="readout">
          <div>
            <span>Entry price</span>
            <b>{fmtPrice(q.entryPrice)}</b>
          </div>
          <div>
            <span>Liquidation</span>
            <b>{fmtPrice(q.liquidationPrice)}</b>
          </div>
          <div>
            <span>Borrow / hour</span>
            <b>{(Number(side === "long" ? snapshot.borrow.long : snapshot.borrow.short) / 1e6 * 100).toFixed(4)}%</b>
          </div>
          <div>
            <span>Capacity left</span>
            <b>{fmtUsd(snapshot.capacity.free)}</b>
          </div>
        </div>
      )}

      {connected ? (
        <button className="primary" disabled={!hasAmount || blocked} title={q.problem ?? undefined}>
          {hasAmount ? `Open ${side}` : "Enter an amount"}
        </button>
      ) : (
        <button className="primary" onClick={() => void connect()} disabled={status === "connecting"}>
          {status === "connecting" ? "Connecting…" : "Connect wallet"}
        </button>
      )}

      {error && (
        <p className="helper warn" role="alert">
          {error}
        </p>
      )}

      <p className="fineprint">
        {connected
          ? "Order routing requires the programs to be deployed. Nothing is signed or settled here yet."
          : "Visual concept only"}
      </p>
    </aside>
  );
}
