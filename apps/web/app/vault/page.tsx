"use client";

/**
 * The card vault — role 3 in docs/users.md.
 *
 * Mirrors programs/card-vault, including the two parts people get wrong:
 * whitelisting is admin-only (an open mint would let anyone price their own
 * collateral into the index), and redeeming the card burns the ENTIRE fraction
 * supply. Both are stated before the deposit button rather than after it.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { CONSTITUENTS, fmtBps, fmtUsd } from "@/lib/market";
import { Thumb } from "@/components/Slab";
import { useWallet } from "@/lib/wallet";

/** Mirrors `fractions_for_value`: 1 fraction = $1, both 6 decimals, so 1:1. */
const fractionsForValue = (valueUsdc: bigint) => valueUsdc;

const STEPS = [
  ["Graded and whitelisted", "A professional grade and an appraisal fix how many fractions the card is worth, and an admin whitelists the mint at that number. Permissioned on purpose: an open mint would let anyone price their own collateral into an index other people's positions settle against."],
  ["You deposit it", "The NFT representing custody moves into a program escrow and the vault mints exactly the whitelisted number of fractions — never a number chosen at deposit time. The card is locked for as long as those fractions exist."],
  ["The fractions are yours", "Hold them, provide liquidity with them, or deposit them into the CLP pool for a share of trading fees. Ordinary tokens with six decimals, priced one to one against a dollar at parity."],
  ["Getting the card back", "Redemption burns the entire fraction supply and returns the NFT. If you have sold or deposited any of them, you have to buy them all back first. This is the real cost of fractionalising something indivisible."],
] as const;

export default function VaultPage() {
  const { status, publicKey, connect } = useWallet();
  const [appraisal, setAppraisal] = useState("");
  const [selected, setSelected] = useState(CONSTITUENTS[0]!.id);

  const connected = status === "connected" && publicKey !== null;
  const value = useMemo(() => {
    const n = Number(appraisal.replace(/,/g, ""));
    return !Number.isFinite(n) || n <= 0 ? 0n : BigInt(Math.trunc(n * 1e6));
  }, [appraisal]);

  const card = CONSTITUENTS.find((c) => c.id === selected) ?? CONSTITUENTS[0]!;

  return (
    <div className="page">
      <section className="hero" style={{ minHeight: 320 }}>
        <div className="hero-copy">
          <p className="kicker">04 / Vault</p>
          <h1 className="display">Put a card in.</h1>
          <p className="lede">
            A graded collectible becomes fractions you can trade, lend or redeem.
          </p>
        </div>
      </section>

      <div className="trade-layout">
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <section className="panel prose">
            <h2 className="title" style={{ marginBottom: 6 }}>How it works</h2>
            {STEPS.map(([h, body], i) => (
              <div key={h}>
                <h3>
                  {i + 1} · {h}
                </h3>
                <p>{body}</p>
              </div>
            ))}
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2 className="title">Whitelisted cards</h2>
                <p className="sub">Only these can be vaulted.</p>
              </div>
            </div>
            <div className="t-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Card</th>
                    <th>Reference</th>
                    <th className="r">Index weight</th>
                    <th className="r">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {CONSTITUENTS.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <span className="asset">
                          <Thumb art={c.art} />
                          <span>
                            <span className="nm">{c.name}</span>
                            <span className="id">{c.year} · {c.grade}</span>
                          </span>
                        </span>
                      </td>
                      <td className="n">{c.ref}</td>
                      <td className="r n">{fmtBps(c.weightBps)}</td>
                      <td className="r">
                        <span className="dot" style={{ background: "var(--up)" }} />
                        Enabled
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside className="panel ticket">
          <div>
            <p className="kicker" style={{ margin: 0 }}>Vault / Deposit</p>
            <h2 className="title" style={{ marginTop: 8 }}>Fractionalise</h2>
            <p className="sub">Lock a card, mint its fractions.</p>
          </div>

          <label className="field">
            <span>Card</span>
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {CONSTITUENTS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.ref}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Appraised value · USDC</span>
            <input
              inputMode="decimal"
              autoComplete="off"
              placeholder="—"
              value={appraisal}
              onChange={(e) => setAppraisal(e.target.value.replace(/[^0-9.,]/g, ""))}
            />
          </label>

          <p className="hint" style={{ marginTop: -6 }}>
            {connected ? "Set at whitelisting, not at deposit" : "Connect a wallet to continue"}
          </p>

          {value > 0n && (
            <>
              <hr className="sep" />
              <div className="rows">
                <div><span>Card</span><b>{card.name}</b></div>
                <div><span>Grade</span><b>{card.grade}</b></div>
                <div><span>Fractions minted</span><b>{fmtUsd(fractionsForValue(value), 2)}</b></div>
                <div className="hi"><span>To redeem, burn</span><b>{fmtUsd(fractionsForValue(value), 2)}</b></div>
              </div>
            </>
          )}

          {connected ? (
            <button className="btn block" disabled={value <= 0n}>
              {value > 0n ? "Vault this card" : "Enter an appraisal"}
            </button>
          ) : (
            <button className="btn block" onClick={() => void connect()} disabled={status === "connecting"}>
              {status === "connecting" ? "Connecting…" : "Connect wallet"}
            </button>
          )}

          <p className="hint bad" style={{ margin: 0 }}>
            The card stays locked until every fraction is burned.
          </p>

          <hr className="sep" />
          <p className="sub">
            Got fractions already? <Link href="/pool" className="link">Deposit them →</Link>
          </p>

          <p className="fine">
            {connected
              ? "Vaulting requires the programs to be deployed. Nothing is signed or settled here yet."
              : "Visual concept only"}
          </p>
        </aside>
      </div>
    </div>
  );
}
