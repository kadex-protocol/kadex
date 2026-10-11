"use client";


import { useEffect, useMemo, useState } from "react";
import type { Side } from "@kadex/types";
import { useWallet } from "@/lib/wallet";
import { formatAmount, parseAmount } from "@/lib/amount";
import { borrowSpread, fmtPrice, fmtUsd, loadBalances, quote, type Balances, type MarketSnapshot } from "@/lib/market";
import { CLUSTER, USD_LABEL } from "@/lib/cluster";
import { clusterName } from "@/lib/testCards";
import { openPosition } from "@/lib/actions";
import { explainTxError, shortSignature } from "@/lib/tx";
import { HedgeSuggestion } from "@/components/HedgeSuggestion";

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

  useEffect(() => {
    let live = true;
    setBalances(null);
    loadBalances(publicKey)
      .then((value) => live && setBalances(value))
      .catch(() => live && setBalances(null));
    return () => {
      live = false;
    };
  }, [publicKey, balanceVersion, snapshot]);

  const parsed = useMemo(() => parseAmount(amount), [amount]);
  const invalid = parsed === null;
  const typed = parsed ?? 0n;

  // In hedge mode the number typed is inventory value; the position is the
  // slice of it being covered, and it is always a short.
  const side: Side = hedge ? "short" : picked;
  const notional = hedge ? (typed * BigInt(coverPct)) / 100n : typed;

  const q = useMemo(() => quote(snapshot, side, notional), [snapshot, side, notional]);

  const hasAmount = notional > 0n;
  const units = q.entryPrice > 0n ? (notional * 1_000_000n) / q.entryPrice : 0n;
  const blocked = q.problem !== null;
  const dash = (v: string) => (hasAmount ? v : "-");

  const leverage = Number(snapshot.pool.params.baseLeverage) / 1e6;
  const cost = q.margin + q.fee;
  const affordable = balances
    ? (balances.usdc * snapshot.pool.params.baseLeverage * 10_000n) /
      (10_000n * 1_000_000n + BigInt(snapshot.pool.params.openCloseFeeBps) * snapshot.pool.params.baseLeverage)
    : 0n;
  const reach = affordable < snapshot.capacity.free ? affordable : snapshot.capacity.free;
  const ceiling = reach > 10n ? reach - 10n : 0n;
  const used = !hasAmount || !balances || balances.usdc === 0n ? 0 : Math.min(100, Number((cost * 10_000n) / balances.usdc) / 100);
  const short = connected && balances !== null && hasAmount && balances.usdc < cost;

  const submit = async () => {
    if (!publicKey || invalid || balances === null) return;
    setSending(true);
    setReceipt(null);
    try {
      const signature = await openPosition({ publicKey, sign: signTransaction }, { side, notional, margin: q.margin });
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
    (notional * BigInt(Math.round(spread[side === "long" ? "longMonthly" : "shortMonthly"] * 1e4))) / 1_000_000n;

  return (
    <aside className="panel ticket tk2" aria-labelledby="ticket-h">
      <header className="tk-head">
        <h2 id="ticket-h">{hedge ? "Hedge" : "Trade"}</h2>
        <span className="tk-chip">Isolated · {leverage}x</span>
        <div className="tk-switch" role="group" aria-label="Order type">
          <button type="button" aria-pressed={!hedge} onClick={() => setMode("trade")}>Trade</button>
          <button type="button" aria-pressed={hedge} onClick={() => setMode("hedge")}>Hedge</button>
        </div>
      </header>

      <div className="tk-sides" role="group" aria-label="Side">
        <button type="button" className="l" aria-pressed={side === "long"} disabled={hedge} onClick={() => setPicked("long")}>
          <i aria-hidden="true">
            <svg viewBox="0 0 20 20" fill="none">
              <path d="M4 14l4.2-4.6 2.8 2.8L16 6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M11.6 6.2H16v4.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </i>
          <span>
            <b>Long</b>
            <em>Profit if the index rises</em>
          </span>
        </button>
        <button type="button" className="s" aria-pressed={side === "short"} disabled={hedge} onClick={hedge ? undefined : () => setPicked("short")}>
          <i aria-hidden="true">
            <svg viewBox="0 0 20 20" fill="none">
              <path d="M4 6l4.2 4.6 2.8-2.8L16 13.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M11.6 13.8H16V9.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </i>
          <span>
            <b>{hedge ? "Cover" : "Short"}</b>
            <em>{hedge ? "A short sized on your stock" : "Profit if the index falls"}</em>
          </span>
        </button>
      </div>

      <div className="token-input big">
        <div className="ti-top">
          <span>{hedge ? "Inventory value" : "Order size"}</span>
          <span>Balance {connected && balances ? fmtUsd(balances.usdc, 2) : "-"}</span>
        </div>
        <div className="ti-row">
          <input
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            aria-label={hedge ? `Inventory value in ${USD_LABEL}` : `Position size in ${USD_LABEL}`}
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ""))}
          />
          <span className="tk-asset"><span className="coin usdc" aria-hidden="true" />{USD_LABEL}</span>
        </div>
        {invalid && <p className="hint bad" style={{ margin: 0 }}>Enter a valid amount.</p>}
        {!hedge && (
          <div className="pct" role="group" aria-label="Use part of what the balance can open">
            {[25, 50, 75, 100].map((percent) => (
              <button key={percent} type="button" disabled={ceiling <= 0n} onClick={() => setAmount(formatAmount((ceiling * BigInt(percent)) / 100n))}>
                {percent === 100 ? "Max" : `${percent}%`}
              </button>
            ))}
          </div>
        )}
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

      {hedge && (
        <HedgeSuggestion
          snapshot={snapshot}
          owner={publicKey}
          onFill={(size) => {
            setCoverPct(100);
            setAmount(formatAmount(size));
          }}
        />
      )}

      <div className={`tk-meter${short ? " over" : ""}`}>
        <div>
          <span>Margin + fee</span>
          <b>
            {hasAmount ? fmtUsd(cost, 2) : "0.00"}
            <em> / {connected && balances ? fmtUsd(balances.usdc, 2) : "-"} {USD_LABEL}</em>
          </b>
        </div>
        <i><i style={{ width: `${used}%` }} /></i>
      </div>

      {blocked && hasAmount && <p className="hint bad" style={{ margin: 0 }}>{q.problem}</p>}
      {!blocked && short && (
        <p className="hint bad" style={{ margin: 0 }}>Needs {fmtUsd(cost, 2)} {USD_LABEL} for margin and fee; this wallet has {fmtUsd(balances.usdc, 2)}.</p>
      )}

      {connected ? (
        <button className={`btn block ${side}`} disabled={!hasAmount || invalid || balances === null || blocked || short || sending} title={q.problem ?? undefined} onClick={() => void submit()}>
          {sending ? "Confirm in your wallet…" : !hasAmount ? "Enter an amount" : hedge ? "Open cover" : `Open ${side}`}
        </button>
      ) : (
        <button className="btn block" onClick={() => void connect()} disabled={status === "connecting"}>
          {status === "connecting" ? "Connecting…" : "Connect wallet"}
        </button>
      )}

      {error && <p className="hint bad" role="alert" style={{ margin: 0 }}>{error}</p>}
      {receipt && <p className={`hint ${receipt.ok ? "good" : "bad"}`} role="status" style={{ margin: 0 }}>{receipt.text}</p>}

      <div className="rows tk-sum">
        <div className={hasAmount ? "hi" : undefined}><span>Est. liquidation price</span><b>{dash(fmtPrice(q.liquidationPrice))}</b></div>
        <div><span>Entry price</span><b>{fmtPrice(q.entryPrice)}</b></div>
        {hedge && <div><span>Cost of cover</span><b>{dash(`${fmtUsd(monthlyCost, 2)} / month`)}</b></div>}
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
          <div><span>Order value</span><b>{dash(fmtUsd(notional, 2))}</b></div>
          <div><span>Index units</span><b>{dash(fmtUsd(units, 2))}</b></div>
          <div><span>Margin required</span><b>{dash(fmtUsd(q.margin, 2))}</b></div>
          <div><span>Open fee</span><b>{dash(fmtUsd(q.fee, 2))}</b></div>
          <div><span>TWAP</span><b>{fmtPrice(snapshot.oracle.twap)}</b></div>
          <div><span>Oracle</span><b>{snapshot.oracle.state}</b></div>
          <div><span>Spread</span><b>{spread.spread.toFixed(2)}% / month</b></div>
          <div><span>Capacity left</span><b>{fmtUsd(snapshot.capacity.free)} {USD_LABEL}</b></div>
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
          ? `Orders settle on ${clusterName()}.`
          : "Simulated in this browser until the programs are deployed. Nothing is signed or settled on-chain."}
      </p>
    </aside>
  );
}
