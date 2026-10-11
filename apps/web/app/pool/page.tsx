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
import { gates } from "@kadex/types";
import { formatAmount, parseAmount } from "@/lib/amount";
import { USD_LABEL } from "@/lib/cluster";
import { useWallet } from "@/lib/wallet";
import { useMarket } from "@/lib/useMarket";
import {
  borrowSpread, fmtPct, fmtPrice, fmtUsd, loadBalances, quoteDeposit, quoteWithdraw,
  IS_SAMPLE, type Balances, type DepositKind,
} from "@/lib/market";
import { clusterName } from "@/lib/testCards";
import { poolAction, type PoolAction } from "@/lib/actions";
import { explainTxError, shortSignature } from "@/lib/tx";
import { LpPosition } from "@/components/LpPosition";

type TicketSide = "deposit" | "withdraw";
interface Receipt {
  ok: boolean;
  text: string;
}

const clean = (text: string) => text.replace(/[^0-9.,]/g, "");
const portion = (balance: bigint, percent: number) => formatAmount((balance * BigInt(percent)) / 100n);

const UsdcCoin = () => <span className="coin usdc" aria-hidden="true" />;
const KadexCoin = () => <span className="coin" aria-hidden="true"><span className="star" /></span>;

export default function PoolPage() {
  const { status, publicKey, connect, signTransaction } = useWallet();
  const { data, loading, error, reload } = useMarket();
  const [side, setSide] = useState<TicketSide>("deposit");
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("tab") === "withdraw") setSide("withdraw");
  }, []);
  const [kind, setKind] = useState<DepositKind>("usdc");
  const [amount, setAmount] = useState("");
  const [balances, setBalances] = useState<Balances | null>(null);
  const [balanceVersion, setBalanceVersion] = useState(0);
  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const connected = status === "connected" && publicKey !== null;
  const reloadBalances = useCallback(() => setBalanceVersion((v) => v + 1), []);
  useEffect(() => {
    let live = true;
    setBalances(null);
    loadBalances(publicKey)
      .then((value) => live && setBalances(value))
      .catch(() => live && setBalances(null));
    return () => {
      live = false;
    };
  }, [publicKey, balanceVersion]);

  const depositing = side === "deposit";
  const parsed = useMemo(() => parseAmount(amount), [amount]);
  const invalid = parsed === null;
  const raw = parsed ?? 0n;
  const dep = useMemo(() => (data && depositing ? quoteDeposit(data, kind, raw) : null), [data, depositing, kind, raw]);
  const red = useMemo(() => (data && !depositing ? quoteWithdraw(data, raw) : null), [data, depositing, raw]);

  const g = data ? gates(data.pool.state) : null;
  const open = depositing ? g?.canDeposit : g?.canWithdraw;
  const entered = raw > 0n;
  const unit = !depositing ? "CLP" : kind === "usdc" ? USD_LABEL : "fractions";
  const balance = !balances ? null : !depositing ? balances.clp : kind === "usdc" ? balances.usdc : balances.fractions;
  const over = connected && balance !== null && raw > balance;
  const problem = entered ? (depositing ? dep?.problem : red?.problem) ?? null : null;
  const haircutPct = (data ? data.pool.params.depositHaircutBps / 100 : 3).toFixed(1);

  const pick = (next: TicketSide) => {
    setSide(next);
    setAmount("");
    setReceipt(null);
  };

  const submit = async () => {
    if (!publicKey || invalid || balances === null) return;
    const action: PoolAction = depositing
      ? { kind: kind === "usdc" ? "depositUsdc" : "depositFractions", amount: raw }
      : { kind: "withdraw", amount: raw };
    setSending(true);
    setReceipt(null);
    try {
      const signature = await poolAction({ publicKey, sign: signTransaction }, action);
      setReceipt({ ok: true, text: `Confirmed · ${shortSignature(signature)}` });
      setAmount("");
      reload();
      reloadBalances();
    } catch (e) {
      setReceipt({ ok: false, text: explainTxError(e) });
    } finally {
      setSending(false);
    }
  };

  const hint = invalid
    ? "Enter a valid amount."
    : over
    ? "That is more than your balance."
    : problem
      ? problem
      : g && !open
        ? `The pool is ${data?.pool.state} and is not accepting this.`
        : !depositing
          ? "Returned as a proportional slice of both sleeves."
          : kind === "fractions"
            ? `A ${haircutPct}% haircut applies to fractions, and it pays the LPs already here.`
            : "Minted at net asset value.";

  const spread = data ? borrowSpread(data) : null;
  const held = data && balances && balances.clp > 0n ? quoteWithdraw(data, balances.clp).totalValue : 0n;
  const share = data && balances && data.pool.clpSupply > 0n ? (Number(balances.clp) / Number(data.pool.clpSupply)) * 100 : 0;

  return (
    <div className="page wide earn">
      {error && (
        <div className="empty" role="alert">
          <p>Could not read the pool. {error}</p>
        </div>
      )}

      <header className="earn-hero">
        <h1>CLP Pool</h1>
        <p>
          Deposit {USD_LABEL} or card fractions and earn the fees traders pay. The pool is the other side
          of every trade on the Kadex index.
        </p>
        <dl className="earn-stats">
          <div><dt>Total value locked</dt><dd>{data ? `$${fmtUsd(data.poolStats.nav, 2)}` : "-"}</dd></div>
          <div><dt>CLP price</dt><dd>{data ? fmtPrice(data.poolStats.clpPrice) : "-"}</dd></div>
          <div><dt>Utilisation</dt><dd>{data ? fmtPct(data.capacity.utilization, 1) : "-"}</dd></div>
          <div>
            <dt>Borrow / month</dt>
            <dd>{spread ? `L ${spread.longMonthly.toFixed(2)}% · S ${spread.shortMonthly.toFixed(2)}%` : "-"}</dd>
          </div>
        </dl>
      </header>

      <aside className="earn-ticket">
        <div className="earn-tabs" role="group" aria-label="Deposit or withdraw">
          <button type="button" aria-pressed={depositing} onClick={() => pick("deposit")}>Deposit</button>
          <button type="button" aria-pressed={!depositing} onClick={() => pick("withdraw")}>Withdraw</button>
        </div>

        <div className={`earn-box${over ? " over" : ""}`}>
          <div className="earn-box-top">
            <span>{depositing ? "You're depositing" : "You're burning"}</span>
            <span className="earn-bal">
              {balance !== null ? fmtUsd(balance, 2) : "0"} {unit}
              {connected && balance !== null && balance > 0n && (
                <>
                  <button type="button" onClick={() => setAmount(portion(balance, 50))}>Half</button>
                  <button type="button" onClick={() => setAmount(portion(balance, 100))}>Max</button>
                </>
              )}
            </span>
          </div>
          <div className="earn-box-row">
            {depositing ? (
              <label className="tk-asset pick">
                {kind === "usdc" ? <UsdcCoin /> : <KadexCoin />}
                <select
                  aria-label="What to deposit"
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value as DepositKind);
                    setAmount("");
                    setReceipt(null);
                  }}
                >
                  <option value="usdc">{USD_LABEL}</option>
                  <option value="fractions">Fractions</option>
                </select>
              </label>
            ) : (
              <span className="tk-asset"><KadexCoin />CLP</span>
            )}
            <input
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              aria-label={`Amount in ${unit}`}
              value={amount}
              onChange={(e) => setAmount(clean(e.target.value))}
            />
          </div>
        </div>

        <div className="earn-box">
          <div className="earn-box-top">
            <span>{depositing ? "You're minting" : "You're receiving"}</span>
            <span className="earn-bal">
              {depositing ? `${balances ? fmtUsd(balances.clp, 2) : "0"} CLP` : data ? `1 CLP = ${fmtPrice(data.poolStats.clpPrice)} ${USD_LABEL}` : ""}
            </span>
          </div>
          {depositing ? (
            <div className="earn-box-row">
              <span className="tk-asset"><KadexCoin />CLP</span>
              <output className={entered && dep ? undefined : "dim"}>{entered && dep ? fmtUsd(dep.shares, 2) : "0.00"}</output>
            </div>
          ) : (
            <>
              <div className="earn-box-row">
                <span className="tk-asset"><UsdcCoin />{USD_LABEL}</span>
                <output className={entered && red ? undefined : "dim"}>{entered && red ? fmtUsd(red.usdc, 2) : "0.00"}</output>
              </div>
              <div className="earn-box-row">
                <span className="tk-asset"><KadexCoin />Fractions</span>
                <output className={entered && red ? undefined : "dim"}>{entered && red ? fmtUsd(red.fractions, 2) : "0.00"}</output>
              </div>
            </>
          )}
        </div>

        {connected ? (
          <button
            className={`btn block ${depositing ? "long" : "neutral"}`}
            disabled={!entered || invalid || balances === null || !!problem || !open || loading || sending || over}
            onClick={() => void submit()}
          >
            {sending ? "Confirm in your wallet…" : !entered ? "Enter an amount" : depositing ? "Deposit" : "Withdraw"}
          </button>
        ) : (
          <button className="btn block" onClick={() => void connect()} disabled={status === "connecting"}>
            {status === "connecting" ? "Connecting…" : "Connect wallet"}
          </button>
        )}

        <p className={`hint${invalid || over || problem ? " bad" : ""}`}>{hint}</p>
        {receipt && <p className={`hint ${receipt.ok ? "good" : "bad"}`} role="status">{receipt.text}</p>}

        {entered && depositing && dep && (
          <div className="rows tk-sum">
            <div className={dep.haircut > 0n ? "hi" : undefined}>
              <span>Haircut</span>
              <b>{dep.haircut > 0n ? `−${fmtUsd(dep.haircut, 2)}` : "none"}</b>
            </div>
            <div><span>Value added</span><b>${fmtUsd(dep.netValue, 2)}</b></div>
            <div><span>Share of pool</span><b>{fmtPct(dep.shareOfPool, 3)}</b></div>
          </div>
        )}
        {entered && !depositing && red && (
          <div className="rows tk-sum">
            <div className="hi"><span>Total value</span><b>${fmtUsd(red.totalValue, 2)}</b></div>
            <div><span>CLP left</span><b>{balance !== null && balance >= raw ? fmtUsd(balance - raw, 2) : "-"}</b></div>
          </div>
        )}

        {IS_SAMPLE && connected && balances && (
          <dl className="earn-facts earn-mine">
            <div><dt>Your CLP</dt><dd>{fmtUsd(balances.clp, 2)}</dd></div>
            <div><dt>Value</dt><dd>${fmtUsd(held, 2)}</dd></div>
            <div><dt>Share of the pool</dt><dd>{share.toFixed(3)}%</dd></div>
          </dl>
        )}

        <p className="sub">
          No fractions yet? <Link href="/vault" className="link">Vault a card →</Link>
        </p>
        <p className="fine">
          {IS_SAMPLE
            ? "Simulated in this browser until the programs are deployed. Nothing is signed or settled on-chain."
            : `Reading and settling on ${clusterName()}.`}
        </p>
      </aside>

      <div className="earn-stack">
        <LpPosition data={data} balances={balances} wallet={connected ? publicKey : null} />

        <section className="panel earn-pool">
          <h2>Liquidity allocation</h2>
          <table className="earn-alloc">
            <thead>
              <tr>
                <th>Token</th>
                <th>Pool size</th>
                <th>Weight / cap</th>
                <th>Deposit haircut</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <span className="asset">
                    <UsdcCoin />
                    <span>
                      <span className="nm">{USD_LABEL}</span>
                      <span className="id">Pays winning trades</span>
                    </span>
                  </span>
                </td>
                <td>
                  {data ? `$${fmtUsd(data.pool.usdcSleeve, 2)}` : "-"}
                  <small>{data ? `${fmtUsd(data.pool.usdcSleeve, 2)} ${USD_LABEL}` : ""}</small>
                </td>
                <td>{data ? fmtPct(data.poolStats.usdcSleeveShare, 2) : "-"} <small>/ no cap</small></td>
                <td>None</td>
              </tr>
              <tr>
                <td>
                  <span className="asset">
                    <KadexCoin />
                    <span>
                      <span className="nm">Card fractions</span>
                      <span className="id">Tokenized graded cards</span>
                    </span>
                  </span>
                </td>
                <td>
                  {data ? `$${fmtUsd(data.pool.cardSleeveValue, 2)}` : "-"}
                  <small>{data ? `${fmtUsd(data.fractionBalance, 2)} fractions` : ""}</small>
                </td>
                <td>
                  {data ? fmtPct(data.poolStats.cardSleeveShare, 2) : "-"}{" "}
                  <small>/ {data ? fmtPct(data.pool.params.cardSleeveTarget, 2) : "-"}</small>
                </td>
                <td>{haircutPct}%</td>
              </tr>
            </tbody>
          </table>

          <dl className="earn-facts">
            <div><dt>Total supply</dt><dd>{data ? `${fmtUsd(data.pool.clpSupply, 2)} CLP` : "-"}</dd></div>
          </dl>
        </section>

        <section className="panel faq" id="earn-faq">
          <h2 className="title sm" style={{ marginBottom: 6 }}>Before you deposit</h2>
          <details className="acc" open>
            <summary>What am I buying?</summary>
            <p>
              CLP is a claim on the pool&rsquo;s net asset value. It holds {USD_LABEL} on one side and
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
              A redemption returns a proportional slice of both sleeves — {USD_LABEL} and card fractions
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
