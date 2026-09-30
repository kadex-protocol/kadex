/**
 * @slab/oracle — adaptadores de leitura de AMM, off-chain.
 *
 * # Blocker #1
 *
 * O formato on-chain do pool real de fracoes/USDC ainda NAO foi confirmado.
 * O adaptador `mock` existe para o time trabalhar desde o dia 1 sem ninguem
 * escrever codigo que finge integracao pronta. Os adaptadores reais lancam
 * ate alguem confirmar o layout.
 *
 * Quando confirmar, so este arquivo e `programs/oracle/src/adapter.rs` mudam.
 */

import type { Connection, PublicKey } from "@solana/web3.js";

export interface Reserves {
  /** Reserva em USDC nativo. E o `R` do teto de profundidade. */
  usdc: bigint;
  /** Reserva em fracoes de card. */
  fraction: bigint;
}

export interface AmmAdapter {
  readonly kind: "mock" | "meteora" | "orca" | "raydium";
  readReserves(conn: Connection, pool: PublicKey): Promise<Reserves>;
}

/** Layout do pool mock: 8 bytes de discriminador + dois u64 LE. */
export const mockAdapter: AmmAdapter = {
  kind: "mock",
  async readReserves(conn, pool) {
    const info = await conn.getAccountInfo(pool);
    if (!info) throw new Error(`pool ${pool.toBase58()} nao existe`);
    if (info.data.length < 24) throw new Error("layout de pool mock inesperado");
    return {
      usdc: info.data.readBigUInt64LE(8),
      fraction: info.data.readBigUInt64LE(16),
    };
  },
};

const unsupported = (kind: AmmAdapter["kind"]): AmmAdapter => ({
  kind,
  async readReserves() {
    // Falha alto de proposito. Retornar zero ou um numero plausivel seria
    // pior: o mercado abriria com preco inventado.
    throw new Error(
      `adaptador ${kind} nao implementado — layout on-chain nao confirmado (Blocker #1)`,
    );
  },
});

export const adapters: Record<AmmAdapter["kind"], AmmAdapter> = {
  mock: mockAdapter,
  meteora: unsupported("meteora"),
  orca: unsupported("orca"),
  raydium: unsupported("raydium"),
};

/** `preco = reserva_usdc / reserva_fracao`, em WAD. */
export function spotPrice(r: Reserves): bigint {
  if (r.fraction === 0n) throw new Error("pool sem reserva de fracao");
  return (r.usdc * 1_000_000n) / r.fraction;
}
