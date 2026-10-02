"use client";

/**
 * The CLP pool — deposit and redemption.
 *
 * Two things this screen has to be honest about, because both surprise people:
 *
 *  1. Depositing card fractions costs a haircut, and can be refused outright
 *     if it would push the illiquid sleeve past its target.
 *  2. A redemption returns a proportional slice of BOTH sleeves. You cannot
 *     take the USDC and leave the cards. That is what stops a run draining the
 *     liquid side and stranding everyone else with the illiquid one.
 *
 * Neither is hidden behind a tooltip.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { gates } from "@slab/types";
import { useWallet } from "@/lib/wallet";
import { useMarket } from "@/lib/useMarket";
import {
  fmtPct,
  fmtUsd,
  loadBalances,
  quoteDeposit,
  quoteWithdraw,
  type Balances,
  type DepositKind,
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

  useEffect(() => {
    loadBalances(publicKey).then(setBalances);
  }, [publicKey]);

  const raw = useMemo(() => {
    const n = Number(amount.replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return BigInt(Math.trunc(n * 1e6));
  }, [amount]);

  const dep = useMemo(() => (data ? quoteDeposit(data, kind, raw) : null), [data, kind, raw]);
  const red = useMemo(() => (data ? quoteWithdraw(data, raw) : null), [data, raw]);

  const g = data ? gates(data.pool.state) : null;
  const allowed = mode === "deposit" ? g?.canDeposit : g?.canWithdraw;
  const problem = mode === "deposit" ? dep?.problem : red?.problem;
  const hasAmount = raw > 0n;

  return (
    <div className="columns">
      <main className="main-col">
        <p className="eyebrow">04 / Liquidity</p>
        <h1 className="display">Be the house.</h1>
        <p className="standfirst">
          Deposit into the pool that takes the other side of every index trade.
        </p>

        <div className="prose" style={{ marginTop: 28 }}>
          <h3>What you are buying</h3>
          <p>
            CLP is a claim on the pool&rsquo;s net asset value. It holds USDC on one side and
            tokenized card fractions on the other, and it is the counterparty to every open
            position in the market. You earn the trading and borrowing fees those positions pay.
            You lose when traders are collectively right.
          </p>

          <h3>What you are not buying</h3>
          <p>
            This is not the same as providing liquidity to the card pool itself. That is a
            different product with a different risk — if a card&rsquo;s price moves sharply in
            either direction you end up holding less of the winning side than if you had simply
            kept your cards. A card doubling costs roughly 5.7% against holding it outright.
          </p>

          <h3>Getting out</h3>
          <p>
            A redemption returns a proportional slice of both sleeves — USDC and card fractions
            together, never one without the other. The pool cannot be drained of its liquid side
            by whoever withdraws first, which is the whole point.
          </p>
        </div>

        {data && (
          <div className="table-wrap">
            <table className="ledger">
              <thead>
                <tr>
                  <th scope="col">Pool</th>
                  <th scope="col" className="num">Value</th>
                  <th scope="col" className="num">Share</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="name">USDC sleeve</td>
                  <td className="num">{fmtUsd(data.pool.usdcSleeve)}</td>
                  <td className="num">{fmtPct(data.poolStats.usdcSleeveShare, 1)}</td>
                </tr>
                <tr>
                  <td className="name">Card sleeve</td>
                  <td className="num">{fmtUsd(data.pool.cardSleeveValue)}</td>
                  <td className="num">{fmtPct(data.poolStats.cardSleeveShare, 1)}</td>
                </tr>
                <tr>
                  <td className="name">Net asset value</td>
                  <td className="num">{fmtUsd(data.poolStats.nav)}</td>
                  <td className="num">—</td>
                </tr>
                <tr>
                  <td className="name">Card sleeve target</td>
                  <td className="num">max {fmtPct(data.pool.params.cardSleeveTarget, 0)}</td>
                  <td className="num">—</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </main>

      <div className="side-col">
        <aside className="ticket">
          <p className="eyebrow" style={{ margin: 0 }}>Pool / CLP</p>
          <div>
            <h2>{mode === "deposit" ? "Deposit" : "Redeem"}</h2>
            <p className="subhead">
              {mode === "deposit" ? "Mint CLP at net asset value" : "Proportional, both sleeves"}
            </p>
          </div>

          <div className="segmented" role="group" aria-label="Deposit or redeem">
            <button type="button" className="long" aria-pressed={mode === "deposit"} onClick={() => { setMode("deposit"); setAmount(""); }}>
              Deposit
            </button>
            <button type="button" className="short" aria-pressed={mode === "redeem"} onClick={() => { setMode("redeem"); setAmount(""); }}>
              Redeem
            </button>
          </div>

          {mode === "deposit" && (
            <div className="segmented" role="group" aria-label="What to deposit">
              <button type="button" className="long" aria-pressed={kind === "usdc"} onClick={() => setKind("usdc")}>
                USDC
              </button>
              <button type="button" className="short" aria-pressed={kind === "fractions"} onClick={() => setKind("fractions")}>
                Fractions
              </button>
            </div>
          )}

          <div className="field">
            <label htmlFor="pool-amount">
              {mode === "deposit" ? (kind === "usdc" ? "Amount · USDC" : "Amount · fractions") : "Amount · CLP"}
            </label>
            <input
              id="pool-amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder="—"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ""))}
              aria-describedby="pool-help"
            />
            <p id="pool-help" className={`helper${problem && hasAmount ? " warn" : ""}`}>
              {!connected
                ? "Connect a wallet to continue"
                : problem && hasAmount
                  ? problem
                  : !allowed && data
                    ? `The pool is ${data.pool.state} and is not accepting this.`
                    : mode === "deposit" && kind === "fractions"
                      ? `A ${(data ? data.pool.params.depositHaircutBps / 100 : 3).toFixed(1)}% haircut applies to card deposits`
                      : balances
                        ? `Balance ${fmtUsd(mode === "redeem" ? balances.clp : kind === "usdc" ? balances.usdc : balances.fractions, 2)}`
                        : "—"}
            </p>
          </div>

          {hasAmount && data && mode === "deposit" && dep && (
            <div className="readout">
              <div><span>Gross value</span><b>{fmtUsd(dep.netValue + dep.haircut, 2)}</b></div>
              <div><span>Haircut</span><b>{dep.haircut > 0n ? `−${fmtUsd(dep.haircut, 2)}` : "none"}</b></div>
              <div><span>CLP minted</span><b>{fmtUsd(dep.shares, 2)}</b></div>
              <div><span>Share of pool</span><b>{fmtPct(dep.shareOfPool, 3)}</b></div>
            </div>
          )}

          {hasAmount && data && mode === "redeem" && red && (
            <div className="readout">
              <div><span>USDC returned</span><b>{fmtUsd(red.usdc, 2)}</b></div>
              <div><span>Fractions returned</span><b>{fmtUsd(red.fractions, 2)}</b></div>
              <div><span>Total value</span><b>{fmtUsd(red.totalValue, 2)}</b></div>
            </div>
          )}

          {connected ? (
            <button className="primary" disabled={!hasAmount || !!problem || !allowed || loading}>
              {hasAmount ? (mode === "deposit" ? "Deposit" : "Redeem") : "Enter an amount"}
            </button>
          ) : (
            <button className="primary" onClick={() => void connect()} disabled={status === "connecting"}>
              {status === "connecting" ? "Connecting…" : "Connect wallet"}
            </button>
          )}

          <hr className="rule" />

          <p className="body">
            Haven&rsquo;t got fractions yet? <Link href="/vault" className="link-action">Vault a card&nbsp;→</Link>
          </p>

          <p className="fineprint">
            {connected
              ? "Deposits require the programs to be deployed. Nothing is signed or settled here yet."
              : "Visual concept only"}
          </p>
        </aside>
      </div>
    </div>
  );
}
