/**
 * Derivados que o frontend mostra e que NAO existem na conta: PnL, borrow
 * devido, patrimonio, saude e preco de liquidacao.
 *
 * Calculados aqui com o mesmo ponto fixo do Rust.
 */

import type { MarketView, OracleView, PoolParams, PoolView, PositionView, Side } from "@slab/types";
import * as m from "./math.js";

/** Dados crus de uma posicao, como saem da conta. */
export interface RawPosition {
  side: Side;
  notional: bigint;
  margin: bigint;
  entryPrice: bigint;
  borrowIdxEntry: bigint;
}

/** Completa uma posicao com tudo que a tela precisa mostrar. */
export function derivePosition(
  raw: RawPosition,
  market: Pick<MarketView, "borrowIdxLong" | "borrowIdxShort">,
  price: bigint,
  params: Pick<PoolParams, "maintenanceMargin">,
) {
  const idxNow = raw.side === "long" ? market.borrowIdxLong : market.borrowIdxShort;
  const borrowOwed = m.borrowOwed(raw.notional, raw.borrowIdxEntry, idxNow);
  const pnl = m.pnl(raw.side, raw.entryPrice, price, raw.notional);
  const equity = m.equity(raw.margin, pnl, borrowOwed);
  return {
    pnl,
    borrowOwed,
    equity,
    healthWad: m.healthWad(equity, raw.notional),
    liquidationPrice: m.liquidationPrice(
      raw.side,
      raw.entryPrice,
      raw.margin,
      raw.notional,
      borrowOwed,
      params.maintenanceMargin,
    ),
    liquidatable: m.healthWad(equity, raw.notional) < params.maintenanceMargin,
  };
}

/** Capacidade de risco do mercado, com os DOIS tetos e qual deles trava. */
export function deriveCapacity(
  pool: Pick<PoolView, "usdcSleeve" | "params">,
  oracle: Pick<OracleView, "depthUsdc">,
  market: Pick<MarketView, "oiLong" | "oiShort">,
) {
  const p = pool.params;
  const capSolvency = m.oiCapSolvency(pool.usdcSleeve, p.phi, p.deltaMax);
  const capDepth = m.oiCapDepth(oracle.depthUsdc, p.deltaLiq, p.mu);
  const cap = m.oiAllowed(capSolvency, capDepth);
  const oiTotal = market.oiLong + market.oiShort;
  return {
    capSolvency,
    capDepth,
    cap,
    binding: capSolvency <= capDepth ? ("solvency" as const) : ("depth" as const),
    oiTotal,
    free: cap > oiTotal ? cap - oiTotal : 0n,
    utilization: m.utilization(oiTotal, cap),
  };
}

/** Taxa de borrow vigente de cada lado. */
export function deriveBorrowRates(
  pool: Pick<PoolView, "params">,
  market: Pick<MarketView, "oiLong" | "oiShort">,
  cap: bigint,
) {
  const p = pool.params;
  const u = m.utilization(market.oiLong + market.oiShort, cap);
  const base = m.borrowRateHourly(p.r0, p.r1, u);
  return {
    long: m.mulWadCeil(base, m.sideMultiplier(market.oiLong, market.oiShort, p.psi)),
    short: m.mulWadCeil(base, m.sideMultiplier(market.oiShort, market.oiLong, p.psi)),
  };
}

/** NAV, preco do CLP e composicao das mangas. */
export function derivePool(pool: PoolView) {
  const nav = m.nav(pool.usdcSleeve, pool.cardSleeveValue, pool.traderPnl, pool.badDebt);
  const total = pool.usdcSleeve + pool.cardSleeveValue;
  return {
    nav,
    clpPrice: m.clpPrice(nav, pool.clpSupply),
    cardSleeveShare: total === 0n ? 0n : m.divWadFloor(pool.cardSleeveValue, total),
    usdcSleeveShare: total === 0n ? 0n : m.divWadFloor(pool.usdcSleeve, total),
  };
}

/** O que sai em cada manga num resgate. Sempre as duas. */
export function deriveWithdraw(pool: PoolView, shares: bigint) {
  return {
    usdc: m.proportionalShare(pool.usdcSleeve, shares, pool.clpSupply),
    cardFractions: m.proportionalShare(pool.cardSleeveValue, shares, pool.clpSupply),
  };
}
