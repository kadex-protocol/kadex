"use client";

/**
 * The card vault — how a physical collectible becomes something tradeable.
 *
 * Mirrors `programs/card-vault` exactly, including the two parts people get
 * wrong:
 *
 *  1. A card must be whitelisted before it can be vaulted. This is admin-only
 *     and it is not a placeholder for permissionless listing — an open mint
 *     would let anyone price their own collateral into the index.
 *  2. Redeeming the card back requires the ENTIRE fraction supply. Once the
 *     fractions are sold or deposited elsewhere, getting the physical card out
 *     means buying all of them back. That is the trade, and it is stated on
 *     the screen rather than discovered afterwards.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { CONSTITUENTS, fmtBps, fmtUsd } from "@/lib/market";
import { Slab } from "@/components/Slab";
import { useWallet } from "@/lib/wallet";

/**
 * Fractions minted for an appraised value.
 *
 * Mirrors `fractions_for_value` in the vault program: 1 fraction = $1, and
 * both sides carry 6 decimals, so this is 1:1 in native units. The matching
 * decimals are what let `price × quantity` land directly in native USDC with
 * no conversion step to get wrong.
 */
const fractionsForValue = (valueUsdc: bigint) => valueUsdc;

export default function VaultPage() {
  const { status, publicKey, connect } = useWallet();
  const [appraisal, setAppraisal] = useState("");
  const [selected, setSelected] = useState(CONSTITUENTS[0]!.id);

  const connected = status === "connected" && publicKey !== null;

  const value = useMemo(() => {
    const n = Number(appraisal.replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return BigInt(Math.trunc(n * 1e6));
  }, [appraisal]);

  const fractions = fractionsForValue(value);
  const card = CONSTITUENTS.find((c) => c.id === selected) ?? CONSTITUENTS[0]!;

  return (
    <div className="columns">
      <main className="main-col">
        <p className="eyebrow">05 / Vault</p>
        <h1 className="display">Put a card in.</h1>
        <p className="standfirst">
          A graded collectible becomes fractions you can trade, lend or redeem.
        </p>

        <div className="slabs" style={{ marginTop: 26, maxWidth: 500 }}>
          {CONSTITUENTS.slice(0, 2).map((c) => (
            <Slab key={c.id} item={c} />
          ))}
        </div>

        <p className="slab-caption">
          Custody &amp; grading
          <small>Illustrative artwork</small>
        </p>

        <div className="prose" style={{ marginTop: 30 }}>
          <h3>1 · The card is graded and whitelisted</h3>
          <p>
            A professional grade and an appraisal fix how many fractions the card is worth. An
            admin whitelists the mint at that number. This step is permissioned on purpose: an
            open mint would let anyone price their own collateral into an index that other
            people&rsquo;s positions are settled against.
          </p>

          <h3>2 · You deposit it</h3>
          <p>
            The NFT representing custody moves into a program escrow and the vault mints you
            exactly the whitelisted number of fractions — never a number chosen at deposit time.
            The card is locked for as long as those fractions exist.
          </p>

          <h3>3 · The fractions are yours</h3>
          <p>
            Hold them, provide liquidity with them, or deposit them into the CLP pool for a share
            of trading fees. They are ordinary tokens with six decimals, priced one to one against
            a dollar at parity.
          </p>

          <h3>4 · Getting the card back</h3>
          <p>
            Redemption burns the <em>entire</em> fraction supply and returns the NFT. If you have
            sold or deposited any of them, you have to buy them all back first. This is the real
            cost of fractionalising something indivisible, and it is worth understanding before
            step two rather than after it.
          </p>
        </div>

        <div className="table-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Whitelisted card</th>
                <th scope="col">Reference</th>
                <th scope="col" className="num">Index weight</th>
                <th scope="col" className="num">Status</th>
              </tr>
            </thead>
            <tbody>
              {CONSTITUENTS.map((c) => (
                <tr key={c.id}>
                  <td className="name">{c.name}</td>
                  <td style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--ink-soft)" }}>
                    {c.ref}
                  </td>
                  <td className="num">{fmtBps(c.weightBps)}</td>
                  <td className="num">
                    <span className="tag">Enabled</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>

      <div className="side-col">
        <aside className="ticket">
          <p className="eyebrow" style={{ margin: 0 }}>Vault / Deposit</p>
          <div>
            <h2>Fractionalise</h2>
            <p className="subhead">Lock a card, mint its fractions</p>
          </div>

          <div className="field">
            <label htmlFor="card">Card</label>
            <select
              id="card"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              style={{
                width: "100%",
                border: "1px solid var(--rule)",
                background: "transparent",
                padding: "11px 12px",
                fontFamily: "var(--mono)",
                fontSize: 15,
                color: "var(--ink)",
              }}
            >
              {CONSTITUENTS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.ref}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="appraisal">Appraised value · USDC</label>
            <input
              id="appraisal"
              inputMode="decimal"
              autoComplete="off"
              placeholder="—"
              value={appraisal}
              onChange={(e) => setAppraisal(e.target.value.replace(/[^0-9.,]/g, ""))}
              aria-describedby="appraisal-help"
            />
            <p id="appraisal-help" className="helper">
              {connected
                ? "Set at whitelisting, not at deposit"
                : "Connect a wallet to continue"}
            </p>
          </div>

          {value > 0n && (
            <div className="readout">
              <div><span>Card</span><b>{card.name}</b></div>
              <div><span>Grade</span><b>{card.grade}</b></div>
              <div><span>Fractions minted</span><b>{fmtUsd(fractions, 2)}</b></div>
              <div><span>To redeem, burn</span><b>{fmtUsd(fractions, 2)}</b></div>
            </div>
          )}

          {connected ? (
            <button className="primary" disabled={value <= 0n}>
              {value > 0n ? "Vault this card" : "Enter an appraisal"}
            </button>
          ) : (
            <button className="primary" onClick={() => void connect()} disabled={status === "connecting"}>
              {status === "connecting" ? "Connecting…" : "Connect wallet"}
            </button>
          )}

          <p className="helper warn" style={{ margin: 0 }}>
            The card stays locked until every fraction is burned.
          </p>

          <hr className="rule" />

          <p className="body">
            Got fractions already?{" "}
            <Link href="/pool" className="link-action">Deposit them&nbsp;→</Link>
          </p>

          <p className="fineprint">
            {connected
              ? "Vaulting requires the programs to be deployed. Nothing is signed or settled here yet."
              : "Visual concept only"}
          </p>
        </aside>
      </div>
    </div>
  );
}
