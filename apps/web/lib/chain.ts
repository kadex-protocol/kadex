import type { PublicKey } from "@solana/web3.js";
import {
  POSITION_OWNER_OFFSET, POSITION_SIZE, PROGRAM_IDS,
  decodeMarket, decodeOracle, decodePool, decodePosition, decodeTokenAmount, findAta, findPool, refreshAccountsFor,
  type MarketAccount, type OracleAccount, type PoolAccount, type PositionAccount,
} from "@kadex/sdk";
import type { Cluster } from "./cluster";

export interface ChainState {
  poolAddress: PublicKey;
  pool: PoolAccount;
  oracle: OracleAccount;
  market: MarketAccount | null;
  /** Accounts `refresh_price` needs after the AMM pool (Raydium: its vaults). */
  refreshAccounts: PublicKey[];
  now: bigint;
}

export async function readChain({ connection, usdcMint, rpcUrl }: Cluster): Promise<ChainState> {
  const poolAddress = findPool(usdcMint);
  const poolInfo = await connection.getAccountInfo(poolAddress);
  if (!poolInfo) throw new Error(`No pool for USDC mint ${usdcMint.toBase58()} on ${rpcUrl}.`);
  const pool = decodePool(poolInfo.data);

  const [oracleInfo, marketInfo] = await connection.getMultipleAccountsInfo([pool.oracle, pool.perpMarket]);
  if (!oracleInfo) throw new Error("The pool's oracle account does not exist.");
  const oracle = decodeOracle(oracleInfo.data);
  return {
    poolAddress,
    pool,
    oracle,
    market: marketInfo ? decodeMarket(marketInfo.data) : null,
    refreshAccounts: await refreshAccountsFor(connection, oracle),
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

export interface OwnedPosition extends PositionAccount {
  address: PublicKey;
}

export async function readPositions({ connection }: Cluster, owner: PublicKey): Promise<OwnedPosition[]> {
  const accounts = await connection.getProgramAccounts(PROGRAM_IDS.perp, {
    filters: [
      { dataSize: POSITION_SIZE },
      { memcmp: { offset: POSITION_OWNER_OFFSET, bytes: owner.toBase58() } },
    ],
  });
  return accounts
    .map(({ pubkey, account }) => ({ address: pubkey, ...decodePosition(account.data) }))
    .sort((a, b) => Number(b.openedTs - a.openedTs));
}
