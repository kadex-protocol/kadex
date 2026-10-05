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
  fmtPct, fmtUsd, loadBalances, quoteDeposit, quoteWithdraw,
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

  return (
    <div className="page">
      <div>
        <p className="kicker">03 / Liquidity</p>
        <h1 className="display">Be the house.</h1>
        <p className="lede">
          Deposit into the pool that takes the other side of every index trade.
        </p>
      </div>

      <div className="stats">
        <div className="stat">
          <p className="k">Pool NAV</p>
          <p className="v serif">{data ? fmtUsd(data.poolStats.nav) : "—"}</p>
        </div>
        <div className="stat">
          <p className="k">USDC sleeve</p>
          <p className="v">{data ? fmtUsd(data.pool.usdcSleeve) : "—"}</p>
          <p className="d">{data ? fmtPct(data.poolStats.usdcSleeveShare, 1) : "—"}</p>
        </div>
        <div className="stat">
          <p className="k">Card sleeve</p>
          <p className="v">{data ? fmtUsd(data.pool.cardSleeveValue) : "—"}</p>
          <p className="d">
            {data ? `${fmtPct(data.poolStats.cardSleeveShare, 1)} · max ${fmtPct(data.pool.params.cardSleeveTarget, 0)}` : "—"}
          </p>
        </div>
        <div className="stat">
          <p className="k">Utilisation</p>
          <p className="v">{data ? fmtPct(data.capacity.utilization, 1) : "—"}</p>
          <p className="d">drives the borrow rate</p>
        </div>
      </div>

      <div className="trade-layout">
        <section className="panel prose">
          <h2 className="title">What you are buying</h2>
          <p>
            CLP is a claim on the pool&rsquo;s net asset value. It holds USDC on one side and
            tokenized card fractions on the other, and it is the counterparty to every open
            position. You earn the trading and borrowing fees those positions pay. You lose when
            traders are collectively right.
          </p>

          <h3>What you are not buying</h3>
          <p>
            This is not the same as providing liquidity to the card pool itself. That is a
            different product with a different risk — if a card&rsquo;s price moves sharply in
            either direction you hold less of the winning side than if you had simply kept your
            cards. <em>A card doubling costs roughly 5.7% against holding it outright.</em>
          </p>

          <h3>Getting out</h3>
          <p>
            A redemption returns a proportional slice of both sleeves — USDC and card fractions
            together, never one without the other. The pool cannot be drained of its liquid side
            by whoever withdraws first, which is the whole point.
          </p>

          <h3>Where the income comes from</h3>
          <p>
            Mostly borrow, not trading fees. A trader does not only take a position, they rent
            the pool&rsquo;s balance sheet for as long as they hold it, and that rent rises
            quadratically with utilisation. It is what pushes traders out before the pool is
            stretched.
          </p>
        </section>

        <aside className="panel ticket">
          <div className="seg" role="group" aria-label="Deposit or redeem">
            <button type="button" aria-pressed={mode === "deposit"} onClick={() => { setMode("deposit"); setAmount(""); }}>
              Deposit
            </button>
            <button type="button" aria-pressed={mode === "redeem"} onClick={() => { setMode("redeem"); setAmount(""); }}>
              Redeem
            </button>
          </div>

          <div>
            <p className="kicker" style={{ margin: 0 }}>Pool / CLP</p>
            <h2 className="title" style={{ marginTop: 8 }}>
              {mode === "deposit" ? "Mint CLP" : "Redeem CLP"}
            </h2>
            <p className="sub">
              {mode === "deposit" ? "At net asset value" : "Proportional, both sleeves"}
            </p>
          </div>

          {mode === "deposit" && (
            <div className="seg" role="group" aria-label="What to deposit">
              <button type="button" aria-pressed={kind === "usdc"} onClick={() => setKind("usdc")}>USDC</button>
              <button type="button" aria-pressed={kind === "fractions"} onClick={() => setKind("fractions")}>Fractions</button>
            </div>
          )}

          <label className="field">
            <span>
              {mode === "deposit" ? (kind === "usdc" ? "Amount · USDC" : "Amount · fractions") : "Amount · CLP"}
            </span>
            <input
              inputMode="decimal"
              autoComplete="off"
              placeholder="—"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ""))}
            />
          </label>

          <p className={`hint${problem && has ? " bad" : ""}`} style={{ marginTop: -6 }}>
            {!connected
              ? "Connect a wallet to continue"
              : problem && has
                ? problem
                : !allowed && data
                  ? `The pool is ${data.pool.state} and is not accepting this.`
                  : mode === "deposit" && kind === "fractions"
                    ? `A ${(data ? data.pool.params.depositHaircutBps / 100 : 3).toFixed(1)}% haircut applies, and it pays the LPs already here`
                    : balances
                      ? `Balance ${fmtUsd(mode === "redeem" ? balances.clp : kind === "usdc" ? balances.usdc : balances.fractions, 2)}`
                      : "—"}
          </p>

          {has && data && mode === "deposit" && dep && (
            <>
              <hr className="sep" />
              <div className="rows">
                <div><span>Gross value</span><b>{fmtUsd(dep.netValue + dep.haircut, 2)}</b></div>
                <div className={dep.haircut > 0n ? "hi" : undefined}>
                  <span>Haircut</span>
                  <b>{dep.haircut > 0n ? `−${fmtUsd(dep.haircut, 2)}` : "none"}</b>
                </div>
                <div><span>CLP minted</span><b>{fmtUsd(dep.shares, 2)}</b></div>
                <div><span>Share of pool</span><b>{fmtPct(dep.shareOfPool, 3)}</b></div>
              </div>
            </>
          )}

          {has && data && mode === "redeem" && red && (
            <>
              <hr className="sep" />
              <div className="rows">
                <div><span>USDC returned</span><b>{fmtUsd(red.usdc, 2)}</b></div>
                <div><span>Fractions returned</span><b>{fmtUsd(red.fractions, 2)}</b></div>
                <div className="hi"><span>Total value</span><b>{fmtUsd(red.totalValue, 2)}</b></div>
              </div>
            </>
          )}

          {connected ? (
            <button className="btn block" disabled={!has || !!problem || !allowed || loading}>
              {has ? (mode === "deposit" ? "Deposit" : "Redeem") : "Enter an amount"}
            </button>
          ) : (
            <button className="btn block" onClick={() => void connect()} disabled={status === "connecting"}>
              {status === "connecting" ? "Connecting…" : "Connect wallet"}
            </button>
          )}

          <hr className="sep" />
          <p className="sub">
            No fractions yet? <Link href="/vault" className="link">Vault a card →</Link>
          </p>

          <p className="fine">
            {connected
              ? "Deposits require the programs to be deployed. Nothing is signed or settled here yet."
              : "Visual concept only"}
          </p>
        </aside>
      </div>
    </div>
  );
}
