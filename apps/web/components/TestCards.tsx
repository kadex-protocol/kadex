"use client";

import { useEffect, useState } from "react";
import { CLUSTER } from "@/lib/cluster";
import { loadVaultCard, type VaultCard } from "@/lib/collectorCrypt";
import { clusterName, loadTestCardRecord } from "@/lib/testCards";
import { CardRail } from "@/components/CardRail";

export function TestCards() {
  const [cards, setCards] = useState<VaultCard[]>([]);
  const [recorded, setRecorded] = useState<boolean | null>(null);
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    setError(false);
    loadTestCardRecord()
      .then((record) => {
        if (live) setRecorded(record.recorded);
        return Promise.all(record.cards.map((c) => loadVaultCard(c.mainnet).catch(() => null)));
      })
      .then((found) => live && setCards(found.filter((c): c is VaultCard => c !== null)))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [version]);

  if (!CLUSTER) return null;
  if (error) return <p className="hint bad" role="alert">Could not read test cards. <button className="btn" type="button" onClick={() => setVersion((v) => v + 1)}>Try again</button></p>;
  if (recorded === false) return <p className="sub">No test cards are recorded for {clusterName()}.</p>;
  if (cards.length === 0) return null;
  return (
    <CardRail
      cards={cards}
      title={`Test cards on ${clusterName()}`}
      note="Copies of real Collector Crypt cards made for this cluster. Vault and redeem are real transactions here."
    />
  );
}
