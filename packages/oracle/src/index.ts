/**
 * @slab/oracle — off-chain AMM reserve adapters.
 *
 * # Blocker #1
 *
 * The on-chain layout of the real fraction/USDC pool is NOT yet confirmed.
 * The `mock` adapter exists so the team can work from day 1 without anyone
 * writing code that fakes a finished integration. The real adapters throw
 * until someone confirms the layout.
 *
 * When that happens, only this file and `programs/oracle/src/adapter.rs`
 * change.
 */

import type { Connection, PublicKey } from "@solana/web3.js";

export interface Reserves {
  /** Reserve in native USDC. This is the `R` in the depth ceiling. */
  usdc: bigint;
  /** Card-fraction reserve. */
  fraction: bigint;
}

export interface AmmAdapter {
  readonly kind: "mock" | "meteora" | "orca" | "raydium";
  readReserves(conn: Connection, pool: PublicKey): Promise<Reserves>;
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
};

const unsupported = (kind: AmmAdapter["kind"]): AmmAdapter => ({
  kind,
  async readReserves() {
    // Fails loudly on purpose. Returning zero, or a plausible number, would
    // be worse: the market would open on an invented price.
    throw new Error(
      `adapter ${kind} not implemented — on-chain layout unconfirmed (Blocker #1)`,
    );
  },
});

export const adapters: Record<AmmAdapter["kind"], AmmAdapter> = {
  mock: mockAdapter,
  meteora: unsupported("meteora"),
  orca: unsupported("orca"),
  raydium: unsupported("raydium"),
};

/** `price = usdc_reserve / fraction_reserve`, in WAD. */
export function spotPrice(r: Reserves): bigint {
  if (r.fraction === 0n) throw new Error("pool has no fraction reserve");
  return (r.usdc * 1_000_000n) / r.fraction;
}
