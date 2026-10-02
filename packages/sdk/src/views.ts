/**
 * Values the frontend displays that are NOT stored on any account: PnL,
 * borrow owed, equity, health and liquidation price.
 *
 * Computed here with the same fixed-point arithmetic as the Rust.
 */

import type { MarketView, OracleView, PoolParams, PoolView, PositionView, Side } from "@slab/types";
import * as m from "./math.js";

/** Raw position data, as it comes off the account. */
export interface RawPosition {
  side: Side;
  notional: bigint;
  margin: bigint;
  entryPrice: bigint;
  borrowIdxEntry: bigint;
}

/** Complete a position with everything the screen needs to show. */
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

/** Market risk capacity: BOTH ceilings and which one binds. */
export function deriveCapacity(
  pool: Pick<PoolView, "usdcSleeve" | "params">,
  oracle: Pick<OracleView, "depthUsdc">,
  market: Pick<MarketView, "oiLong" | "oiShort">,
) {
  const p = pool.params;
  const capSolvency = m.oiCapSolvency(pool.usdcSleeve, p.phi, p.deltaMax);
  // The program folds `attack_safety` into mu before taking the ceiling
  // (slab-risk). Leaving it out here made the screen report DOUBLE the
  // capacity the chain would allow.
  const muEffective = m.mulWadCeil(p.mu, p.attackSafety);
  const capDepth = m.oiCapDepth(oracle.depthUsdc, p.deltaLiq, muEffective);
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

/** Current borrow rate for each side. */
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

/** NAV, CLP price and sleeve composition. */
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

/** What leaves each sleeve on a redemption. Always both. */
export function deriveWithdraw(pool: PoolView, shares: bigint) {
  return {
    usdc: m.proportionalShare(pool.usdcSleeve, shares, pool.clpSupply),
    cardFractions: m.proportionalShare(pool.cardSleeveValue, shares, pool.clpSupply),
  };
}
