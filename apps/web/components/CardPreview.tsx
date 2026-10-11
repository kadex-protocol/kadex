"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { CLUSTER } from "@/lib/cluster";
import { fmtUsd, IS_SAMPLE } from "@/lib/market";
import type { VaultCard } from "@/lib/collectorCrypt";
import { askOverAppraisal, gradeLine, titleParts } from "@/lib/cardText";
import { loadTestCards, twinOf } from "@/lib/testCards";
import { loadCoreCard } from "@/lib/vaultTx";

export function CardPreview({ card, onClose }: { card: VaultCard; onClose(): void }) {
  const [back, setBack] = useState(false);
  const [fractions, setFractions] = useState<bigint | null>(null);
  const [chainStatus, setChainStatus] = useState<string | null>(null);
  const [failure, setFailure] = useState(false);
  const [version, setVersion] = useState(0);
  const closeButton = useRef<HTMLButtonElement>(null);
  const t = titleParts(card);
  const premium = askOverAppraisal(card);
  const shown = back && card.backImage ? card.backImage : card.frontImage;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    const cluster = CLUSTER;
    if (!cluster) return;
    let live = true;
    setFractions(null);
    setChainStatus(null);
    setFailure(false);
    loadTestCards()
      .then((list) => loadCoreCard(cluster, new PublicKey(twinOf(list, card.nftAddress) ?? card.nftAddress), null))
      .then((s) => {
        if (!live) return;
        setChainStatus(s.vault?.locked ? "Vaulted" : s.assetOwner && s.registry && s.card?.core && s.card.enabled && s.vault ? "Available to owner" : "Not vaultable here");
        setFractions(s.vault?.locked
          ? s.vault.fractionsMinted
          : s.assetOwner && s.registry && s.card?.core && s.card.enabled && s.vault
            ? s.card.fractionsPerCard
            : null);
      })
      .catch(() => {
        if (!live) return;
        setFractions(null);
        setFailure(true);
      });
    return () => {
      live = false;
    };
  }, [card.nftAddress, version]);

  return (
    <div className="welcome-overlay" onClick={onClose}>
      <div className="welcome cprev" role="dialog" aria-modal="true" aria-labelledby="cprev-h" onClick={(e) => e.stopPropagation()}>
        <button ref={closeButton} type="button" className="wconnect-x" aria-label="Close" onClick={onClose}>×</button>

        <div className="cprev-shot">
          {shown ? <img src={shown} alt="" /> : <span className="vblank" />}
          {card.frontImage && card.backImage && (
            <div className="tk-switch" role="group" aria-label="Card face">
              <button type="button" aria-pressed={!back} onClick={() => setBack(false)}>Front</button>
              <button type="button" aria-pressed={back} onClick={() => setBack(true)}>Back</button>
            </div>
          )}
        </div>

        <div className="cprev-body">
          <span className="cprev-kick">{card.category || t.kicker}</span>
          <h2 id="cprev-h">{t.title}</h2>
          <div className="ctags">
            <span className={`pill ${IS_SAMPLE ? (card.vaultable ? "long" : "short") : chainStatus === "Available to owner" ? "long" : "short"}`}>
              {IS_SAMPLE ? (card.vaultable ? "Vaultable" : "Not vaultable") : failure ? "Status unavailable" : chainStatus ?? "Checking cluster"}
            </span>
            {card.askUsdc !== null && <span className="pill">Listed</span>}
          </div>

          {failure && (
            <p className="hint bad" role="alert">
              Could not read the card on this cluster. <button className="btn" type="button" onClick={() => setVersion((v) => v + 1)}>Try again</button>
            </p>
          )}

          <div className="cprev-price">
            <span>Appraised value</span>
            <b>${fmtUsd(card.insuredValueUsdc, 2)}</b>
          </div>

          <dl className="cprev-rows">
            <div><dt>Grade</dt><dd>{gradeLine(card)}</dd></div>
            <div><dt>Year</dt><dd>{card.year ?? "-"}</dd></div>
            <div>
              <dt>Asking price</dt>
              <dd>{card.askUsdc !== null ? `$${fmtUsd(card.askUsdc, 2)}${premium ? ` · ${premium}` : ""}` : "Not listed"}</dd>
            </div>
            <div><dt>You receive</dt><dd>{IS_SAMPLE ? (card.vaultable ? `${fmtUsd(card.insuredValueUsdc, 2)} fractions` : "-") : fractions !== null ? `${fmtUsd(fractions, 2)} fractions` : "—"}</dd></div>
          </dl>

          <div className="cprev-actions">
            <Link href={`/vault/${card.nftAddress}`} className="btn accent">View full card</Link>
            <button type="button" className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}
