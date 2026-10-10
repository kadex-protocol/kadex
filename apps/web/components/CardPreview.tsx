"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fmtUsd } from "@/lib/market";
import type { VaultCard } from "@/lib/collectorCrypt";
import { askOverAppraisal, gradeLine, titleParts } from "@/lib/cardText";

export function CardPreview({ card, onClose }: { card: VaultCard; onClose(): void }) {
  const [back, setBack] = useState(false);
  const t = titleParts(card);
  const premium = askOverAppraisal(card);
  const shown = back && card.backImage ? card.backImage : card.frontImage;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="welcome-overlay" onClick={onClose}>
      <div className="welcome cprev" role="dialog" aria-modal="true" aria-labelledby="cprev-h" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="wconnect-x" aria-label="Close" onClick={onClose}>×</button>

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
            <span className={`pill ${card.vaultable ? "long" : "short"}`}>{card.vaultable ? "Vaultable" : "Not vaultable"}</span>
            {card.askUsdc !== null && <span className="pill">Listed</span>}
          </div>

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
            <div><dt>You receive</dt><dd>{card.vaultable ? `${fmtUsd(card.insuredValueUsdc, 2)} fractions` : "-"}</dd></div>
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
