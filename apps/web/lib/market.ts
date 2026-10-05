/**
 * The frontend's data boundary.
 *
 * Everything the UI renders comes through here. Today it is served from
 * `SAMPLE`, which is plainly labelled sample content in the interface. When
 * the programs are deployed, only the functions in this file change — no
 * component reaches past it.
 *
 * The shapes are the real ones from `@slab/types`, and the derived numbers go
 * through the real `@slab/sdk` maths, so what the screen shows is computed the
 * same way the program computes it. That is the point of routing sample data
 * through the production path rather than hardcoding pretty numbers.
 */

import type { MarketView, OracleView, PoolView, PositionView, Side } from "@slab/types";
import { gates, oracleTradeable } from "@slab/types";
import { PublicKey } from "@solana/web3.js";
import { WAD } from "@slab/types";
import {
  deriveBorrowRates,
  deriveCapacity,
  derivePool,
  derivePosition,
  deriveWithdraw,
  math,
} from "@slab/sdk";

/** Flips to false the moment this is pointed at a cluster. */
export const IS_SAMPLE = true;

const USDC = 1_000_000n;
const ZERO = new PublicKey("11111111111111111111111111111111");

export interface Constituent {
  id: string;
  ref: string;
  name: string;
  series: string;
  year: string;
  category: string;
  /** Index weight in basis points. */
  weightBps: number;
  grade: string;
  /** Which artwork to draw. */
  art: "ascent" | "orbit" | "fields" | "meridian" | "relic";
}

/**
 * The basket. Weights are the ones a `BasketCard` account carries on-chain;
 * names and grades are illustrative until the real mints are whitelisted.
 */
export const CONSTITUENTS: Constituent[] = [
  { id: "001", ref: "A1023847", name: "Ascent", series: "Archive", year: "1999", category: "Trading cards", weightBps: 3200, grade: "GEM MT 10", art: "ascent" },
  { id: "002", ref: "B7712093", name: "Orbit", series: "Archive", year: "1998", category: "Trading cards", weightBps: 2400, grade: "GEM MT 10", art: "orbit" },
  { id: "003", ref: "C5587410", name: "Fields", series: "Archive", year: "1993", category: "Trading cards", weightBps: 1900, grade: "GEM MT 10", art: "fields" },
  { id: "004", ref: "D2240918", name: "Meridian", series: "Archive", year: "1986", category: "Sports", weightBps: 1500, grade: "MINT 9", art: "meridian" },
  { id: "005", ref: "E9014772", name: "Relic", series: "Archive", year: "1977", category: "Sports", weightBps: 1000, grade: "MINT 9", art: "relic" },
];

const SAMPLE_POOL: PoolView = {
  address: ZERO,
  usdcSleeve: 140_000n * USDC,
  cardSleeveValue: 60_000n * USDC,
  clpSupply: 200_000n * USDC,
  traderPnl: 0n,
  badDebt: 0n,
  accruedFeesLp: 0n,
  accruedFeesProtocol: 0n,
  state: "active",
  params: {
    cardSleeveTarget: 300_000n,
    phi: 500_000n,
    deltaMax: 300_000n,
    mu: 300_000n,
    deltaLiq: 187_500n,
    baseLeverage: 5_000_000n,
    maintenanceMargin: 62_500n,
    r0: 50n,
    r1: 500n,
    psi: 500_000n,
    openCloseFeeBps: 10,
    liquidatorFeeBps: 100,
    depositHaircutBps: 300,
    maxCardWeight: 150_000n,
    lpFeeShareBps: 7500,
    reduceOnlyUtilization: 950_000n,
    attackSafety: 2_000_000n, // 2x
  },
};

const SAMPLE_ORACLE: OracleView = {
  address: ZERO,
  price: WAD,
  twap: WAD,
  spot: WAD,
  depthUsdc: 60_000n * USDC,
  lastUpdateTs: 0n,
  externalMedian: 0n,
  state: "ok",
};

