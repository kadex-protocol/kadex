import type { PublicKey } from "@solana/web3.js";
import { CLUSTER } from "./cluster";
import { LEDGER_EVENT } from "./sim";

export interface FaucetReply {
  funded: boolean;
  signature?: string;
  error?: string;
}

export async function requestTestFunds(wallet: PublicKey): Promise<FaucetReply> {
  if (!CLUSTER || CLUSTER.network === "mainnet") return { funded: false };
  try {
    const res = await fetch("/api/faucet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: wallet.toBase58() }),
    });
    const reply = (await res.json()) as FaucetReply;
    if (reply.funded) window.dispatchEvent(new Event(LEDGER_EVENT));
    return reply;
  } catch {
    return { funded: false, error: "The faucet is unreachable." };
  }
}
