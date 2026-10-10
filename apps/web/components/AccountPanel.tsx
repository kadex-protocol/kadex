"use client";

import { useState } from "react";
import Link from "next/link";
import type { PositionView } from "@kadex/types";
import { CONSTITUENTS, fmtPrice, fmtUsd, type MarketSnapshot, type Portfolio } from "@/lib/market";
import { useWallet } from "@/lib/wallet";
import { PositionsTable } from "@/components/PositionsTable";
import { Thumb } from "@/components/Slab";

type Tab = "positions" | "cards" | "shares";

const constituent = (id: string) => CONSTITUENTS.find((c) => c.id === id) ?? CONSTITUENTS[0]!;
const signed = (x: bigint) => `${x >= 0n ? "+" : "−"}$${fmtUsd(x < 0n ? -x : x, 2)}`;

interface Props {
  portfolio: Portfolio | null;
  positions: PositionView[];
  snapshot: MarketSnapshot | null;
  onTrade(): void;
  onClosed(): void;
}

export function AccountPanel({ portfolio, positions, snapshot, onTrade, onClosed }: Props) {
  const { status, publicKey, connect } = useWallet();
  const [tab, setTab] = useState<Tab>("positions");
  const connected = status === "connected" && publicKey !== null;

  const rows = portfolio?.rows ?? [];
  const cards = portfolio?.cards ?? [];
  const clp = portfolio?.clp ?? 0n;
  const tabs: [Tab, string, number][] = [
    ["positions", "Positions", positions.length || rows.length],
    ["cards", "Vaulted cards", cards.length],
    ["shares", "Pool shares", clp > 0n ? 1 : 0],
  ];
  const poolShare = snapshot && snapshot.pool.clpSupply > 0n ? (Number(clp) / Number(snapshot.pool.clpSupply)) * 100 : 0;

  return (
    <section className="panel acct" aria-labelledby="acct-h">
      <header className="acct-head">
        <h2 id="acct-h">Your account</h2>
        <div className="acct-tabs" role="group" aria-label="Holdings">
          {tabs.map(([id, label, count]) => (
            <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>
              {label}
              <span>{connected ? count : 0}</span>
            </button>
          ))}
        </div>
        <Link href="/portfolio" className="acct-all">Portfolio →</Link>
      </header>

      {!connected ? (
        <div className="acct-empty">
          <b>Connect a wallet to see what you hold</b>
          <p>Open positions, vaulted cards and pool shares are read against your address.</p>
          <button type="button" className="btn accent" onClick={() => void connect()} disabled={status === "connecting"}>
            {status === "connecting" ? "Connecting…" : "Connect wallet"}
          </button>
        </div>
      ) : tab === "positions" ? (
        positions.length > 0 ? (
          <PositionsTable positions={positions} markPrice={snapshot?.oracle.price ?? null} onClosed={onClosed} />
        ) : rows.length > 0 ? (
          <div className="t-wrap pos-table">
            <table className="t">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Side</th>
                  <th className="r">Size</th>
                  <th className="r">Entry</th>
                  <th className="r">Mark</th>
                  <th className="r">PnL</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const c = constituent(r.constituentId);
                  return (
                    <tr key={i}>
                      <td>
                        <span className="asset">
                          <Thumb src={c.image} />
                          <span>
                            <span className="nm">{c.name}</span>
                            <span className="id">{r.leverage}x · margin ${fmtUsd(r.margin, 2)}</span>
                          </span>
                        </span>
                      </td>
                      <td><span className={`pill ${r.side}`}>{r.side}</span></td>
                      <td className="r n">${fmtUsd(r.notional, 2)}</td>
                      <td className="r n">{fmtPrice(r.entryPrice)}</td>
                      <td className="r n">{fmtPrice(r.markPrice)}</td>
                      <td className={`r n ${r.pnl >= 0n ? "up" : "down"}`}>
                        {signed(r.pnl)}
                        <span className="id">{r.pnlPct >= 0 ? "+" : ""}{r.pnlPct.toFixed(2)}%</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="acct-empty">
            <b>No open positions</b>
            <p>Pick a side and a size in the ticket and it shows up here.</p>
            <button type="button" className="btn" onClick={onTrade}>Open the ticket</button>
          </div>
        )
      ) : tab === "cards" ? (
        cards.length > 0 ? (
          <ul className="acct-cards">
            {cards.map((h) => {
              const c = constituent(h.constituentId);
              const whole = h.held === h.minted;
              const share = h.minted > 0n ? Number((h.held * 10_000n) / h.minted) / 100 : 0;
              return (
                <li key={h.constituentId}>
                  <span className="asset">
                    <Thumb src={c.image} />
                    <span>
                      <span className="nm">{c.name}</span>
                      <span className="id">{c.year} · {c.grade}</span>
                    </span>
                  </span>
                  <div className="acct-frac">
                    <div>
                      <span>In your wallet</span>
                      <b>{fmtUsd(h.held)} <em>of {fmtUsd(h.minted)}</em></b>
                    </div>
                    <i><i style={{ width: `${share}%` }} /></i>
                  </div>
                  <span className={`acct-chip${whole ? " ok" : ""}`}>
                    {whole ? "Redeemable" : `${fmtUsd(h.inPool)} in the pool`}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="acct-empty">
            <b>No cards vaulted</b>
            <p>Vault a graded card and its fractions show up here.</p>
            <Link href="/vault" className="btn">Go to Vault</Link>
          </div>
        )
      ) : clp > 0n ? (
        <div className="acct-shares">
          <div>
            <span>CLP held</span>
            <b>{fmtUsd(clp, 2)}</b>
          </div>
          <div>
            <span>Worth at NAV</span>
            <b>${fmtUsd(portfolio?.clpValue ?? 0n, 2)}</b>
          </div>
          <div>
            <span>Share of the pool</span>
            <b>{poolShare.toFixed(3)}%</b>
          </div>
          <div className="acct-actions">
            <Link href="/pool" className="btn">Deposit more</Link>
            <Link href="/pool" className="btn">Withdraw</Link>
          </div>
        </div>
      ) : (
        <div className="acct-empty">
          <b>No pool shares</b>
          <p>Deposit USDC or card fractions into the pool to earn the fees traders pay.</p>
          <Link href="/pool" className="btn">Go to Earn</Link>
        </div>
      )}
    </section>
  );
}