const SAMPLE_MARKET: MarketView = {
  address: ZERO,
  oiLong: 4_200n * USDC,
  oiShort: 1_800n * USDC,
  borrowIdxLong: 1_000_000_000_000n,
  borrowIdxShort: 1_000_000_000_000n,
  lastAccrualTs: 0n,
  openPositions: 2,
};

export interface MarketSnapshot {
  pool: PoolView;
  oracle: OracleView;
  market: MarketView;
  /** NAV, CLP price, sleeve split — from the SDK, not from constants. */
  poolStats: ReturnType<typeof derivePool>;
  /** Both ceilings and which one binds. */
  capacity: ReturnType<typeof deriveCapacity>;
  borrow: ReturnType<typeof deriveBorrowRates>;
}

/**
 * One read of everything the market screen needs.
 *
 * Replace the three `SAMPLE_*` constants with account fetches and the rest of
 * the application does not change.
 */
export async function loadMarket(): Promise<MarketSnapshot> {
  const pool = SAMPLE_POOL;
  const oracle = SAMPLE_ORACLE;
  const market = SAMPLE_MARKET;
  const capacity = deriveCapacity(pool, oracle, market);
  return {
    pool,
    oracle,
    market,
    poolStats: derivePool(pool),
    capacity,
    borrow: deriveBorrowRates(pool, market, capacity.cap),
  };
}

/**
 * Positions for a wallet.
 *
 * Returns nothing without a wallet, and nothing for a wallet with no
 * positions — the UI has to render both, and an empty list is the honest
 * answer until the programs are live.
 */
export async function loadPositions(owner: PublicKey | null): Promise<PositionView[]> {
  if (!owner) return [];
  return [];
}

/** What a quote looks like before anything is signed. */
export interface Quote {
  side: Side;
  notional: bigint;
  margin: bigint;
  fee: bigint;
  entryPrice: bigint;
  liquidationPrice: bigint;
  /** Null when the order is fine; a sentence when it is not. */
  problem: string | null;
}

/**
 * Price an order without sending anything.
 *
 * Uses the same functions the program uses, so the liquidation price shown
 * here is the one the chain would record. If these ever disagree, the screen
 * is lying to the user about where they get closed out.
 */
export function quote(snapshot: MarketSnapshot, side: Side, notionalUsdc: bigint): Quote {
  const { pool, oracle, capacity } = snapshot;

  // An empty input is not an order. Health and liquidation price both divide
  // by notional, so quoting zero would throw rather than return nothing.
  if (notionalUsdc <= 0n) {
    return {
      side,
      notional: 0n,
      margin: 0n,
      fee: 0n,
      entryPrice: oracle.price,
      liquidationPrice: 0n,
      problem: null,
    };
  }

  const leverage = pool.params.baseLeverage;
  const margin = (notionalUsdc * WAD + leverage - 1n) / leverage;
  const fee = (notionalUsdc * BigInt(pool.params.openCloseFeeBps) + 9_999n) / 10_000n;

  const derived = derivePosition(
    {
      side,
      notional: notionalUsdc,
      margin,
      entryPrice: oracle.price,
      borrowIdxEntry: side === "long" ? snapshot.market.borrowIdxLong : snapshot.market.borrowIdxShort,
    },
    snapshot.market,
    oracle.price,
    pool.params,
  );

  let problem: string | null = null;
  if (pool.state !== "active") {
    problem = "The market is not accepting new positions.";
  } else if (!oracleTradeable(oracle.state)) {
    problem = `The index price is ${oracle.state} and not currently tradeable.`;
  } else if (notionalUsdc > capacity.free) {
    problem = `Exceeds available capacity of ${(Number(capacity.free) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 })} USDC.`;
  }

  return {
    side,
    notional: notionalUsdc,
    margin,
    fee,
    entryPrice: oracle.price,
    liquidationPrice: derived.liquidationPrice,
    problem,
  };
}

export const fmtUsd = (x: bigint, digits = 0) =>
  (Number(x) / 1e6).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const fmtPrice = (x: bigint) => (Number(x) / 1e6).toFixed(4);

export const fmtPct = (wad: bigint, digits = 2) => `${((Number(wad) / 1e6) * 100).toFixed(digits)}%`;

