"use client";

/**
 * The CLP pool — role 2 in docs/users.md.
 *
 * Two things this screen has to be honest about, because both surprise people:
 * depositing fractions costs a haircut and can be refused outright, and a
 * redemption returns a proportional slice of BOTH sleeves. Neither is hidden
 * behind a tooltip.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { gates } from "@slab/types";
import { useWallet } from "@/lib/wallet";
import { useMarket } from "@/lib/useMarket";
import {
  fmtPct, fmtPrice, fmtUsd, loadBalances, quoteDeposit, quoteWithdraw,
  type Balances, type DepositKind,
} from "@/lib/market";

type Mode = "deposit" | "redeem";

export default function PoolPage() {
  const { status, publicKey, connect } = useWallet();
  const { data, loading } = useMarket();
  const [mode, setMode] = useState<Mode>("deposit");
  const [kind, setKind] = useState<DepositKind>("usdc");
  const [amount, setAmount] = useState("");
  const [balances, setBalances] = useState<Balances | null>(null);

  const connected = status === "connected" && publicKey !== null;
  useEffect(() => { loadBalances(publicKey).then(setBalances); }, [publicKey]);

  const raw = useMemo(() => {
    const n = Number(amount.replace(/,/g, ""));
    return !Number.isFinite(n) || n <= 0 ? 0n : BigInt(Math.trunc(n * 1e6));
  }, [amount]);

  const dep = useMemo(() => (data ? quoteDeposit(data, kind, raw) : null), [data, kind, raw]);
  const red = useMemo(() => (data ? quoteWithdraw(data, raw) : null), [data, raw]);

  const g = data ? gates(data.pool.state) : null;
  const allowed = mode === "deposit" ? g?.canDeposit : g?.canWithdraw;
  const problem = mode === "deposit" ? dep?.problem : red?.problem;
  const has = raw > 0n;

  const tokenLabel = mode === "redeem" ? "CLP" : kind === "usdc" ? "USDC" : "Fractions";
  const balance = balances ? (mode === "redeem" ? balances.clp : kind === "usdc" ? balances.usdc : balances.fractions) : null;

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="display">Earn as the house</h1>
        <p className="lede">
          Deposit USDC or card fractions into the pool that takes the other side of every trade.
          You earn the fees traders pay; you lose when they are collectively right.
        </p>
      </header>

      <div className="layout">
        <div className="col">
          <div className="stats">
            <div className="stat">
              <p className="k">Pool value</p>
              <p className="v serif">{data ? fmtUsd(data.poolStats.nav) : "—"}</p>
              <p className="d">USDC</p>
            </div>
            <div className="stat">
              <p className="k">CLP price</p>
              <p className="v">{data ? fmtPrice(data.poolStats.clpPrice) : "—"}</p>
              <p className="d">USDC per share</p>
            </div>
            <div className="stat">
              <p className="k">Utilisation</p>
              <p className="v">{data ? fmtPct(data.capacity.utilization, 1) : "—"}</p>
              <p className="d">drives the borrow rate</p>
            </div>
          </div>

          <section className="panel">
            <div className="panel-head">
              <h2 className="title sm">What the pool holds</h2>
            </div>
            {data && (
              <>
                <div className="bar" style={{ marginBottom: 18 }}>
                  <i style={{ width: fmtPct(data.poolStats.usdcSleeveShare, 2), background: "var(--cream-2)" }} />
                  <i style={{ width: fmtPct(data.poolStats.cardSleeveShare, 2), background: "var(--ember)" }} />
                </div>
                <div className="legend">
                  <div>
                    <span><span className="dot" style={{ background: "var(--cream-2)" }} />USDC sleeve</span>
                    <b>{fmtUsd(data.pool.usdcSleeve)} · {fmtPct(data.poolStats.usdcSleeveShare, 1)}</b>
                  </div>
                  <div>
                    <span><span className="dot" style={{ background: "var(--ember)" }} />Card sleeve (max {fmtPct(data.pool.params.cardSleeveTarget, 0)})</span>
                    <b>{fmtUsd(data.pool.cardSleeveValue)} · {fmtPct(data.poolStats.cardSleeveShare, 1)}</b>
                  </div>
                </div>
              </>
            )}
          </section>

          <section className="panel faq">
            <h2 className="title sm" style={{ marginBottom: 6 }}>Before you deposit</h2>
            <details className="acc" open>
              <summary>What am I buying?</summary>
              <p>
                CLP is a claim on the pool&rsquo;s net asset value. It holds USDC on one side and
                tokenized card fractions on the other, and it is the counterparty to every open
                position. You earn the trading and borrowing fees those positions pay. You lose when
                traders are collectively right.
              </p>
            </details>
            <details className="acc">
              <summary>Where does the income come from?</summary>
              <p>
                Mostly borrow, not trading fees. A trader rents the pool&rsquo;s balance sheet for as
                long as they hold a position, and that rent rises quadratically with utilisation. It
                is what pushes traders out before the pool is stretched.
              </p>
            </details>
            <details className="acc">
              <summary>How do I get out?</summary>
              <p>
                A redemption returns a proportional slice of both sleeves — USDC and card fractions
                together, never one without the other. The pool cannot be drained of its liquid side
                by whoever withdraws first, which is the whole point.
              </p>
            </details>
            <details className="acc">
              <summary>Is this the same as the card liquidity pool?</summary>
              <p>
                No. Providing liquidity to the card pool itself is a different product with a
                different risk — if a card&rsquo;s price moves sharply you hold less of the winning
                side than if you had kept your cards. <em>A card doubling costs roughly 5.7% against
                holding it outright.</em>
              </p>
            </details>
          </section>
        </div>

        <aside className="panel ticket">
          <h2 className="sr-only">Deposit or withdraw</h2>
          <div className="seg big" role="group" aria-label="Deposit or withdraw">
            <button type="button" aria-pressed={mode === "deposit"} onClick={() => { setMode("deposit"); setAmount(""); }}>
              Deposit
            </button>
            <button type="button" aria-pressed={mode === "redeem"} onClick={() => { setMode("redeem"); setAmount(""); }}>
              Withdraw
            </button>
          </div>

          <div className="token-input">
            <div className="ti-top">
              <span>{mode === "deposit" ? "You deposit" : "You burn"}</span>
              <span>Balance {balance !== null ? fmtUsd(balance, 2) : "—"}</span>
            </div>
            <div className="ti-row">
              <input
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                aria-label={`Amount in ${tokenLabel}`}
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ""))}
              />
              {mode === "deposit" ? (
                <span className="seg mini" role="group" aria-label="What to deposit">
                  <button type="button" aria-pressed={kind === "usdc"} onClick={() => setKind("usdc")}>USDC</button>
                  <button type="button" aria-pressed={kind === "fractions"} onClick={() => setKind("fractions")}>Fractions</button>
                </span>
              ) : (
                <span className="token">CLP</span>
              )}
            </div>
          </div>

          <p className={`hint${problem && has ? " bad" : ""}`} style={{ margin: 0 }}>
            {problem && has
              ? problem
              : !allowed && data
                ? `The pool is ${data.pool.state} and is not accepting this.`
                : mode === "deposit" && kind === "fractions"
                  ? `A ${(data ? data.pool.params.depositHaircutBps / 100 : 3).toFixed(1)}% haircut applies to fractions, and it pays the LPs already here.`
                  : mode === "deposit"
                    ? "Minted at net asset value."
                    : "Returned as a proportional slice of both sleeves."}
          </p>

          <div className="rows">
            {mode === "deposit" ? (
              <>
                <div className={has && dep && dep.haircut > 0n ? "hi" : undefined}>
                  <span>Haircut</span>
                  <b>{has && dep ? (dep.haircut > 0n ? `−${fmtUsd(dep.haircut, 2)}` : "none") : "—"}</b>
                </div>
                <div><span>You receive</span><b>{has && dep ? `${fmtUsd(dep.shares, 2)} CLP` : "—"}</b></div>
                <div><span>Share of pool</span><b>{has && dep ? fmtPct(dep.shareOfPool, 3) : "—"}</b></div>
              </>
            ) : (
              <>
                <div><span>USDC returned</span><b>{has && red ? fmtUsd(red.usdc, 2) : "—"}</b></div>
                <div><span>Fractions returned</span><b>{has && red ? fmtUsd(red.fractions, 2) : "—"}</b></div>
                <div className={has ? "hi" : undefined}><span>Total value</span><b>{has && red ? fmtUsd(red.totalValue, 2) : "—"}</b></div>
              </>
            )}
          </div>

          {connected ? (
            <button className="btn block" disabled={!has || !!problem || !allowed || loading}>
              {has ? (mode === "deposit" ? "Deposit" : "Withdraw") : "Enter an amount"}
            </button>
          ) : (
            <button className="btn block" onClick={() => void connect()} disabled={status === "connecting"}>
              {status === "connecting" ? "Connecting…" : "Connect wallet"}
            </button>
          )}

          <p className="sub" style={{ margin: 0 }}>
            No fractions yet? <Link href="/vault" className="link">Vault a card →</Link>
          </p>

          <p className="fine">
            Deposits require the programs to be deployed. Nothing is signed or settled here yet.
          </p>
        </aside>
      </div>
    </div>
  );
}
