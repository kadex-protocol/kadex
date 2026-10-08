import type { PublicKey } from "@solana/web3.js";
import { createAtaIdempotentIx, depositFractionsIx, depositUsdcIx, withdrawIx } from "@slab/sdk";
import { readChain, tokenAccountsOf } from "./chain";
import type { Cluster } from "./cluster";
import { refreshIfAging, sendInstructions, type Sign } from "./tx";

export interface PoolAction {
  kind: "depositUsdc" | "depositFractions" | "withdraw";
  amount: bigint;
}

export async function sendPoolAction(cluster: Cluster, owner: PublicKey, sign: Sign, action: PoolAction): Promise<string> {
  const chain = await readChain(cluster);
  const { poolAddress, pool } = chain;
  const accounts = tokenAccountsOf(owner, pool);
  const target = { address: poolAddress, pool };
  const instructions = refreshIfAging(chain, owner);

  if (action.kind === "withdraw") {
    instructions.push(
      createAtaIdempotentIx(owner, owner, pool.usdcMint),
      createAtaIdempotentIx(owner, owner, pool.fractionMint),
      withdrawIx(target, owner, accounts, action.amount),
    );
  } else {
    instructions.push(
      createAtaIdempotentIx(owner, owner, pool.clpMint),
      action.kind === "depositUsdc"
        ? depositUsdcIx(target, owner, accounts, action.amount)
        : depositFractionsIx(target, owner, accounts, action.amount),
    );
  }
  return sendInstructions(cluster, owner, sign, instructions);
}