export const fmtBps = (bps: number) => `${(bps / 100).toFixed(2)}%`;

// ───────────────────────────────────────────────────────────────────────────
// Liquidity provision
// ───────────────────────────────────────────────────────────────────────────

/** A CLP depositor holds a wallet balance of each thing they can deposit. */
export interface Balances {
  usdc: bigint;
  fractions: bigint;
  clp: bigint;
}

/** Nothing, until a wallet is connected and the programs are live. */
export async function loadBalances(owner: PublicKey | null): Promise<Balances> {
  if (!owner) return { usdc: 0n, fractions: 0n, clp: 0n };
  return { usdc: 0n, fractions: 0n, clp: 0n };
}

export type DepositKind = "usdc" | "fractions";

export interface DepositQuote {
  /** Value credited after any haircut. */
  netValue: bigint;
  /** What the haircut costs, in USDC. Zero for a USDC deposit. */
  haircut: bigint;
  shares: bigint;
  /** Share of the pool afterwards, WAD. */
  shareOfPool: bigint;
  problem: string | null;
}

/**
 * Price a CLP deposit.
 *
 * USDC goes in at face. Card fractions take a haircut and are additionally
 * refused if they would push the illiquid sleeve past its target, because the
 * liquid sleeve is what pays winning traders — letting the card side grow
 * unchecked would quietly shrink the capacity backing every open position.
 */
export function quoteDeposit(
  snapshot: MarketSnapshot,
  kind: DepositKind,
  amount: bigint,
): DepositQuote {
  const { pool, poolStats, oracle } = snapshot;
  const empty: DepositQuote = {
    netValue: 0n,
    haircut: 0n,
    shares: 0n,
    shareOfPool: 0n,
    problem: null,
  };
  if (amount <= 0n) return empty;

  // 1 fraction = $1 at parity; the oracle price moves that.
  const gross = kind === "usdc" ? amount : (amount * oracle.price) / WAD;
  const haircutBps = kind === "usdc" ? 0n : BigInt(pool.params.depositHaircutBps);
  // The program rounds the deduction up, against the depositor.
  const haircut = (gross * haircutBps + 9_999n) / 10_000n;
  const netValue = gross - haircut;

  const shares = math.sharesForDeposit(netValue, poolStats.nav, pool.clpSupply);
  const supplyAfter = pool.clpSupply + shares;

  let problem: string | null = null;
  if (!gates(pool.state).canDeposit) {
    problem = `The pool is ${pool.state} and is not accepting deposits.`;
  } else if (shares <= 0n) {
    problem = "Too small — this would mint zero CLP.";
  } else if (kind === "fractions") {
    // require_sleeve_within_target, checked here so the button can explain
    // itself rather than the transaction failing.
    const cardsAfter = ((pool.cardSleeveValue / (oracle.price || WAD)) * WAD + amount * oracle.price) / WAD;
    const totalAfter = cardsAfter + pool.usdcSleeve;
    const weight = totalAfter === 0n ? 0n : (cardsAfter * WAD) / totalAfter;
    if (weight > pool.params.cardSleeveTarget) {
      problem = `Would take the card sleeve to ${fmtPct(weight, 1)}, above its ${fmtPct(pool.params.cardSleeveTarget, 0)} target.`;
    }
  }

  return {
    netValue,
    haircut,
    shares,
    shareOfPool: supplyAfter === 0n ? 0n : (shares * WAD) / supplyAfter,
    problem,
  };
}

export interface WithdrawQuote {
  usdc: bigint;
  fractions: bigint;
  totalValue: bigint;
  problem: string | null;
}

/**
 * Price a CLP redemption.
 *
 * A withdrawal is a proportional slice of BOTH sleeves — you cannot take only
 * the USDC and leave the cards behind. That is what stops a run from draining
 * the liquid side and stranding everyone else with the illiquid one.
 */
