/**
 * @kadex/oracle — off-chain AMM reserve adapters, the twins of
 * `programs/oracle/src/adapter.rs`.
 *
 * `mock` reads the mock AMM, `raydium` reads a Raydium CPMM pool (see
 * `raydium.ts`). `meteora` and `orca` throw: an adapter that does not exist
 * must fail, never return a plausible number.
 */

import type { Connection, PublicKey } from "@solana/web3.js";
import { decodePool, readRaydium, refreshAccounts } from "./raydium.js";

export * from "./raydium.js";

export interface Reserves {
  /** Reserve in native USDC. This is the `R` in the depth ceiling. */
  usdc: bigint;
  /** Card-fraction reserve. */
  fraction: bigint;
}

export interface AmmAdapter {
  readonly kind: "mock" | "meteora" | "orca" | "raydium";
  /** `basket` is the oracle's basket: for a real pool, the index token mint. */
  readReserves(conn: Connection, pool: PublicKey, basket: PublicKey): Promise<Reserves>;
  /** Remaining accounts `refresh_price` needs after the pool, in order. */
  refreshAccounts(conn: Connection, pool: PublicKey): Promise<PublicKey[]>;
}

/** Mock pool layout: 8 discriminator bytes + two little-endian u64. */
export const mockAdapter: AmmAdapter = {
  kind: "mock",
  async readReserves(conn, pool) {
    const info = await conn.getAccountInfo(pool);
    if (!info) throw new Error(`pool ${pool.toBase58()} does not exist`);
    if (info.data.length < 24) throw new Error("unexpected mock pool layout");
    return {
      usdc: info.data.readBigUInt64LE(8),
      fraction: info.data.readBigUInt64LE(16),
    };
  },
  async refreshAccounts() {
    return [];
  },
};

export const raydiumAdapter: AmmAdapter = {
  kind: "raydium",
  async readReserves(conn, pool, basket) {
    return (await readRaydium(conn, pool, basket)).reserves;
  },
  async refreshAccounts(conn, pool) {
    const info = await conn.getAccountInfo(pool, "confirmed");
    if (!info) throw new Error(`pool ${pool.toBase58()} does not exist`);
    return refreshAccounts(decodePool(pool, info.owner, info.data));
  },
};

const unsupported = (kind: AmmAdapter["kind"]): AmmAdapter => {
  // Fails loudly on purpose. Returning zero, or a plausible number, would
  // be worse: the market would open on an invented price.
  const refuse = async (): Promise<never> => {
    throw new Error(`adapter ${kind} not implemented — only mock and raydium (CPMM) read reserves`);
  };
  return { kind, readReserves: refuse, refreshAccounts: refuse };
};

export const adapters: Record<AmmAdapter["kind"], AmmAdapter> = {
  mock: mockAdapter,
  meteora: unsupported("meteora"),
  orca: unsupported("orca"),
  raydium: raydiumAdapter,
};

/** `price = usdc_reserve / fraction_reserve`, in WAD. */
export function spotPrice(r: Reserves): bigint {
  if (r.fraction === 0n) throw new Error("pool has no fraction reserve");
  return (r.usdc * 1_000_000n) / r.fraction;
}
