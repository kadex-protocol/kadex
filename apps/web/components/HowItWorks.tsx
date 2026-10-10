"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { fmtPct, fmtPrice, fmtUsd, quote, type MarketSnapshot } from "@/lib/market";
import type { VaultCard } from "@/lib/collectorCrypt";
import { titleParts } from "@/lib/cardText";
import { useWallet, shortKey } from "@/lib/wallet";

const EXAMPLE_NOTIONAL = 1_000_000_000n;
const WALLETS = [
  { name: "Phantom", icon: "/wallets/phantom.svg" },
  { name: "Solflare", icon: null },
  { name: "Backpack", icon: null },
];

function Step({ n, title, body, action, children }: { n: number; title: string; body: string; action: ReactNode; children: ReactNode }) {
  return (
    <li className="panel hw-step">
      <div className="hw-copy">
        <span className="hw-num">{n}</span>
        <h3>{title}</h3>
        <p>{body}</p>
        {action}
      </div>
      <div className="hw-demo" aria-hidden="true">{children}</div>
    </li>
  );
}

export function HowItWorks({ cards, data, onTrade }: { cards: VaultCard[]; data: MarketSnapshot | null; onTrade(): void }) {
  const { status, publicKey, connect } = useWallet();
  const connected = status === "connected" && publicKey !== null;
  const example = data ? quote(data, "long", EXAMPLE_NOTIONAL) : null;
  const slab = cards.find((c) => c.frontImage && c.vaultable) ?? cards.find((c) => c.frontImage) ?? null;
  const slabTitle = slab ? titleParts(slab) : null;

  return (
    <section className="how" aria-labelledby="how-h">
      <header className="how-head">
        <h2 id="how-h">How it works</h2>
        <p>Four steps. The first two are all you need to trade.</p>
      </header>

      <ol className="hw-steps">
        <Step
          n={1}
          title="Connect a wallet"
          body="Any Solana wallet works. You only need USDC for margin and a little SOL for fees."
          action={
            connected ? (
              <span className="hw-done">Connected · {shortKey(publicKey)}</span>
            ) : (
              <button type="button" className="btn" onClick={() => void connect()} disabled={status === "connecting"}>
                {status === "connecting" ? "Connecting…" : "Connect wallet"}
              </button>
            )
          }
        >
          <ul className="wconnect-list">
            {WALLETS.map((w, i) => (
              <li key={w.name}>
                <div className="hw-row">
                  {w.icon ? <img src={w.icon} alt="" /> : <span className="wconnect-ico">{w.name[0]}</span>}
                  <span>
                    <b>{w.name}</b>
                    <em>{i === 0 ? (connected ? "Connected" : "Detected") : "Supported"}</em>
                  </span>
                  <i>›</i>
                </div>
              </li>
            ))}
          </ul>
        </Step>

        <Step
          n={2}
          title="Pick a side on the index"
          body="Long if you think graded cards go up, short if you think they fall. 5x, with USDC as margin."
          action={<button type="button" className="btn" onClick={onTrade}>Open the ticket</button>}
        >
          <div className="hw-ticket">
            <div className="hw-sides">
              <span className="l on">Long</span>
              <span className="s">Short</span>
            </div>
            <div className="hw-amount">
              <span>Order size</span>
              <b>1,000.00</b>
              <span className="tk-asset"><span className="coin usdc" />USDC</span>
            </div>
            <dl className="hw-rows">
              <div><dt>Entry price</dt><dd>{example ? fmtPrice(example.entryPrice) : "-"}</dd></div>
              <div><dt>Margin required</dt><dd>{example ? `$${fmtUsd(example.margin, 2)}` : "-"}</dd></div>
              <div><dt>Est. liquidation price</dt><dd>{example ? fmtPrice(example.liquidationPrice) : "-"}</dd></div>
            </dl>
          </div>
        </Step>

        <Step
          n={3}
          title="Or earn as the house"
          body="Deposit into the pool and collect the fees traders pay. You take the other side of their trades."
          action={<Link href="/pool" className="btn">Go to Earn</Link>}
        >
          <div className="hw-pool">
            <div className="hw-figures">
              <div><span>Pool value</span><b>{data ? `$${fmtUsd(data.poolStats.nav)}` : "-"}</b></div>
              <div><span>CLP price</span><b>{data ? fmtPrice(data.poolStats.clpPrice) : "-"}</b></div>
            </div>
            {([
              ["USDC", data?.poolStats.usdcSleeveShare],
              ["Card fractions", data?.poolStats.cardSleeveShare],
              ["In use by traders", data?.capacity.utilization],
            ] as const).map(([label, value]) => (
              <div className="hw-bar" key={label}>
                <div><span>{label}</span><b>{value !== undefined ? fmtPct(value, 1) : "-"}</b></div>
                <i><i style={{ width: value !== undefined ? fmtPct(value, 1) : "0%" }} /></i>
              </div>
            ))}
          </div>
        </Step>

        <Step
          n={4}
          title="Own a slab? Put it to work"
          body="Vault a graded card for fractions worth its appraisal. Redeem the card when you hold them all."
          action={<Link href="/vault" className="btn">Go to Vault</Link>}
        >
          <div className="hw-vault">
            {slab ? <img src={slab.frontImage!} alt="" loading="lazy" /> : <span className="hw-blank" />}
            <div>
              <b>{slabTitle?.title ?? "A graded card"}</b>
              <em>{slabTitle?.grade ?? "Graded and held in custody"}</em>
              <dl className="hw-rows">
                <div><dt>Appraised value</dt><dd>{slab ? `$${fmtUsd(slab.insuredValueUsdc, 2)}` : "-"}</dd></div>
                <div><dt>You receive</dt><dd>{slab ? `${fmtUsd(slab.insuredValueUsdc, 2)} fractions` : "-"}</dd></div>
              </dl>
            </div>
          </div>
        </Step>
      </ol>
    </section>
  );
}
