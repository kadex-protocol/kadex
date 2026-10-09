import type { PublicKey } from "@solana/web3.js";
import type { Side } from "@kadex/types";
import { closePositionIx, createAtaIdempotentIx, findAta, openPositionIx, type MarketAccounts } from "@kadex/sdk";
import { readChain, type ChainState } from "./chain";
import type { Cluster } from "./cluster";
import { refreshIfAging, sendInstructions, type Sign } from "./tx";

const marketAccounts = ({ poolAddress, pool }: ChainState): MarketAccounts => ({
  market: pool.perpMarket,
  pool: poolAddress,
  oracle: pool.oracle,
  usdcVault: pool.usdcVault,
});

export interface OpenOrder {
  side: Side;
  notional: bigint;
  margin: bigint;
}

export async function sendOpenPosition(cluster: Cluster, owner: PublicKey, sign: Sign, order: OpenOrder): Promise<string> {
  const chain = await readChain(cluster);
  const nonce = BigInt(Date.now());
  return sendInstructions(cluster, owner, sign, [
    ...refreshIfAging(chain, owner),
    openPositionIx(marketAccounts(chain), owner, findAta(owner, chain.pool.usdcMint), { nonce, ...order }),
  ]);
}

export async function sendClosePosition(cluster: Cluster, owner: PublicKey, sign: Sign, position: PublicKey): Promise<string> {
  const chain = await readChain(cluster);
  return sendInstructions(cluster, owner, sign, [
    ...refreshIfAging(chain, owner),
    createAtaIdempotentIx(owner, owner, chain.pool.usdcMint),
    closePositionIx(marketAccounts(chain), owner, position, findAta(owner, chain.pool.usdcMint)),
  ]);
}
