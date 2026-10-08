import type { PublicKey } from "@solana/web3.js";
import {
  decodeMarket, decodeOracle, decodePool, decodeTokenAmount, findAta, findPool,
  type MarketAccount, type OracleAccount, type PoolAccount,
} from "@slab/sdk";
import type { Cluster } from "./cluster";

export interface ChainState {
  poolAddress: PublicKey;
  pool: PoolAccount;
  oracle: OracleAccount;
  market: MarketAccount | null;
  now: bigint;
}

export async function readChain({ connection, usdcMint, rpcUrl }: Cluster): Promise<ChainState> {
  const poolAddress = findPool(usdcMint);
  const poolInfo = await connection.getAccountInfo(poolAddress);
  if (!poolInfo) throw new Error(`No pool for USDC mint ${usdcMint.toBase58()} on ${rpcUrl}.`);
  const pool = decodePool(poolInfo.data);

  const [oracleInfo, marketInfo] = await connection.getMultipleAccountsInfo([pool.oracle, pool.perpMarket]);
  if (!oracleInfo) throw new Error("The pool's oracle account does not exist.");
  return {
    poolAddress,
    pool,
    oracle: decodeOracle(oracleInfo.data),
    market: marketInfo ? decodeMarket(marketInfo.data) : null,
    now: BigInt(Math.floor(Date.now() / 1000)),
  };
}

export interface TokenAccounts {
  usdc: PublicKey;
  fractions: PublicKey;
  clp: PublicKey;
}

export const tokenAccountsOf = (owner: PublicKey, pool: PoolAccount): TokenAccounts => ({
  usdc: findAta(owner, pool.usdcMint),
  fractions: findAta(owner, pool.fractionMint),
  clp: findAta(owner, pool.clpMint),
});

export async function readTokenBalances(cluster: Cluster, owner: PublicKey) {
  const { pool } = await readChain(cluster);
  const accounts = tokenAccountsOf(owner, pool);
  const infos = await cluster.connection.getMultipleAccountsInfo([accounts.usdc, accounts.fractions, accounts.clp]);
  const [usdc, fractions, clp] = infos.map((info) => (info ? decodeTokenAmount(info.data) : 0n));
  return { usdc: usdc ?? 0n, fractions: fractions ?? 0n, clp: clp ?? 0n };
}
