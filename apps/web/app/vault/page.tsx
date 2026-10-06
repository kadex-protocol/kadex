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
import { Slab, Thumb } from "@/components/Slab";
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
      <header className="page-head">
        <h1 className="display">Vault a card</h1>
        <p className="lede">
          Lock a graded collectible and receive fractions you can hold, trade or deposit to earn —
          without selling the card.
        </p>
      </header>

      <div className="layout">
        <div className="col">
          <section className="panel">
            <div className="panel-head">
              <h2 className="title sm">1 · Choose a card</h2>
              <span className="sub">Only whitelisted cards can be vaulted</span>
            </div>
            <div className="picker" role="radiogroup" aria-label="Card to vault">
              {CONSTITUENTS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={c.id === selected}
                  className="pick"
                  onClick={() => setSelected(c.id)}
                >
                  <Slab item={c} />
                  <span className="nm">{c.name}</span>
                  <span className="id">{c.grade} · {fmtBps(c.weightBps)} of index</span>
                </button>
              ))}
            </div>
          </section>

          <section className="panel faq">
            <h2 className="title sm" style={{ marginBottom: 6 }}>How vaulting works</h2>
            {STEPS.map(([h, body], i) => (
              <details className="acc" key={h} open={i === 3}>
                <summary>{i + 1} · {h}</summary>
                <p>{body}</p>
              </details>
            ))}
          </section>
        </div>

        <aside className="panel ticket">
          <h2 className="sr-only">Vault this card</h2>
          <div className="asset chosen">
            <Thumb art={card.art} />
            <span>
              <span className="nm">{card.name}</span>
              <span className="id">{card.year} · {card.grade} · {card.ref}</span>
            </span>
          </div>

          <div className="token-input">
            <div className="ti-top">
              <span>2 · Appraised value</span>
              <span>Set at whitelisting</span>
            </div>
            <div className="ti-row">
              <input
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                aria-label="Appraised value in USDC"
                value={appraisal}
                onChange={(e) => setAppraisal(e.target.value.replace(/[^0-9.,]/g, ""))}
              />
              <span className="token">USDC</span>
            </div>
          </div>

          <div className="rows">
            <div><span>You receive</span><b>{value > 0n ? `${fmtUsd(fractionsForValue(value), 2)} fractions` : "—"}</b></div>
            <div className={value > 0n ? "hi" : undefined}><span>To get the card back, burn</span><b>{value > 0n ? fmtUsd(fractionsForValue(value), 2) : "—"}</b></div>
          </div>

          {connected ? (
            <button className="btn block" disabled={value <= 0n}>
              {value > 0n ? "3 · Vault this card" : "Enter the appraisal"}
            </button>
          ) : (
            <button className="btn block" onClick={() => void connect()} disabled={status === "connecting"}>
              {status === "connecting" ? "Connecting…" : "Connect wallet"}
            </button>
          )}

          <p className="hint bad" style={{ margin: 0 }}>
            The card stays locked until every fraction is burned.
          </p>

          <p className="sub" style={{ margin: 0 }}>
            Already have fractions? <Link href="/pool" className="link">Deposit them to earn →</Link>
          </p>

          <p className="fine">
            Vaulting requires the programs to be deployed. Nothing is signed or settled here yet.
          </p>
        </aside>
      </div>
    </div>
  );
}
