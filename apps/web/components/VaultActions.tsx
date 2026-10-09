"use client";

import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { vaultAction, type VaultAction } from "@kadex/sdk";
import { CLUSTER } from "@/lib/cluster";
import { fmtUsd } from "@/lib/market";
import { explainTxError, shortSignature } from "@/lib/tx";
import { loadCoreCard, sendVaultAction } from "@/lib/vaultTx";
import { useWallet } from "@/lib/wallet";

/**
 * The card page's vault button, decided from the cluster the app points at:
 * who owns the asset there, whether it is whitelisted, locked, and how many
 * fractions the wallet holds. Mirrors the program's checks via `vaultAction`,
 * so it never offers a transaction the program would refuse.
 */
export function VaultActions({ address, vaultable }: { address: string; vaultable: boolean }) {
  const { status, publicKey, connect, signTransaction } = useWallet();
  const [action, setAction] = useState<VaultAction | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const reload = useCallback(() => {
    if (!CLUSTER) return;
    setLoadError(null);
    loadCoreCard(CLUSTER, new PublicKey(address), publicKey)
      .then((s) => setAction(vaultAction(s, publicKey)))
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Could not read the vault."));
  }, [address, publicKey]);

  useEffect(reload, [reload]);

  if (status !== "connected" || !publicKey) {
    return (
      <button className="btn block" onClick={() => void connect()} disabled={status === "connecting"}>
        {status === "connecting" ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }
  if (!CLUSTER) {
    return (
      <>
        <button className="btn block" disabled>{vaultable ? "Vault this card" : "Not vaultable"}</button>
        <p className="fine">Preview: no cluster is configured, so nothing can be vaulted here.</p>
      </>
    );
  }
  if (loadError) return <p className="hint bad" role="alert">{loadError}</p>;
  if (!action) return <button className="btn block" disabled>Reading the vault…</button>;

  const run = async (kind: "vault" | "redeem") => {
    setSending(true);
    setReceipt(null);
    try {
      const signature = await sendVaultAction(CLUSTER!, publicKey, signTransaction, new PublicKey(address), kind);
      setReceipt({ ok: true, text: `Confirmed · ${shortSignature(signature)}` });
      setConfirming(false);
      reload();
    } catch (e) {
      setReceipt({ ok: false, text: explainTxError(e) });
    } finally {
      setSending(false);
    }
  };

  const fractions = (n: bigint) => `${fmtUsd(n, 2)} fractions`;
  let button: React.ReactNode;
  let note: string | null = null;
  switch (action.kind) {
    case "vault":
      note = `Locks the card in the vault and mints ${fractions(action.fractions)} to you. Getting it back burns all ${fractions(action.fractions)}: sell any and you must buy them back first.`;
      button = confirming ? (
        <button className="btn block" onClick={() => void run("vault")} disabled={sending}>
          {sending ? "Vaulting…" : `Confirm: vault for ${fractions(action.fractions)}`}
        </button>
      ) : (
        <button className="btn block" onClick={() => setConfirming(true)}>Vault this card</button>
      );
      break;
    case "redeem":
      note = `Burns all ${fractions(action.fractions)} from your wallet and returns the card to you.`;
      button = confirming ? (
        <button className="btn block" onClick={() => void run("redeem")} disabled={sending}>
          {sending ? "Redeeming…" : `Confirm: burn ${fractions(action.fractions)}`}
        </button>
      ) : (
        <button className="btn block" onClick={() => setConfirming(true)}>Redeem the card</button>
      );
      break;
    case "redeemShort":
      note = `Locked in the vault. Redeeming burns all ${fractions(action.fractions)}; you hold ${fractions(action.held)}.`;
      button = <button className="btn block" disabled>Redeem needs every fraction</button>;
      break;
    default:
      note = action.reason;
      button = <button className="btn block" disabled>{action.kind === "notOwner" ? "Only its owner can vault" : "Not vaultable here"}</button>;
  }

  return (
    <>
      {button}
      {note && <p className="fine">{note}</p>}
      {receipt && <p className={`hint ${receipt.ok ? "good" : "bad"}`} role="status" style={{ margin: 0 }}>{receipt.text}</p>}
    </>
  );
}
