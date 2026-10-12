"use client";

import { useEffect, useMemo, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import { parseAmount } from "@/lib/amount";
import { USD_LABEL } from "@/lib/cluster";
import { loadVaultCards, type VaultCard } from "@/lib/collectorCrypt";
import { suggestHedge } from "@/lib/hedge";
import { CONSTITUENTS, fmtPct, fmtPrice, fmtUsd, IS_SAMPLE, type MarketSnapshot } from "@/lib/market";
import { readLedger, walletOf } from "@/lib/sim";

const basketAssets = new Set(CONSTITUENTS.map((card) => card.asset));


export function HedgeSuggestion({
  snapshot,
  owner,
  onFill,
}: {
  snapshot: MarketSnapshot;
  owner: PublicKey | null;
  onFill(notional: bigint): void;
}) {
  const ownerAddress = owner?.toBase58() ?? null;
  const [cards, setCards] = useState<Pick<VaultCard, "nftAddress" | "insuredValueUsdc">[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [maxNotional, setMaxNotional] = useState("");
  const [maxMonthlyCost, setMaxMonthlyCost] = useState("");

  useEffect(() => {
    let live = true;
    setCards(null);
    setFailure(null);
    if (!ownerAddress) return;

    const load = async () => {
      const all: VaultCard[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;

      do {
        const page = await loadVaultCards(cursor, {
          search: "",
          owner: ownerAddress,
          group: null,
        });
        all.push(...page.cards);
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error("Inventory pagination repeated.");
        if (cursor) seen.add(cursor);
      } while (cursor);

      const simulated = IS_SAMPLE
        ? walletOf(readLedger(), ownerAddress).cards.map((card) => ({ nftAddress: card.nftAddress, insuredValueUsdc: card.minted }))
        : [];
      if (live) setCards([...all, ...simulated]);
    };

    void load().catch((error: unknown) => {
      if (live) setFailure(error instanceof Error ? error.message : "Could not load inventory.");
    });

    return () => {
      live = false;
    };
  }, [ownerAddress]);

  const { inBasketValue, outsideBasketValue } = useMemo(
    () =>
      (cards ?? []).reduce(
        (values, card) => {
          if (basketAssets.has(card.nftAddress)) values.inBasketValue += card.insuredValueUsdc;
          else values.outsideBasketValue += card.insuredValueUsdc;
          return values;
        },
        { inBasketValue: 0n, outsideBasketValue: 0n },
      ),
    [cards],
  );

  const notionalLimit = parseAmount(maxNotional);
  const costLimit = parseAmount(maxMonthlyCost);
  const validLimits =
    notionalLimit !== null && notionalLimit > 0n &&
    costLimit !== null && costLimit >= 0n;
  const suggestion =
    cards && cards.length > 0 && validLimits
      ? suggestHedge(inBasketValue, outsideBasketValue, snapshot, {
          maxNotional: notionalLimit,
          maxMonthlyCost: costLimit,
        })
      : null;

  if (!ownerAddress) return <p className="hint">Connect a wallet to read your card inventory.</p>;
  if (failure) return <p className="hint bad" role="alert">{failure}</p>;
  if (cards === null) return <p className="hint">Reading your card inventory…</p>;
  if (cards.length === 0) return <p className="hint">{IS_SAMPLE ? "No cards in this wallet yet. Vault one to size a hedge against it." : "No Collector Crypt cards found for this wallet."}</p>;

  return (
    <section className="panel" aria-label="Inventory hedge suggestion">
      <p className="kicker">Inventory hedge suggestion</p>
      <div className="rows" style={{ marginBottom: 16 }}>
        <div><span>In the basket</span><b>${fmtUsd(inBasketValue, 2)}</b></div>
        <div><span>Outside the basket</span><b>${fmtUsd(outsideBasketValue, 2)}</b></div>
      </div>
      <div className="field">
        <span>Maximum notional · {USD_LABEL}</span>
        <input inputMode="decimal" value={maxNotional} onChange={(event) => setMaxNotional(event.target.value)} />
      </div>
      <div className="field">
        <span>Maximum monthly borrow cost · {USD_LABEL}</span>
        <input inputMode="decimal" value={maxMonthlyCost} onChange={(event) => setMaxMonthlyCost(event.target.value)} />
      </div>
      <div className="rows">
        <div><span>Pool leverage</span><b>{fmtUsd(snapshot.pool.params.baseLeverage, 2)}x</b></div>
      </div>
      {!validLimits ? (
        <p className="hint">Enter both limits to see a suggestion.</p>
      ) : suggestion ? (
        <>
          <div className="rows" style={{ marginTop: 16 }}>
            <div><span>Suggested short</span><b>{fmtUsd(suggestion.notional, 2)} {USD_LABEL}</b></div>
            <div><span>Hedge ratio</span><b>{fmtPct(suggestion.hedgeRatio, 1)}</b></div>
            <div><span>Margin</span><b>{fmtUsd(suggestion.margin, 2)} {USD_LABEL}</b></div>
            <div><span>Monthly borrow cost</span><b>{fmtUsd(suggestion.monthlyBorrowCost, 2)} {USD_LABEL}</b></div>
            <div><span>Liquidation price</span><b>{suggestion.notional > 0n ? fmtPrice(suggestion.liquidationPrice) : "—"}</b></div>
            <div><span>Binding limit</span><b>{suggestion.bound}</b></div>
          </div>
          {suggestion.problem && <p className="hint bad">{suggestion.problem}</p>}
          <button
            className="btn"
            type="button"
            disabled={suggestion.notional === 0n || suggestion.problem !== null}
            onClick={() => onFill(suggestion.notional)}
            style={{ marginTop: 16 }}
          >
            Fill ticket size
          </button>
        </>
      ) : null}
      <p className="hint">
        This index hedge is a proxy for your inventory. Cards outside the basket are only partly covered; their prices can move differently from the index (basis risk).
      </p>
      {IS_SAMPLE && <p className="hint">The hedge quote uses sample market data.</p>}
    </section>
  );
}
