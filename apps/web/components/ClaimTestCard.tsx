"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CLUSTER } from "@/lib/cluster";
import { claimTestCard, holdsTestCard, invalidateTestCards, loadTestCardRecord, type TestCardClaim } from "@/lib/testCards";
import { useWallet } from "@/lib/wallet";

type Phase = "checking" | "ready" | "claiming" | "none";

export function ClaimTestCard({ onClaimed }: { onClaimed?(): void }) {
  const { status, publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const [phase, setPhase] = useState<Phase>("checking");
  const [reply, setReply] = useState<TestCardClaim | null>(null);

  useEffect(() => {
    if (CLUSTER?.network !== "devnet" || status !== "connected" || !wallet) return;
    let live = true;
    setPhase("checking");
    loadTestCardRecord(wallet)
      .then((record) => live && setPhase(record.recorded && !holdsTestCard(record) ? "ready" : "none"))
      .catch(() => live && setPhase("none"));
    return () => {
      live = false;
    };
  }, [status, wallet]);

  if (CLUSTER?.network !== "devnet" || status !== "connected" || !wallet) return null;

  const claim = async () => {
    setPhase("claiming");
    setReply(null);
    const result = await claimTestCard(wallet);
    setReply(result);
    if (!result.claimed) {
      invalidateTestCards();
      setPhase("ready");
      return;
    }
    setPhase("none");
    onClaimed?.();
  };

  if (reply?.claimed) {
    return (
      <p className="hint" role="status">
        {reply.name} is in your wallet.{" "}
        <Link className="link" href={`/vault/${reply.mainnet}`}>Vault it</Link>
        {" · "}
        <a className="link" href={`https://explorer.solana.com/tx/${reply.signature}?cluster=devnet`} target="_blank" rel="noreferrer">View transaction</a>
      </p>
    );
  }
  if (phase === "checking" || (phase === "none" && !reply)) return null;
  return (
    <div>
      <button className="btn" type="button" disabled={phase === "claiming"} onClick={claim}>
        {phase === "claiming" ? "Sending your test card…" : "Get a test card"}
      </button>
      {reply?.error && <p className="hint bad" role="alert">{reply.error}</p>}
    </div>
  );
}
