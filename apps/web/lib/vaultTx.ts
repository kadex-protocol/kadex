import type { PublicKey } from "@solana/web3.js";
import { createAtaIdempotentIx, findFractionMint, fractionalizeCoreIx, readCoreCard, redeemCoreIx, type CoreCardState } from "@kadex/sdk";
import type { Cluster } from "./cluster";
import { sendInstructions, type Sign } from "./tx";

export const loadCoreCard = (cluster: Cluster, asset: PublicKey, wallet: PublicKey | null): Promise<CoreCardState> =>
  readCoreCard(cluster.connection, asset, wallet);

/**
 * Lock the card and mint its fractions, or burn them all and take it back.
 * State is re-read right before building, so the transaction matches the
 * chain the program will see, not the one the page loaded.
 */
export async function sendVaultAction(cluster: Cluster, owner: PublicKey, sign: Sign, asset: PublicKey, kind: "vault" | "redeem"): Promise<string> {
  const state = await readCoreCard(cluster.connection, asset, owner);
  if (!state.registry) throw new Error("The card vault is not initialized on this cluster.");
  const accounts = { asset, collection: state.registry.collection };
  const instructions =
    kind === "vault"
      ? [createAtaIdempotentIx(owner, owner, findFractionMint(asset)), fractionalizeCoreIx(accounts, owner)]
      : [redeemCoreIx(accounts, owner)];
  return sendInstructions(cluster, owner, sign, instructions);
}
