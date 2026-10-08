"use client";

/**
 * The CLP pool — role 2 in docs/users.md.
 *
 * Two things this screen has to be honest about, because both surprise people:
 * depositing fractions costs a haircut and can be refused outright, and a
 * redemption returns a proportional slice of BOTH sleeves. Neither is hidden
 * behind a tooltip.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { gates } from "@slab/types";
import { useWallet } from "@/lib/wallet";
import { useMarket } from "@/lib/useMarket";
import {
  fmtPct, fmtPrice, fmtUsd, loadBalances, quoteDeposit, quoteWithdraw,
  IS_SAMPLE, type Balances, type DepositKind,
} from "@/lib/market";
import { CLUSTER } from "@/lib/cluster";
import { sendPoolAction, type PoolAction } from "@/lib/poolTx";
import { explainTxError, shortSignature } from "@/lib/tx";

type TicketSide = "deposit" | "withdraw";
interface Receipt {
  side: TicketSide;
  ok: boolean;
  text: string;
}

const toRaw = (text: string) => {
  const n = Number(text.replace(/,/g, ""));
  return !Number.isFinite(n) || n <= 0 ? 0n : BigInt(Math.trunc(n * 1e6));
};
const clean = (text: string) => text.replace(/[^0-9.,]/g, "");
const filled = (amount: bigint, balance: bigint | null) =>
  !balance || balance <= 0n ? 0 : Math.min(100, Number((amount * 10_000n) / balance) / 100);
const portion = (balance: bigint, percent: number) => (Number((balance * BigInt(percent)) / 100n) / 1e6).toString();

export default function PoolPage() {
  const { status, publicKey, connect, signTransaction } = useWallet();
  const { data, loading, error, reload } = useMarket();
  const [kind, setKind] = useState<DepositKind>("usdc");
  const [payAmount, setPayAmount] = useState("");
  const [burnAmount, setBurnAmount] = useState("");
  const [balances, setBalances] = useState<Balances | null>(null);
  const [sending, setSending] = useState<TicketSide | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const connected = status === "connected" && publicKey !== null;
  const reloadBalances = useCallback(() => {
    loadBalances(publicKey).then(setBalances).catch(() => setBalances(null));
  }, [publicKey]);
  useEffect(reloadBalances, [reloadBalances]);

  const pay = useMemo(() => toRaw(payAmount), [payAmount]);
  const burn = useMemo(() => toRaw(burnAmount), [burnAmount]);
  const dep = useMemo(() => (data ? quoteDeposit(data, kind, pay) : null), [data, kind, pay]);
  const red = useMemo(() => (data ? quoteWithdraw(data, burn) : null), [data, burn]);

  const g = data ? gates(data.pool.state) : null;
  const paying = pay > 0n;
  const burning = burn > 0n;
  const payBalance = balances ? (kind === "usdc" ? balances.usdc : balances.fractions) : null;
  const clpBalance = balances ? balances.clp : null;
  const payOver = connected && payBalance !== null && pay > payBalance;
  const burnOver = connected && clpBalance !== null && burn > clpBalance;
  const closed = data ? `The pool is ${data.pool.state} and is not accepting this.` : null;
  const submit = async (side: TicketSide, action: PoolAction) => {
    if (!publicKey) return;
    if (!CLUSTER) {
      setReceipt({ side, ok: false, text: "Preview only: no cluster is configured, so nothing was sent." });
      return;
    }
    setSending(side);
    setReceipt(null);
    try {
      const signature = await sendPoolAction(CLUSTER, publicKey, signTransaction, action);
      setReceipt({ side, ok: true, text: `Confirmed · ${shortSignature(signature)}` });
      if (side === "deposit") setPayAmount("");
      else setBurnAmount("");
      reload();
      reloadBalances();
    } catch (e) {
      setReceipt({ side, ok: false, text: explainTxError(e) });
    } finally {
      setSending(null);
    }
  };

  const rate = data ? `1 CLP = ${fmtPrice(data.poolStats.clpPrice)} USDC` : "";

  const held = data && balances && balances.clp > 0n ? quoteWithdraw(data, balances.clp).totalValue : 0n;
  const share = data && balances && data.pool.clpSupply > 0n ? (Number(balances.clp) / Number(data.pool.clpSupply)) * 100 : 0;
  return (
    <div className="page wide">
      <header className="vmkt-head">
        <h1>
          Earn: <span>CLP pool</span>
        </h1>
        <p className="vmkt-total">
          Pool value <b>{data ? `${fmtUsd(data.poolStats.nav)} $` : "—"}</b>
        </p>
      </header>

      {error && (
        <div className="empty" role="alert">
          <p>Could not read the pool. {error}</p>
        </div>
      )}

      <div className="pstats">
        <section className="panel pstat">
          <p className="k">Pool value</p>
          <p className="v">{data ? `$${fmtUsd(data.poolStats.nav)}` : "—"}</p>
          <p className="d">USDC and card fractions together</p>
        </section>
        <section className="panel pstat">
          <p className="k">CLP price</p>
          <p className="v">{data ? fmtPrice(data.poolStats.clpPrice) : "—"}</p>
          <p className="d">USDC per share, at net asset value</p>
        </section>
        <section className="panel pstat">
          <p className="k">Your deposits</p>
          <p className="v">{connected ? `$${fmtUsd(held, 2)}` : "—"}</p>
          <p className="d">{connected && balances ? `${fmtUsd(balances.clp, 2)} CLP` : "Connect a wallet to see yours"}</p>
        </section>
        <section className="panel pstat">
          <p className="k">Your share of the pool</p>
          <p className="v">{connected ? `${share.toFixed(3)}%` : "—"}</p>
          <p className="d">
            Utilisation {data ? fmtPct(data.capacity.utilization, 1) : "—"}
            <span className="meter"><i style={{ width: data ? fmtPct(data.capacity.utilization, 1) : "0%" }} /></span>
          </p>
        </section>
      </div>

      <div className="earn2">
        <section className="panel ticket">
          <div className="panel-head">
            <div>
              <h2 className="title sm">Deposit</h2>
              <p className="sub">USDC or card fractions in, CLP out.</p>
            </div>
          </div>

          <div className="token-input">
            <div className="ti-top">
              <span>You pay</span>
              <span>Balance {payBalance !== null ? fmtUsd(payBalance, 2) : "—"}</span>
            </div>
            <div className="ti-row">
              <input
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                aria-label={`Amount to deposit in ${kind === "usdc" ? "USDC" : "fractions"}`}
                value={payAmount}
                onChange={(e) => setPayAmount(clean(e.target.value))}
              />
              <span className="tk-switch sm" role="group" aria-label="What to deposit">
                <button type="button" aria-pressed={kind === "usdc"} onClick={() => setKind("usdc")}>USDC</button>
                <button type="button" aria-pressed={kind === "fractions"} onClick={() => setKind("fractions")}>Fractions</button>
              </span>
            </div>
            <div className="pct" role="group" aria-label="Use part of the balance">
              {[25, 50, 75, 100].map((percent) => (
                <button key={percent} type="button" disabled={payBalance === null || payBalance <= 0n} onClick={() => payBalance !== null && setPayAmount(portion(payBalance, percent))}>
                  {percent === 100 ? "Max" : `${percent}%`}
                </button>
              ))}
            </div>
          </div>

          <span className="swap-arrow" aria-hidden="true">↓</span>

          <div className="token-input out">
            <div className="ti-top">
              <span>You receive</span>
              <span>{rate}</span>
            </div>
            <div className="ti-row">
              <span className={`ti-out${paying && dep ? "" : " dim"}`}>{paying && dep ? fmtUsd(dep.shares, 2) : "0.00"}</span>
              <span className="tk-asset"><span className="coin" aria-hidden="true"><span className="star" /></span>CLP</span>
            </div>
          </div>

          <div className={`tk-meter${payOver ? " over" : ""}`}>
            <div>
              <span>Of your balance</span>
              <b>
                {fmtUsd(pay, 2)}
                <em> / {payBalance !== null ? fmtUsd(payBalance, 2) : "—"}</em>
              </b>
            </div>
            <i><i style={{ width: `${filled(pay, payBalance)}%` }} /></i>
          </div>

          <p className={`hint${dep?.problem && paying ? " bad" : ""}`} style={{ margin: 0 }}>
            {dep?.problem && paying
              ? dep.problem
              : g && !g.canDeposit
                ? closed
                : kind === "fractions"
                  ? `A ${(data ? data.pool.params.depositHaircutBps / 100 : 3).toFixed(1)}% haircut applies to fractions, and it pays the LPs already here.`
                  : "Minted at net asset value."}
          </p>

          <div className="rows tk-sum">
            <div className={paying && dep && dep.haircut > 0n ? "hi" : undefined}>
              <span>Haircut</span>
              <b>{paying && dep ? (dep.haircut > 0n ? `−${fmtUsd(dep.haircut, 2)}` : "none") : "—"}</b>
            </div>
            <div><span>Value added</span><b>{paying && dep ? `$${fmtUsd(dep.netValue, 2)}` : "—"}</b></div>
            <div><span>Share of pool</span><b>{paying && dep ? fmtPct(dep.shareOfPool, 3) : "—"}</b></div>
          </div>

          {connected ? (
            <button
              className="btn block long"
              disabled={!paying || !!dep?.problem || !g?.canDeposit || loading || sending !== null || payOver}
              onClick={() => void submit("deposit", { kind: kind === "usdc" ? "depositUsdc" : "depositFractions", amount: pay })}
            >
              {sending === "deposit" ? "Confirm in your wallet…" : paying ? "Deposit" : "Enter an amount"}
            </button>
          ) : (
            <button className="btn block" onClick={() => void connect()} disabled={status === "connecting"}>
              {status === "connecting" ? "Connecting…" : "Connect wallet"}
            </button>
          )}
          {receipt?.side === "deposit" && (
            <p className={`hint ${receipt.ok ? "good" : "bad"}`} role="status" style={{ margin: 0 }}>{receipt.text}</p>
          )}

          <p className="sub" style={{ margin: 0 }}>
            No fractions yet? <Link href="/vault" className="link">Vault a card →</Link>
          </p>
        </section>

        <section className="panel ticket">
          <div className="panel-head">
            <div>
              <h2 className="title sm">Withdraw</h2>
              <p className="sub">CLP in, a slice of both sleeves out.</p>
            </div>
          </div>

          <div className="token-input">
            <div className="ti-top">
              <span>You burn</span>
              <span>Balance {clpBalance !== null ? fmtUsd(clpBalance, 2) : "—"}</span>
            </div>
            <div className="ti-row">
              <input
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                aria-label="Amount to withdraw in CLP"
                value={burnAmount}
                onChange={(e) => setBurnAmount(clean(e.target.value))}
              />
              <span className="tk-asset"><span className="coin" aria-hidden="true"><span className="star" /></span>CLP</span>
            </div>
            <div className="pct" role="group" aria-label="Use part of the balance">
              {[25, 50, 75, 100].map((percent) => (
                <button key={percent} type="button" disabled={clpBalance === null || clpBalance <= 0n} onClick={() => clpBalance !== null && setBurnAmount(portion(clpBalance, percent))}>
                  {percent === 100 ? "Max" : `${percent}%`}
                </button>
              ))}
            </div>
          </div>

          <span className="swap-arrow" aria-hidden="true">↓</span>

          <div className="token-input out">
            <div className="ti-top">
              <span>You receive</span>
              <span>{rate}</span>
            </div>
            <div className="ti-row">
              <span className={`ti-out${burning && red ? "" : " dim"}`}>{burning && red ? fmtUsd(red.usdc, 2) : "0.00"}</span>
              <span className="tk-asset"><span className="coin usdc" aria-hidden="true">$</span>USDC</span>
            </div>
            <div className="ti-row">
              <span className={`ti-out${burning && red ? "" : " dim"}`}>{burning && red ? fmtUsd(red.fractions, 2) : "0.00"}</span>
              <span className="tk-asset"><span className="coin" aria-hidden="true"><span className="star" /></span>Fractions</span>
            </div>
          </div>

          <div className={`tk-meter${burnOver ? " over" : ""}`}>
            <div>
              <span>Of your CLP</span>
              <b>
                {fmtUsd(burn, 2)}
                <em> / {clpBalance !== null ? fmtUsd(clpBalance, 2) : "—"}</em>
              </b>
            </div>
            <i><i style={{ width: `${filled(burn, clpBalance)}%` }} /></i>
          </div>

          <p className={`hint${red?.problem && burning ? " bad" : ""}`} style={{ margin: 0 }}>
            {red?.problem && burning
              ? red.problem
              : g && !g.canWithdraw
                ? closed
                : "Returned as a proportional slice of both sleeves."}
          </p>

          <div className="rows tk-sum">
            <div className={burning ? "hi" : undefined}><span>Total value</span><b>{burning && red ? `$${fmtUsd(red.totalValue, 2)}` : "—"}</b></div>
            <div><span>CLP left</span><b>{burning && clpBalance !== null && clpBalance >= burn ? fmtUsd(clpBalance - burn, 2) : "—"}</b></div>
          </div>

          {connected ? (
            <button
              className="btn block neutral"
              disabled={!burning || !!red?.problem || !g?.canWithdraw || loading || sending !== null || burnOver}
              onClick={() => void submit("withdraw", { kind: "withdraw", amount: burn })}
            >
              {sending === "withdraw" ? "Confirm in your wallet…" : burning ? "Withdraw" : "Enter an amount"}
            </button>
          ) : (
            <button className="btn block" onClick={() => void connect()} disabled={status === "connecting"}>
              {status === "connecting" ? "Connecting…" : "Connect wallet"}
            </button>
          )}
          {receipt?.side === "withdraw" && (
            <p className={`hint ${receipt.ok ? "good" : "bad"}`} role="status" style={{ margin: 0 }}>{receipt.text}</p>
          )}
        </section>
      </div>

      <p className="fine earn-fine">
        {IS_SAMPLE
          ? "Deposits require the programs to be deployed. Nothing is signed or settled here yet."
          : `Reading and settling on ${CLUSTER?.rpcUrl}.`}
      </p>

      <div className="earn2">
        <div className="col">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="title sm">Liquidity allocation</h2>
                <p className="sub">What a share of the pool is a claim on.</p>
              </div>
            </div>
            <div className="t-wrap">
              <table className="t alloc">
                <thead>
                  <tr>
                    <th>Sleeve</th>
                    <th className="r">Value</th>
                    <th className="r">Weight</th>
                    <th className="r">Limit</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <span className="asset">
                        <span className="coin usdc" aria-hidden="true">$</span>
                        <span>
                          <span className="nm">USDC</span>
                          <span className="id">Pays winning trades</span>
                        </span>
                      </span>
                    </td>
                    <td className="r n">{data ? `$${fmtUsd(data.pool.usdcSleeve)}` : "—"}</td>
                    <td className="r n">
                      <span className="w">
                        {data ? fmtPct(data.poolStats.usdcSleeveShare, 1) : "—"}
                        <span className="bar"><i style={{ width: data ? fmtPct(data.poolStats.usdcSleeveShare, 2) : "0%", background: "var(--ink)" }} /></span>
                      </span>
                    </td>
                    <td className="r">No limit</td>
                  </tr>
                  <tr>
                    <td>
                      <span className="asset">
                        <span className="coin" aria-hidden="true"><span className="star" /></span>
                        <span>
                          <span className="nm">Card fractions</span>
                          <span className="id">Tokenized graded cards</span>
                        </span>
                      </span>
                    </td>
                    <td className="r n">{data ? `$${fmtUsd(data.pool.cardSleeveValue)}` : "—"}</td>
                    <td className="r n">
                      <span className="w">
                        {data ? fmtPct(data.poolStats.cardSleeveShare, 1) : "—"}
                        <span className="bar"><i style={{ width: data ? fmtPct(data.poolStats.cardSleeveShare, 2) : "0%", background: "var(--ink-2)" }} /></span>
                      </span>
                    </td>
                    <td className="r">{data ? `Max ${fmtPct(data.pool.params.cardSleeveTarget, 0)}` : "—"}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <h2 className="title sm" style={{ marginBottom: 20 }}>How earning works</h2>
            <div className="steps">
              <div>
                <span>1</span>
                <h4>Deposit</h4>
                <p>Put in USDC or card fractions. You get CLP, minted at the pool&rsquo;s net asset value.</p>
              </div>
              <div>
                <span>2</span>
                <h4>Earn</h4>
                <p>The pool is the other side of every trade. Borrow and trading fees raise the CLP price.</p>
              </div>
              <div>
                <span>3</span>
                <h4>Withdraw</h4>
                <p>Burn CLP for a proportional slice of both sleeves: USDC and fractions together.</p>
              </div>
            </div>
          </section>
        </div>

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
    </div>
  );
}
