"use client";

import { useEffect, useState } from "react";
import { CLUSTER } from "@/lib/cluster";
import { loadVaultCard, type VaultCard } from "@/lib/collectorCrypt";
import { clusterName, loadTestCards } from "@/lib/testCards";
import { CardRail } from "@/components/CardRail";

export function TestCards() {
  const [cards, setCards] = useState<VaultCard[]>([]);

  useEffect(() => {
    let live = true;
    loadTestCards()
      .then((list) => Promise.all(list.map((c) => loadVaultCard(c.mainnet).catch(() => null))))
      .then((found) => live && setCards(found.filter((c): c is VaultCard => c !== null)));
    return () => {
      live = false;
    };
  }, []);

  if (!CLUSTER || cards.length === 0) return null;
  return (
    <CardRail
      cards={cards}
      title={`Test cards on ${clusterName()}`}
      note="Copies of real Collector Crypt cards made for this cluster. Vault and redeem are real transactions here."
    />
  );
}
