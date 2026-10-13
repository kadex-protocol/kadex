"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { fmtPrice, fmtUsd, type MarketSnapshot } from "@/lib/market";
import { USD_LABEL } from "@/lib/cluster";
import type { VaultCard } from "@/lib/collectorCrypt";
import { titleParts } from "@/lib/cardText";
import { useWallet, shortKey } from "@/lib/wallet";

const EXAMPLE_DEPOSIT = 1000;
const WALLETS = [
  { name: "Phantom", icon: "/wallets/phantom.svg" },
  { name: "Solflare", icon: "/wallets/solflare.svg" },
  { name: "Backpack", icon: "/wallets/backpack.png" },
];
const INDEX_LINE = "M0 66C16 62 24 44 42 47S68 70 86 62 110 32 130 38 156 63 174 55 202 24 224 32 250 47 266 36";

function Step({ n, title, body, action, children }: { n: number; title: string; body: string; action: ReactNode; children: ReactNode }) {
  return (
    <li className="panel hw-step">
      <div className="hw-copy">
        <span className="hw-num">{n}</span>
        <h3>{title}</h3>
        <p>{body}</p>
        {action}
      </div>
      <div className="hw-demo live" aria-hidden="true">{children}</div>
    </li>
  );
}

export function HowItWorks({ cards, data, onTrade }: { cards: VaultCard[]; data: MarketSnapshot | null; onTrade(): void }) {
  const { status, publicKey, walletName, detected, connect } = useWallet();
  const connected = status === "connected" && publicKey !== null;
  const walletState = (name: string) => {
    const key = name.toLowerCase();
    if (connected && walletName?.toLowerCase().startsWith(key)) return "Connected";
    return detected.some((wallet) => wallet.toLowerCase().startsWith(key)) ? "Detected" : "Supported";
  };
  const lead = WALLETS.find((wallet) => walletState(wallet.name) !== "Supported") ?? WALLETS[0]!;
  const withArt = cards.filter((card) => card.frontImage);
  const slab = withArt.find((card) => card.vaultable) ?? withArt[0] ?? null;
  const behind = withArt.find((card) => card !== slab) ?? null;
  const slabTitle = slab ? titleParts(slab) : null;
  const clpPrice = data ? Number(fmtPrice(data.poolStats.clpPrice)) : 0;

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
          body={`Connect a supported Solana wallet. You need ${USD_LABEL} for margin and a little SOL for fees.`}
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
          <ul className="hwd hwd-wallets">
            {WALLETS.map((wallet) => (
              <li key={wallet.name} className={wallet === lead ? "on" : undefined}>
                <img src={wallet.icon} alt="" />
                <span>
                  <b>{wallet.name}</b>
                  <em>{walletState(wallet.name)}</em>
                </span>
                <i>{wallet === lead ? "Connect" : "›"}</i>
              </li>
            ))}
          </ul>
        </Step>

        <Step
          n={2}
          title="Pick a side on the index"
          body={`Long if you think graded cards go up, short if you think they fall. ${data ? `${Number(data.pool.params.baseLeverage) / 1e6}x, with` : "Use"} ${USD_LABEL} as margin.`}
          action={<button type="button" className="btn" onClick={onTrade}>Open the ticket</button>}
        >
          <div className="hwd hwd-trade">
            <div className="hwd-index">
              <img src="/logo.png" alt="" />
              <b>Kadex Index</b>
              <em>{data ? fmtPrice(data.oracle.price) : "-"}</em>
            </div>
            <svg viewBox="0 0 300 90" preserveAspectRatio="none" fill="none">
              <path d={`${INDEX_LINE}L266 90H0Z`} fill="url(#hwd-fill)" />
              <path d={INDEX_LINE} stroke="currentColor" strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              <path d="M270 36H300" stroke="currentColor" strokeOpacity=".4" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
              <defs>
                <linearGradient id="hwd-fill" x1="0" y1="20" x2="0" y2="90" gradientUnits="userSpaceOnUse">
                  <stop stopColor="currentColor" stopOpacity=".14" />
                  <stop offset="1" stopColor="currentColor" stopOpacity="0" />
                </linearGradient>
              </defs>
            </svg>
            <div className="hwd-sides">
              <span className="l">
                <b>Long</b>
                <em>Profit if the index rises</em>
              </span>
              <span className="s">
                <b>Short</b>
                <em>Profit if the index falls</em>
              </span>
            </div>
          </div>
        </Step>

        <Step
          n={3}
          title="Or earn as the house"
          body="Deposit into the pool and collect the fees traders pay. You take the other side of their trades."
          action={<Link href="/pool" className="btn">Go to Earn</Link>}
        >
          <div className="hwd hwd-earn">
            <div className="hwd-box">
              <span>You deposit</span>
              <b>{fmtAmount(EXAMPLE_DEPOSIT)}</b>
              <em><img src="/tokens/usdc.svg" alt="" />{USD_LABEL}</em>
            </div>
            <div className="hwd-box">
              <span>You receive</span>
              <b>{clpPrice > 0 ? fmtAmount(EXAMPLE_DEPOSIT / clpPrice) : "-"}</b>
              <em><img src="/logo.png" alt="" />CLP</em>
            </div>
            <p className="hwd-foot">
              <span>Traders pay the pool</span>
              <b>Fees + borrow</b>
            </p>
          </div>
        </Step>

        <Step
          n={4}
          title="Own a slab? Put it to work"
          body="Vault a graded card for fractions worth its appraisal. Redeem the card when you hold them all."
          action={<Link href="/vault" className="btn">Go to Vault</Link>}
        >
          <div className="hwd hwd-vault">
            <div className="hwd-slabs">
              {behind && <img className="b" src={behind.frontImage!} alt="" loading="lazy" />}
              {slab ? <img src={slab.frontImage!} alt="" loading="lazy" /> : <span />}
            </div>
            <div className="hwd-card">
              <b>{slabTitle?.title ?? "A graded card"}</b>
              <em>{slabTitle?.grade ?? "Graded and held in custody"}</em>
              <dl>
                <div><dt>Appraised value</dt><dd>{slab ? `$${fmtUsd(slab.insuredValueUsdc, 2)}` : "-"}</dd></div>
                <div><dt>You receive</dt><dd>{slab ? `${fmtUsd(slab.insuredValueUsdc, 2)} fractions` : "-"}</dd></div>
                <div><dt>To redeem</dt><dd>All fractions</dd></div>
              </dl>
            </div>
          </div>
        </Step>
      </ol>
    </section>
  );
}

function fmtAmount(value: number) {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
