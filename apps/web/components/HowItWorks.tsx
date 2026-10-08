"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useWallet, shortKey } from "@/lib/wallet";
import { EarnStage, TradeStage, VaultStage } from "@/components/WelcomeDialog";

function WalletStage({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="wstage">
      <div className="wwallet">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <rect x="2" y="4.5" width="16" height="12" rx="3" stroke="currentColor" strokeWidth="1.6" />
          <path d="M13.5 10.5h1.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span>
          <b>{label}</b>
          <em>{detail}</em>
        </span>
        <i aria-hidden="true">›</i>
      </div>
    </div>
  );
}

interface Step {
  title: string;
  body: string;
  stage: ReactNode;
  action: ReactNode;
}

export function HowItWorks({ onTrade }: { onTrade(): void }) {
  const { status, publicKey, connect } = useWallet();
  const connected = status === "connected" && publicKey !== null;

  const steps: Step[] = [
    {
      title: "Connect a wallet",
      body: "Any Solana wallet works. You only need USDC for margin and a little SOL for fees.",
      stage: connected
        ? <WalletStage label={shortKey(publicKey)} detail="Connected" />
        : <WalletStage label="Solana wallet" detail="Phantom, Solflare, Backpack" />,
      action: connected
        ? <span className="how-done">Connected</span>
        : (
          <button type="button" className="link" onClick={() => void connect()} disabled={status === "connecting"}>
            {status === "connecting" ? "Connecting…" : "Connect wallet →"}
          </button>
        ),
    },
    {
      title: "Pick a side on the index",
      body: "Long if you think graded cards go up, short if you think they fall. 5x, margin in USDC.",
      stage: <TradeStage />,
      action: <button type="button" className="link" onClick={onTrade}>Open the ticket →</button>,
    },
    {
      title: "Or earn as the house",
      body: "Deposit into the pool and collect the fees traders pay. You take the other side of their trades.",
      stage: <EarnStage />,
      action: <Link href="/pool" className="link">Go to Earn →</Link>,
    },
    {
      title: "Own a slab? Put it to work",
      body: "Vault a graded card for fractions worth its appraisal. Redeem the card when you hold them all.",
      stage: <VaultStage />,
      action: <Link href="/vault" className="link">Go to Vault →</Link>,
    },
  ];

  return (
    <section className="how" aria-labelledby="how-h">
      <header className="how-head">
        <h2 id="how-h">How it works</h2>
        <p>Four steps. The first two are all you need to trade.</p>
      </header>
      <ol className="how-steps">
        {steps.map((step, i) => (
          <li key={step.title} className="panel how-step">
            <div className="how-media">{step.stage}</div>
            <div className="how-body">
              <span className="how-num">{i + 1}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
              {step.action}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
