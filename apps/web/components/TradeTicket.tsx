"use client";

/**
 * The trade ticket.
 *
 * Two additions that come straight out of docs/users.md:
 *
 *   ROLE 5, the arbitrageur. Both borrow rates and the spread between them are
 *   always on screen. The ticket used to show only the selected side's rate,
 *   which made the spread invisible — and the spread is the only number an
 *   arbitrageur trades on. `psi` widens that gap precisely to pull them in
 *   when the book is one-sided; hiding it meant paying for a mechanism with
 *   no audience.
 *
 *   ROLE 4, the dealer hedging stock. "Short" reads as betting against the
 *   hobby. "Protect inventory" reads as prudence, and it is the same trade.
 *   Hedge mode sizes in inventory value rather than notional and leads with
 *   the monthly cost, because that is the premium being decided on.
 *
 * Nothing here pretends to trade. A button reporting success it cannot verify
 * is worse than one admitting what it cannot do.
 */

import { useMemo, useState } from "react";
import type { Side } from "@slab/types";
import { useWallet } from "@/lib/wallet";
import { borrowSpread, fmtPrice, fmtUsd, quote, type MarketSnapshot } from "@/lib/market";

type Mode = "speculate" | "hedge";

export function TradeTicket({ snapshot }: { snapshot: MarketSnapshot }) {
  const { status, publicKey, connect, error } = useWallet();
  const [mode, setMode] = useState<Mode>("speculate");
  const [side, setSide] = useState<Side>("long");
  const [amount, setAmount] = useState("");
  const [coverPct, setCoverPct] = useState(60);

  const spread = useMemo(() => borrowSpread(snapshot), [snapshot]);
  const connected = status === "connected" && publicKey !== null;

  const typed = useMemo(() => {
    const n = Number(amount.replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return BigInt(Math.trunc(n * 1e6));
  }, [amount]);

  // In hedge mode the number typed is inventory value; the position is the
  // slice of it being covered, and it is always a short.
  const effectiveSide: Side = mode === "hedge" ? "short" : side;
  const notional = mode === "hedge" ? (typed * BigInt(coverPct)) / 100n : typed;

  const q = useMemo(
    () => quote(snapshot, effectiveSide, notional),
    [snapshot, effectiveSide, notional],
  );

  const hasAmount = notional > 0n;
  const blocked = q.problem !== null;

  // What the cover costs per month, which is the number a dealer decides on.
  const monthlyCost =
    (notional * BigInt(Math.round(spread[effectiveSide === "long" ? "longMonthly" : "shortMonthly"] * 1e6))) /
    1_000_000n;

  return (
    <aside className="panel ticket" aria-labelledby="ticket-h">
      <div className="seg" role="group" aria-label="What you are doing">
        <button type="button" aria-pressed={mode === "speculate"} onClick={() => setMode("speculate")}>
          Speculate
        </button>
        <button type="button" aria-pressed={mode === "hedge"} onClick={() => setMode("hedge")}>
          Hedge stock
        </button>
      </div>

      <div>
        <p className="kicker" style={{ margin: 0 }}>
          {mode === "hedge" ? "Inventory cover" : "SLAB Index / 001"}
        </p>
        <h2 className="title" id="ticket-h" style={{ marginTop: 8 }}>
          {mode === "hedge" ? "Protect your stock" : "Trade the index"}
        </h2>
        <p className="sub">
          {mode === "hedge"
            ? "If the market falls you lose on the shelf and gain here. That is the trade."
            : "Long or short perpetual exposure to the basket."}
        </p>
      </div>

      {mode === "speculate" && (
        <div className="seg" role="group" aria-label="Direction">
          <button type="button" className="l" aria-pressed={side === "long"} onClick={() => setSide("long")}>
            Long
          </button>
          <button type="button" className="s" aria-pressed={side === "short"} onClick={() => setSide("short")}>
            Short
          </button>
        </div>
      )}

      <label className="field">
        <span>{mode === "hedge" ? "Inventory value · USDC" : "Amount · USDC"}</span>
        <input
          inputMode="decimal"
          autoComplete="off"
          placeholder="—"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ""))}
        />
      </label>

      {mode === "hedge" && (
        <label className="field">
          <span>Cover · {coverPct}% of inventory</span>
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={coverPct}
            onChange={(e) => setCoverPct(Number(e.target.value))}
            style={{ padding: 0, border: "none", background: "transparent", accentColor: "var(--ember)" }}
          />
        </label>
      )}

      <p className={`hint${blocked && hasAmount ? " bad" : ""}`} style={{ marginTop: -6 }}>
        {!connected
          ? "Connect a wallet to continue"
          : blocked && hasAmount
            ? q.problem
            : hasAmount
              ? `Margin ${fmtUsd(q.margin, 2)} USDC · fee ${fmtUsd(q.fee, 2)}`
              : mode === "hedge"
                ? "Enter what your stock is worth"
                : "Enter a notional to see margin and liquidation"}
      </p>

      {hasAmount && (
        <>
          <hr className="sep" />
          <div className="rows">
            {mode === "hedge" && (
              <>
                <div>
                  <span>Position opened</span>
                  <b>Short {fmtUsd(notional)} USDC</b>
                </div>
                <div className="hi">
                  <span>Cost of cover</span>
                  <b>{fmtUsd(monthlyCost, 2)} / month</b>
                </div>
              </>
            )}
            <div>
              <span>Entry price</span>
              <b>{fmtPrice(q.entryPrice)}</b>
            </div>
            <div>
              <span>Liquidation</span>
              <b>{fmtPrice(q.liquidationPrice)}</b>
            </div>
          </div>
        </>
      )}

      <hr className="sep" />

      {/* Role 5. Always visible, amount or no amount. */}
      <div>
        <p className="kicker" style={{ margin: "0 0 11px" }}>
          Borrow · per month
        </p>
        <div className="rows">
          <div>
            <span>
              <span className="dot" style={{ background: "var(--up)" }} />
              Long
            </span>
            <b className={spread.crowded === "long" ? "down" : undefined}>
              {spread.longMonthly.toFixed(2)}%
            </b>
          </div>
          <div>
            <span>
              <span className="dot" style={{ background: "var(--down)" }} />
              Short
            </span>
            <b className={spread.crowded === "short" ? "down" : undefined}>
              {spread.shortMonthly.toFixed(2)}%
            </b>
          </div>
          <div className="hi">
            <span>Spread</span>
            <b>{spread.spread.toFixed(2)}%</b>
          </div>
        </div>
        {spread.spread > 0.5 && (
          <p className="hint">
            The book is {spread.crowded}. Taking the {spread.paidSide} side is paid{" "}
            {spread.spread.toFixed(2)}% a month to balance it.
          </p>
        )}
      </div>

      <hr className="sep" />

      <div className="rows">
        <div>
          <span>Capacity left</span>
          <b>{fmtUsd(snapshot.capacity.free)} USDC</b>
        </div>
        <div>
          <span>Binding limit</span>
          <b>{snapshot.capacity.binding}</b>
        </div>
      </div>

      {connected ? (
        <button className="btn block" disabled={!hasAmount || blocked} title={q.problem ?? undefined}>
          {hasAmount
            ? mode === "hedge"
              ? "Open cover"
              : `Open ${effectiveSide}`
            : "Enter an amount"}
        </button>
      ) : (
        <button className="btn block" onClick={() => void connect()} disabled={status === "connecting"}>
          {status === "connecting" ? "Connecting…" : "Connect wallet"}
        </button>
      )}

      {error && (
        <p className="hint bad" role="alert">
          {error}
        </p>
      )}

      <p className="fine">
        {connected
          ? "Order routing requires the programs to be deployed. Nothing is signed or settled here yet."
          : "Visual concept only"}
      </p>
    </aside>
  );
}
