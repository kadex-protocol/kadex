"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { fmtUsd } from "@/lib/market";
import { SOLANA_ADDRESS, loadVaultCard, loadVaultCards, type VaultCard } from "@/lib/collectorCrypt";
import { askOverAppraisal, gradeLine, shortAddress, titleParts } from "@/lib/cardText";
import { CardStage } from "@/components/CardStage";
import { TiltSlab } from "@/components/TiltSlab";
import { VaultActions } from "@/components/VaultActions";

const message = (e: unknown) => (e instanceof Error ? e.message : "Could not reach Collector Crypt.");

function Strip({ title, cards }: { title: string; cards: VaultCard[] }) {
  const track = useRef<HTMLDivElement>(null);
  if (cards.length === 0) return null;
  const scroll = (direction: 1 | -1) => {
    const el = track.current;
    el?.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: "smooth" });
  };
  return (
    <section className="panel crail strip">
      <div className="rail-head">
        <h2 className="title sm">{title}</h2>
        <div className="rail-nav">
          <button type="button" aria-label="Previous cards" onClick={() => scroll(-1)}>‹</button>
          <button type="button" aria-label="Next cards" onClick={() => scroll(1)}>›</button>
        </div>
      </div>
      <div className="rail-track" ref={track}>
        {cards.map((c) => (
          <Link key={c.nftAddress} href={`/vault/${c.nftAddress}`} className="rcard">
            <TiltSlab src={c.frontImage} />
            <span className="cap">
              <span className="n">{titleParts(c).title}</span>
              <b className="v">${fmtUsd(c.insuredValueUsdc)}</b>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

export default function CardPage() {
  const { address } = useParams<{ address: string }>();
  const [card, setCard] = useState<VaultCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [back, setBack] = useState(false);
  const [similar, setSimilar] = useState<VaultCard[]>([]);
  const [sameOwner, setSameOwner] = useState<VaultCard[]>([]);

  useEffect(() => {
    let live = true;
    setCard(null);
    setError(null);
    setBack(false);
    setSimilar([]);
    setSameOwner([]);
    if (!SOLANA_ADDRESS.test(address)) {
      setError("That is not a Solana address.");
      return;
    }
    loadVaultCard(address)
      .then((c) => {
        if (!live) return;
        setCard(c);
        const others = (cards: VaultCard[]) => cards.filter((o) => o.nftAddress !== c.nftAddress).slice(0, 12);
        if (c.subject) {
          loadVaultCards(null, { search: c.subject, owner: null, group: null })
            .then((p) => live && setSimilar(others(p.cards)))
            .catch(() => {});
        }
        if (c.ownerWallet) {
          loadVaultCards(null, { search: "", owner: c.ownerWallet, group: null })
            .then((p) => live && setSameOwner(others(p.cards)))
            .catch(() => {});
        }
      })
      .catch((e) => live && setError(message(e)));
    return () => {
      live = false;
    };
  }, [address]);

  if (error) {
    return (
      <div className="page wide">
        <div className="empty" role="alert">
          <h3>Could not load this card</h3>
          <p>{error}</p>
          <Link href="/vault" className="btn">Back to the vault</Link>
        </div>
      </div>
    );
  }

  const t = card ? titleParts(card) : null;
  const value = card?.vaultable ? card.insuredValueUsdc : 0n;
  const faces = card ? [card.frontImage, card.backImage].filter((s): s is string => s !== null) : [];
  const premium = card ? askOverAppraisal(card) : null;

  return (
    <div className="page wide">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/vault">Vault</Link>
        <span>/</span>
        <span>{card?.category || "Card"}</span>
        <span>/</span>
        <span>{t?.title ?? "Loading"}</span>
      </nav>

      <div className="cdetail">
        <div className="ccol">
          <section className="panel cview">
            <div className="cview-shot stagebox">
              {card ? (
                <CardStage front={card.frontImage} back={card.backImage} showBack={back} onFace={setBack} />
              ) : (
                <span className="vblank" />
              )}
            </div>
            {faces.length > 1 && (
              <div className="cview-nav">
                <button className="btn" type="button" aria-label="Previous photo" onClick={() => setBack((b) => !b)}>←</button>
                <span className="v-faces">
                  {faces.map((src, i) => (
                    <span key={src} data-on={back === (i === 1)} onClick={() => setBack(i === 1)}>
                      <img src={src} alt="" loading="lazy" />
                    </span>
                  ))}
                </span>
                <button className="btn" type="button" aria-label="Next photo" onClick={() => setBack((b) => !b)}>→</button>
              </div>
            )}
          </section>
          <Strip title="Similar cards" cards={similar} />
          <Strip title="More from this owner" cards={sameOwner} />
        </div>

        <div className="panel cinfo">
          <h1 className="ctitle">{card ? card.name : "Loading card…"}</h1>

          <div className="ctags">
            {card && (
              <span className={`pill ${card.vaultable ? "long" : "short"}`}>
                {card.vaultable ? "Vaultable" : card.nftStandard === "core" ? "No appraisal" : `${card.nftStandard} · not vaultable`}
              </span>
            )}
            {card?.askUsdc != null && <span className="pill">Listed</span>}
          </div>

          <div>
            <p className="kicker" style={{ marginBottom: 6 }}>Appraised value · USDC</p>
            <p className="price">{card ? `$${fmtUsd(card.insuredValueUsdc, 2)}` : "—"}</p>
          </div>

          <div className="cta">
            <VaultActions address={address} vaultable={value > 0n} />
            <a
              className="btn"
              href={`https://collectorcrypt.com/assets/solana/${address}`}
              target="_blank"
              rel="noreferrer"
            >
              View on Collector Crypt ↗
            </a>
          </div>

          <div className="spec">
            <div><span>You receive</span><b>{value > 0n ? `${fmtUsd(value, 2)} fractions` : "—"}</b></div>
            <div><span>Asking price</span><b>{card?.askUsdc != null ? `$${fmtUsd(card.askUsdc, 2)}${premium ? ` · ${premium}` : ""}` : "Not listed"}</b></div>
          </div>

          <div className="cnote">
            <b>{card?.vault ? `Held in ${card.vault}` : "Held in custody"}</b>
            <span>Tokenized by Collector Crypt. The card stays locked until every fraction is burned.</span>
          </div>

          <div className="spec">
            <div><span>Grade</span><b>{card ? gradeLine(card) : "—"}</b></div>
            <div><span>Certification number</span><b>{card?.certNumber ?? "—"}</b></div>
          </div>

          <div className="spec">
            <div><span>Year</span><b>{card?.year ?? "—"}</b></div>
            <div><span>Category</span><b>{card?.category || "—"}</b></div>
            <div><span>Set</span><b>{card?.set ?? "—"}</b></div>
            <div><span>Subject</span><b>{card?.subject ?? "—"}</b></div>
            <div><span>Card number</span><b>{card?.serial ? `#${card.serial}` : "—"}</b></div>
            <div><span>Standard</span><b>{card?.nftStandard ?? "—"}</b></div>
            <div><span>Owner</span><b>{card?.ownerWallet ? shortAddress(card.ownerWallet) : "—"}</b></div>
            <div><span>Asset</span><b>{shortAddress(address)}</b></div>
          </div>

          {card?.population && (
            <>
              <h2 className="title sm">Population at {card.gradingCompany}</h2>
              <div className="spec">
                <div><span>At this grade</span><b>{card.population.grade.toLocaleString("en-US")}</b></div>
                <div><span>Graded higher</span><b>{card.population.higher.toLocaleString("en-US")}</b></div>
                <div><span>Total graded</span><b>{card.population.total.toLocaleString("en-US")}</b></div>
              </div>
            </>
          )}

          <p className="fine">
            Vaulting happens on the cluster the app points at: ownership and lock state are read from it, not from
            Collector Crypt.
          </p>
        </div>
      </div>
    </div>
  );
}
