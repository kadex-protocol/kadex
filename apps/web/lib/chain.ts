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

const SHARE_MS = 3_000;
const reads = new Map<string, { at: number; value: Promise<unknown> }>();

// Every screen asks for the same accounts on the same tick; a public RPC answers 429 well before that adds up.
function shared<T>(key: string, load: () => Promise<T>): Promise<T> {
  const held = reads.get(key);
  if (held && Date.now() - held.at < SHARE_MS) return held.value as Promise<T>;
  const value = load();
  reads.set(key, { at: Date.now(), value });
  value.catch(() => {
    if (reads.get(key)?.value === value) reads.delete(key);
  });
  return value;
}

export const forgetChainReads = () => reads.clear();

let layout: { oracle: PublicKey; market: PublicKey; refreshAccounts: PublicKey[] } | null = null;

async function fetchChain({ connection, usdcMint, rpcUrl }: Cluster): Promise<ChainState> {
  const poolAddress = findPool(usdcMint);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (layout) {
    const [poolInfo, oracleInfo, marketInfo] = await connection.getMultipleAccountsInfo([poolAddress, layout.oracle, layout.market]);
    const pool = poolInfo ? decodePool(poolInfo.data) : null;
    if (pool && oracleInfo && marketInfo && pool.oracle.equals(layout.oracle) && pool.perpMarket.equals(layout.market)) {
      return { poolAddress, pool, oracle: decodeOracle(oracleInfo.data), market: decodeMarket(marketInfo.data), refreshAccounts: layout.refreshAccounts, now };
    }
    layout = null;
  }

  const poolInfo = await connection.getAccountInfo(poolAddress);
  if (!poolInfo) throw new Error(`No pool for USDC mint ${usdcMint.toBase58()} on ${rpcUrl}.`);
  const pool = decodePool(poolInfo.data);

  const [oracleInfo, marketInfo] = await connection.getMultipleAccountsInfo([pool.oracle, pool.perpMarket]);
  if (!oracleInfo) throw new Error("The pool's oracle account does not exist.");
  const oracle = decodeOracle(oracleInfo.data);
  const refreshAccounts = await refreshAccountsFor(connection, oracle);
  if (marketInfo) layout = { oracle: pool.oracle, market: pool.perpMarket, refreshAccounts };
  return { poolAddress, pool, oracle, market: marketInfo ? decodeMarket(marketInfo.data) : null, refreshAccounts, now };
}

export const readChain = (cluster: Cluster): Promise<ChainState> => shared("chain", () => fetchChain(cluster));

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

export function readTokenBalances(cluster: Cluster, owner: PublicKey) {
  return shared(`balances:${owner.toBase58()}`, async () => {
    const { pool } = await readChain(cluster);
    const accounts = tokenAccountsOf(owner, pool);
    const infos = await cluster.connection.getMultipleAccountsInfo([accounts.usdc, accounts.fractions, accounts.clp]);
    const [usdc, fractions, clp] = infos.map((info) => (info ? decodeTokenAmount(info.data) : 0n));
    return { usdc: usdc ?? 0n, fractions: fractions ?? 0n, clp: clp ?? 0n };
  });
}

export interface OwnedPosition extends PositionAccount {
  address: PublicKey;
}

export function readPositions({ connection }: Cluster, owner: PublicKey): Promise<OwnedPosition[]> {
  return shared(`positions:${owner.toBase58()}`, async () => {
    const accounts = await connection.getProgramAccounts(PROGRAM_IDS.perp, {
      filters: [
        { dataSize: POSITION_SIZE },
        { memcmp: { offset: POSITION_OWNER_OFFSET, bytes: owner.toBase58() } },
      ],
    });
    return accounts
      .map(({ pubkey, account }) => ({ address: pubkey, ...decodePosition(account.data) }))
      .sort((a, b) => Number(b.openedTs - a.openedTs));
  });
}