export function quoteWithdraw(snapshot: MarketSnapshot, shares: bigint): WithdrawQuote {
  const { pool, oracle } = snapshot;
  if (shares <= 0n) return { usdc: 0n, fractions: 0n, totalValue: 0n, problem: null };

  if (shares > pool.clpSupply) {
    return { usdc: 0n, fractions: 0n, totalValue: 0n, problem: "More CLP than exists." };
  }

  const split = deriveWithdraw(pool, shares);
  return {
    usdc: split.usdc,
    fractions: split.cardFractions,
    totalValue: split.usdc + split.cardFractions,
    problem: gates(pool.state).canWithdraw
      ? null
      : `The pool is ${pool.state} and is not accepting redemptions.`,
  };
}


// ───────────────────────────────────────────────────────────────────────────
// Borrow spread — what the arbitrageur came for (docs/users.md, role 5)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Both sides' borrow cost and the gap between them.
 *
 * The ticket used to show only the rate for the side you had selected, which
 * made the spread — the single number an arbitrageur trades on — invisible.
 * `psi` exists to widen this gap when the book is one-sided; hiding it meant
 * paying for a mechanism with no audience.
 */
export function borrowSpread(s: MarketSnapshot) {
  const perMonth = (hourly: bigint) => (Number(hourly) / 1e6) * 24 * 30;
  const long = perMonth(s.borrow.long);
  const short = perMonth(s.borrow.short);
  const crowded = long >= short ? "long" : "short";
  return {
    longMonthly: long,
    shortMonthly: short,
    spread: Math.abs(long - short),
    crowded: crowded as Side,
    /** The side an arbitrageur gets paid to take. */
    paidSide: (crowded === "long" ? "short" : "long") as Side,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Portfolio
// ───────────────────────────────────────────────────────────────────────────

export interface PositionRow {
  constituentId: string;
  side: Side;
  notional: bigint;
  margin: bigint;
  entryPrice: bigint;
  markPrice: bigint;
  pnl: bigint;
  pnlPct: number;
  leverage: number;
}

/**
 * Sample positions, shown ONLY while `IS_SAMPLE` is true and always behind the
 * "concept preview · sample data" flag in the chrome.
 *
 * There is no deployment, so a wallet genuinely has no positions. An empty
 * table is the honest state and the page renders it when this is off — but a
 * table that has never been seen with data in it is a table nobody has
 * checked, so these exist to exercise the real one.
 */
const SAMPLE_POSITIONS: PositionRow[] = [
  { constituentId: "001", side: "long", notional: 2_480n * 1_000_000n, margin: 496n * 1_000_000n, entryPrice: 1_010_320n, markPrice: 1_047_210n, pnl: 90_600_000n, pnlPct: 3.65, leverage: 5 },
  { constituentId: "003", side: "short", notional: 1_920n * 1_000_000n, margin: 384n * 1_000_000n, entryPrice: 1_043_170n, markPrice: 1_019_080n, pnl: 44_300_000n, pnlPct: 2.31, leverage: 5 },
  { constituentId: "004", side: "long", notional: 3_160n * 1_000_000n, margin: 632n * 1_000_000n, entryPrice: 1_045_500n, markPrice: 1_031_120n, pnl: -43_400_000n, pnlPct: -1.37, leverage: 5 },
];

export interface Portfolio {
  rows: PositionRow[];
  totalValue: bigint;
  totalPnl: bigint;
  longNotional: bigint;
  shortNotional: bigint;
  cash: bigint;
}

export async function loadPortfolio(owner: PublicKey | null): Promise<Portfolio> {
  const rows = owner && IS_SAMPLE ? SAMPLE_POSITIONS : [];
  const sum = (f: (r: PositionRow) => bigint) => rows.reduce((a, r) => a + f(r), 0n);
  const cash = rows.length ? 5_240n * 1_000_000n : 0n;
  const margin = sum((r) => r.margin);
  return {
    rows,
    totalValue: margin + cash + sum((r) => r.pnl),
    totalPnl: sum((r) => r.pnl),
    longNotional: sum((r) => (r.side === "long" ? r.notional : 0n)),
    shortNotional: sum((r) => (r.side === "short" ? r.notional : 0n)),
    cash,
  };
}
