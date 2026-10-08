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
 *   hobby. "Hedge" reads as prudence, and it is the same trade. It sits as a
 *   third tab beside Long and Short, sizes in inventory value rather than
 *   notional, and leads with the monthly cost — the premium being decided on.
 *
 * Nothing here pretends to trade. A button reporting success it cannot verify
 * is worse than one admitting what it cannot do.
 */

import { useEffect, useMemo, useState } from "react";
import type { Side } from "@slab/types";
import { useWallet } from "@/lib/wallet";
import { borrowSpread, fmtPrice, fmtUsd, loadBalances, quote, type Balances, type MarketSnapshot } from "@/lib/market";
import { CLUSTER } from "@/lib/cluster";
import { sendOpenPosition } from "@/lib/tradeTx";
import { explainTxError, shortSignature } from "@/lib/tx";

type Mode = "trade" | "hedge";

export function TradeTicket({ snapshot, onOpened }: { snapshot: MarketSnapshot; onOpened?(): void }) {
  const { status, publicKey, connect, signTransaction, error } = useWallet();
  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState<{ ok: boolean; text: string } | null>(null);
  const [balanceVersion, setBalanceVersion] = useState(0);
  const [mode, setMode] = useState<Mode>("trade");
  const [picked, setPicked] = useState<Side>("long");
  const [amount, setAmount] = useState("");
  const [coverPct, setCoverPct] = useState(60);
  const [balances, setBalances] = useState<Balances | null>(null);

  const spread = useMemo(() => borrowSpread(snapshot), [snapshot]);
  const connected = status === "connected" && publicKey !== null;
  const hedge = mode === "hedge";

  useEffect(() => { loadBalances(publicKey).then(setBalances).catch(() => setBalances(null)); }, [publicKey, balanceVersion]);

  const typed = useMemo(() => {
    const n = Number(amount.replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return BigInt(Math.trunc(n * 1e6));
  }, [amount]);

  // In hedge mode the number typed is inventory value; the position is the
  // slice of it being covered, and it is always a short.
  const side: Side = hedge ? "short" : picked;
  const notional = hedge ? (typed * BigInt(coverPct)) / 100n : typed;

  const q = useMemo(() => quote(snapshot, side, notional), [snapshot, side, notional]);

  const hasAmount = notional > 0n;
  const units = q.entryPrice > 0n ? (notional * 1_000_000n) / q.entryPrice : 0n;
  const blocked = q.problem !== null;
  const dash = (v: string) => (hasAmount ? v : "—");

  const cost = q.margin + q.fee;
  const short = connected && balances !== null && hasAmount && balances.usdc < cost;

  const submit = async () => {
    if (!publicKey) return;
    if (!CLUSTER) {
      setReceipt({ ok: false, text: "Preview only: no cluster is configured, so nothing was sent." });
      return;
    }
    setSending(true);
    setReceipt(null);
    try {
      const signature = await sendOpenPosition(CLUSTER, publicKey, signTransaction, { side, notional, margin: q.margin });
      setReceipt({ ok: true, text: `Position opened · ${shortSignature(signature)}` });
      setAmount("");
      setBalanceVersion((v) => v + 1);
      onOpened?.();
    } catch (e) {
      setReceipt({ ok: false, text: explainTxError(e) });
    } finally {
      setSending(false);
    }
  };

  // What the cover costs per month, which is the number a dealer decides on.
  const monthlyCost =
    (notional * BigInt(Math.round(spread[side === "long" ? "longMonthly" : "shortMonthly"] * 1e6))) / 1_000_000n;

  return (
    <aside className="panel ticket" aria-labelledby="ticket-h">
      <h2 className="sr-only" id="ticket-h">Open a position</h2>

      <p className="tk-mode">Isolated · {Number(snapshot.pool.params.baseLeverage) / 1e6}x</p>

      <div className="tabs" role="group" aria-label="Order type">
        <button type="button" aria-pressed={!hedge} onClick={() => setMode("trade")}>Trade</button>
        <button type="button" aria-pressed={hedge} onClick={() => setMode("hedge")}>Hedge</button>
      </div>

      <div className="seg big" role="group" aria-label="Side">
        <button type="button" className="l" aria-pressed={side === "long"} disabled={hedge} onClick={() => setPicked("long")}>Long</button>
        <button type="button" className="s" aria-pressed={side === "short"} onClick={() => setPicked("short")}>Short</button>
      </div>

      <p className="sub" style={{ margin: 0 }}>
        {hedge
          ? "Dealers: a short sized on your stock. If the market falls you lose on the shelf and gain here."
          : side === "long"
            ? "You profit if the index rises."
            : "You profit if the index falls."}
      </p>

      <div className="token-input big">
        <div className="ti-top">
          <span>{hedge ? "Inventory value" : "Order size"}</span>
          <span>Balance {connected && balances ? fmtUsd(balances.usdc, 2) : "—"}</span>
        </div>
        <div className="ti-row">
          <input
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            aria-label={hedge ? "Inventory value in USDC" : "Position size in USDC"}
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ""))}
          />
          <span className="tk-asset"><span className="coin usdc" aria-hidden="true">$</span>USDC</span>
        </div>
      </div>

      <span className="swap-arrow" aria-hidden="true">↓</span>

      <div className="token-input big out">
        <div className="ti-top">
          <span>{side === "long" ? "You go long" : "You go short"}</span>
          <span>@ {fmtPrice(q.entryPrice)}</span>
        </div>
        <div className="ti-row">
          <span className={`ti-out${hasAmount ? "" : " dim"}`}>{hasAmount ? fmtUsd(units, 2) : "0.00"}</span>
          <span className="tk-asset"><span className="coin" aria-hidden="true"><span className="star" /></span>Index</span>
        </div>
      </div>

      {hedge && (
        <label className="field">
          <span>Cover · {coverPct}% of inventory</span>
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={coverPct}
            onChange={(e) => setCoverPct(Number(e.target.value))}
            style={{ padding: 0, border: "none", background: "transparent", accentColor: "var(--ink)" }}
          />
        </label>
      )}

      <div className="tk-lev">
        <span>Leverage</span>
        <b>{Number(snapshot.pool.params.baseLeverage) / 1e6}x · fixed</b>
      </div>

      {blocked && hasAmount && <p className="hint bad" style={{ margin: 0 }}>{q.problem}</p>}
      {!blocked && short && (
        <p className="hint bad" style={{ margin: 0 }}>Needs {fmtUsd(cost, 2)} USDC for margin and fee; this wallet has {fmtUsd(balances.usdc, 2)}.</p>
      )}

      {connected ? (
        <button className="btn block" disabled={!hasAmount || blocked || short || sending} title={q.problem ?? undefined} onClick={() => void submit()}>
          {sending ? "Confirm in your wallet…" : !hasAmount ? "Enter an amount" : hedge ? "Open cover" : `Open ${side}`}
        </button>
      ) : (
        <button className="btn block" onClick={() => void connect()} disabled={status === "connecting"}>
          {status === "connecting" ? "Connecting…" : "Connect wallet to trade"}
        </button>
      )}

      {error && <p className="hint bad" role="alert" style={{ margin: 0 }}>{error}</p>}
      {receipt && <p className={`hint ${receipt.ok ? "good" : "bad"}`} role="status" style={{ margin: 0 }}>{receipt.text}</p>}

      <div className="rows tk-sum">
        <div className={hasAmount ? "hi" : undefined}><span>Est. liquidation price</span><b>{dash(fmtPrice(q.liquidationPrice))}</b></div>
        <div><span>Entry price</span><b>{dash(fmtPrice(q.entryPrice))}</b></div>
        <div><span>Order value</span><b>{dash(fmtUsd(notional, 2))}</b></div>
        {hedge && <div><span>Cost of cover</span><b>{dash(`${fmtUsd(monthlyCost, 2)} / month`)}</b></div>}
        <div><span>Margin required</span><b>{dash(fmtUsd(q.margin, 2))}</b></div>
        <div><span>Open fee</span><b>{dash(fmtUsd(q.fee, 2))}</b></div>
        <div>
          <span>Borrow / month</span>
          <b>
            <span className={spread.crowded === "long" ? "down" : "up"}>L {spread.longMonthly.toFixed(2)}%</span>
            {" · "}
            <span className={spread.crowded === "short" ? "down" : "up"}>S {spread.shortMonthly.toFixed(2)}%</span>
          </b>
        </div>
      </div>

      <details className="acc">
        <summary>Market details</summary>
        <div className="rows">
          <div><span>Spread</span><b>{spread.spread.toFixed(2)}% / month</b></div>
          <div><span>Capacity left</span><b>{fmtUsd(snapshot.capacity.free)} USDC</b></div>
          <div><span>Binding limit</span><b>{snapshot.capacity.binding}</b></div>
        </div>
        {spread.spread > 0.5 && (
          <p className="hint">
            The book is {spread.crowded}. Taking the {spread.paidSide} side is paid{" "}
            {spread.spread.toFixed(2)}% a month to balance it.
          </p>
        )}
      </details>

      <p className="fine">
        {CLUSTER
          ? `Orders settle on ${CLUSTER.rpcUrl}.`
          : "Order routing requires the programs to be deployed. Nothing is signed or settled here yet."}
      </p>
    </aside>
  );
}
