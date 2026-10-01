/**
 * TypeScript mirror of `packages/slab-math`.
 *
 * The frontend has to show PnL, health and liquidation price BEFORE the
 * transaction is sent. If these calculations drift from the Rust, the screen
 * lies: the user sees one liquidation price and the program uses another.
 *
 * `npm run test:parity` runs the same vectors as the Rust tests against these
 * functions. Any divergence fails there, not in production.
 *
 * Everything here is BigInt. No Number anywhere near money: Number loses
 * precision above 2^53, and a native USDC balance passes that easily.
 */

export const WAD = 1_000_000n;
export const BPS = 10_000n;
export const RAY = 1_000_000_000_000n;

export type Side = "long" | "short";

const abs = (x: bigint) => (x < 0n ? -x : x);

/** `a * b / c`, rounding down. */
export function mulDivFloor(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new Error("div by zero");
  return (a * b) / c;
}

/** `a * b / c`, rounding up. Used where rounding favours the pool. */
export function mulDivCeil(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new Error("div by zero");
  const p = a * b;
  return p % c === 0n ? p / c : p / c + 1n;
}

export const mulWadFloor = (x: bigint, f: bigint) => mulDivFloor(x, f, WAD);
export const mulWadCeil = (x: bigint, f: bigint) => mulDivCeil(x, f, WAD);
export const divWadFloor = (x: bigint, d: bigint) => mulDivFloor(x, WAD, d);

/** Integer square root by Newton's method, same as the Rust. */
export function isqrt(x: bigint): bigint {
  if (x < 2n) return x;
  let r = 1n << (BigInt(x.toString(2).length + 1) / 2n);
  for (;;) {
    const next = (r + x / r) / 2n;
    if (next >= r) return r;
    r = next;
  }
}

/** `sqrt(x)` with x and result in WAD. */
export const sqrtWad = (xWad: bigint) => isqrt(xWad * WAD);

/** `u = OI / capacity`, saturating at 1.0. */
export function utilization(oiTotal: bigint, capacity: bigint): bigint {
  if (capacity === 0n) return oiTotal === 0n ? 0n : WAD;
  const u = divWadFloor(oiTotal, capacity);
  return u > WAD ? WAD : u;
}

/** `r = r0 + r1 * u^2`, hourly, in WAD. */
export const borrowRateHourly = (r0: bigint, r1: bigint, u: bigint) =>
  r0 + mulWadFloor(r1, mulWadFloor(u, u));

/** `1 + psi * max(0, (side - opposite)/total)`. */
export function sideMultiplier(oiSide: bigint, oiOpposite: bigint, psi: bigint): bigint {
  const total = oiSide + oiOpposite;
  if (total === 0n || oiSide <= oiOpposite) return WAD;
  return WAD + mulWadFloor(psi, divWadFloor(oiSide - oiOpposite, total));
}

/** Borrow owed between two indices. Rounds up. */
export function borrowOwed(notional: bigint, idxEntry: bigint, idxNow: bigint): bigint {
  if (idxEntry === 0n) throw new Error("bad index");
  if (idxNow < idxEntry) throw new Error("index regressed");
  return mulDivCeil(notional, idxNow - idxEntry, idxEntry);
}

/** Signed PnL, rounding down in magnitude. */
export function pnl(side: Side, entry: bigint, price: bigint, notional: bigint): bigint {
  if (entry === 0n) throw new Error("div by zero");
  const up = price >= entry;
  const positive = side === "long" ? up : !up;
  const magnitude = mulDivFloor(notional, abs(price - entry), entry);
  return positive ? magnitude : -magnitude;
}

export const equity = (margin: bigint, pnlSigned: bigint, owed: bigint) =>
  margin + pnlSigned - owed;

export function healthWad(equitySigned: bigint, notional: bigint): bigint {
  if (notional === 0n) throw new Error("div by zero");
  return (equitySigned * WAD) / notional;
}

/** Liquidation price. Must match the Rust down to the last unit. */
export function liquidationPrice(
  side: Side,
  entry: bigint,
  margin: bigint,
  notional: bigint,
  owed: bigint,
  maintenance: bigint,
): bigint {
  if (notional === 0n) throw new Error("div by zero");
  const net = margin - owed;
  if (net <= 0n) return entry;
  const buffer = divWadFloor(net, notional);
  if (buffer <= maintenance) return entry;
  const delta = mulWadFloor(entry, buffer - maintenance);
  return side === "long" ? (entry > delta ? entry - delta : 0n) : entry + delta;
}

/** Minimum margin for maximum leverage. Rounds up. */
export const minMargin = (notional: bigint, maxLeverage: bigint) =>
  mulDivCeil(notional, WAD, maxLeverage);

/** `U * phi / delta_max`. */
export const oiCapSolvency = (usdcSleeve: bigint, phi: bigint, deltaMax: bigint) =>
  mulDivFloor(mulWadFloor(usdcSleeve, phi), WAD, deltaMax);

/** `R * (sqrt(1 + delta_liq) - 1) / mu`. */
export function oiCapDepth(depth: bigint, deltaLiq: bigint, mu: bigint): bigint {
  const root = sqrtWad(WAD + deltaLiq);
  const factor = root > WAD ? root - WAD : 0n;
  return mulDivFloor(mulWadFloor(depth, factor), WAD, mu);
}

/** The ceiling that counts is always the lower one. */
export const oiAllowed = (a: bigint, b: bigint) => (a < b ? a : b);

/** Cost of moving a constant-product price by `(1+delta)`. */
export function costToMovePrice(depth: bigint, delta: bigint): bigint {
  const root = sqrtWad(WAD + delta);
  return mulWadFloor(depth, root > WAD ? root - WAD : 0n);
}

/** `U + cards - pnl - badDebt`, floored at zero. */
export function nav(usdc: bigint, cards: bigint, traderPnl: bigint, badDebt: bigint): bigint {
  const v = usdc + cards - traderPnl - badDebt;
  return v > 0n ? v : 0n;
}

export const clpPrice = (navValue: bigint, supply: bigint) =>
  supply === 0n ? WAD : divWadFloor(navValue, supply);

export const sharesForDeposit = (value: bigint, navValue: bigint, supply: bigint) =>
  supply === 0n || navValue === 0n ? value : mulDivFloor(value, supply, navValue);

export const assetsForShares = (shares: bigint, navValue: bigint, supply: bigint) => {
  if (supply === 0n) throw new Error("div by zero");
  return mulDivFloor(shares, navValue, supply);
};

/** Proportional slice of one sleeve. A withdrawal never comes from just one. */
export function proportionalShare(sleeve: bigint, shares: bigint, supply: bigint): bigint {
  if (supply === 0n) throw new Error("div by zero");
  if (shares > supply) throw new Error("shares > supply");
  return mulDivFloor(sleeve, shares, supply);
}

/** Pro-rata settlement haircut. Equal for everyone. */
export function prorataHaircut(claim: bigint, totalClaims: bigint, available: bigint): bigint {
  if (totalClaims === 0n) return 0n;
  if (available >= totalClaims) return claim;
  return mulDivFloor(claim, available, totalClaims);
}
