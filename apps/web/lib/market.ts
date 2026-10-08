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
  marketView,
  marksOf,
  math,
  navIssue,
  navRedeem,
  oracleView,
  poolView,
} from "@slab/sdk";
import { readChain, readTokenBalances } from "./chain";
import { CLUSTER } from "./cluster";

export const IS_SAMPLE = CLUSTER === null;

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
  /** Which card face to show. */
  art: "charizard" | "pikachu" | "jordan" | "lotus" | "luke";
}

/**
 * The basket. Weights are the ones a `BasketCard` account carries on-chain;
 * names and grades are illustrative until the real mints are whitelisted.
 */
export const CONSTITUENTS: Constituent[] = [
  { id: "001", ref: "41677010", name: "Charizard",  series: "Pokemon Game", year: "1999", category: "Trading cards", weightBps: 3200, grade: "GEM MT 10", art: "charizard" },
  { id: "002", ref: "41687010", name: "Pikachu",    series: "Pokemon Game", year: "1999", category: "Trading cards", weightBps: 2400, grade: "GEM MT 10", art: "pikachu" },
  { id: "003", ref: "63738203", name: "Black Lotus", series: "Magic",       year: "1993", category: "Trading cards", weightBps: 1900, grade: "GEM MT 10", art: "lotus" },
  { id: "004", ref: "44578113", name: "M. Jordan",  series: "Topps",        year: "1986", category: "Sports",        weightBps: 1500, grade: "GEM MT 10", art: "jordan" },
  { id: "005", ref: "63786110", name: "Skywalker",  series: "Star Wars",    year: "1977", category: "Sports",        weightBps: 1000, grade: "GEM MT 10", art: "luke" },
];

const SAMPLE_POOL: PoolView = {
  address: ZERO,
  usdcSleeve: 140_000n * USDC,
  cardSleeveValue: 60_000n * USDC,
  clpSupply: 200_000n * USDC,
  traderPnl: 0n,
  badDebt: 0n,
  marginHeld: 0n,
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
  marks: { low: bigint; high: bigint };
  fractionBalance: bigint;
  navIssue: bigint;
}

const RAY = 1_000_000_000_000n;

/**
 * One read of everything the market screen needs.
 *
 * Replace the three `SAMPLE_*` constants with account fetches and the rest of
 * the application does not change.
 */
export async function loadMarket(): Promise<MarketSnapshot> {
  if (CLUSTER) {
    const chain = await readChain(CLUSTER);
    const marks = marksOf(chain.oracle);
    const market: MarketView = chain.market
      ? marketView(chain.pool.perpMarket, chain.market)
      : { address: chain.pool.perpMarket, oiLong: 0n, oiShort: 0n, borrowIdxLong: RAY, borrowIdxShort: RAY, lastAccrualTs: 0n, openPositions: 0 };
    return snapshotOf(
      poolView(chain.poolAddress, chain.pool, marks),
      oracleView(chain.pool.oracle, chain.oracle, chain.now),
      market,
      marks,
      chain.pool.fractionBalance,
      navIssue(chain.pool, marks),
    );
  }
  const pool = SAMPLE_POOL;
  const flat = { low: SAMPLE_ORACLE.price, high: SAMPLE_ORACLE.price };
  return snapshotOf(pool, SAMPLE_ORACLE, SAMPLE_MARKET, flat, pool.cardSleeveValue, navRedeem(pool));
}

function snapshotOf(
  pool: PoolView,
  oracle: OracleView,
  market: MarketView,
  marks: MarketSnapshot["marks"],
  fractionBalance: bigint,
  issueNav: bigint,
): MarketSnapshot {
  const capacity = deriveCapacity(pool, oracle, market);
  return {
    pool,
    oracle,
    market,
    poolStats: derivePool(pool),
    capacity,
    borrow: deriveBorrowRates(pool, market, capacity.cap),
    marks,
    fractionBalance,
    navIssue: issueNav,
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

export interface IndexPoint {
  ts: number;
  price: bigint;
}

const HISTORY_POINTS = 288;
export const HISTORY_STEP_SECS = 300;
const HISTORY_SEED = 20261007;

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sample series only: there is no on-chain price history to read yet.
export async function loadIndexHistory(snapshot: MarketSnapshot): Promise<IndexPoint[]> {
  if (!IS_SAMPLE) return [];
  const random = seeded(HISTORY_SEED);
  const now = Math.floor(Date.now() / 1000 / HISTORY_STEP_SECS) * HISTORY_STEP_SECS;
  const prices = [Number(snapshot.oracle.price)];
  let trend = 0;
  for (let i = 1; i < HISTORY_POINTS; i += 1) {
    trend = trend * 0.82 + (random() - 0.5) * 0.0007;
    const step = trend + (random() - 0.5) * 0.0042 + 0.00005;
    prices.push(prices[i - 1]! / (1 + step));
  }
  return prices
    .reverse()
    .map((price, i) => ({ ts: now - (HISTORY_POINTS - 1 - i) * HISTORY_STEP_SECS, price: BigInt(Math.round(price)) }));
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
  if (CLUSTER) return readTokenBalances(CLUSTER, owner);
  // Sample only, behind the preview flag — the same wallet the portfolio shows.
  return { usdc: 5_240n * USDC, fractions: SAMPLE_CARDS[0]!.held, clp: SAMPLE_CLP };
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
  const { pool, marks } = snapshot;
  const empty: DepositQuote = {
    netValue: 0n,
    haircut: 0n,
    shares: 0n,
    shareOfPool: 0n,
    problem: null,
  };
  if (amount <= 0n) return empty;

  const gross = kind === "usdc" ? amount : math.mulWadFloor(amount, marks.low);
  const haircutBps = kind === "usdc" ? 0n : BigInt(pool.params.depositHaircutBps);
  // The program rounds the deduction up, against the depositor.
  const haircut = (gross * haircutBps + 9_999n) / 10_000n;
  const netValue = gross - haircut;

  const shares = math.sharesForDeposit(netValue, snapshot.navIssue, pool.clpSupply);
  const supplyAfter = pool.clpSupply + shares;

  let problem: string | null = null;
  if (!gates(pool.state).canDeposit) {
    problem = `The pool is ${pool.state} and is not accepting deposits.`;
  } else if (shares <= 0n) {
    problem = "Too small — this would mint zero CLP.";
  } else if (kind === "fractions") {
    // require_sleeve_within_target, checked here so the button can explain
    // itself rather than the transaction failing.
    const cardsAfter = math.mulWadFloor(snapshot.fractionBalance + amount, marks.high);
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
  const { pool, marks, market } = snapshot;
  if (shares <= 0n) return { usdc: 0n, fractions: 0n, totalValue: 0n, problem: null };

  if (shares > pool.clpSupply) {
    return { usdc: 0n, fractions: 0n, totalValue: 0n, problem: "More CLP than exists." };
  }

  const assets = pool.usdcSleeve + pool.cardSleeveValue;
  const value = math.assetsForShares(shares, navRedeem(pool), pool.clpSupply);
  const usdc = assets === 0n ? 0n : (pool.usdcSleeve * value) / assets;
  const fractions = assets === 0n ? 0n : (snapshot.fractionBalance * value) / assets;

  const oiTotal = market.oiLong + market.oiShort;
  const sleeveAfter = pool.usdcSleeve - usdc;
  let problem: string | null = null;
  if (!gates(pool.state).canWithdraw) {
    problem = `The pool is ${pool.state} and is not accepting redemptions.`;
  } else if (oiTotal > 0n && oiTotal > math.oiCapSolvency(sleeveAfter, pool.params.phi, pool.params.deltaMax)) {
    problem = "Open positions are backed by this liquidity. Withdraw less for now.";
  }

  return { usdc, fractions, totalValue: usdc + math.mulWadFloor(fractions, marks.low), problem };
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

/** A card the wallet has vaulted, and how many of its fractions it still holds. */
export interface CardHolding {
  constituentId: string;
  /** Fractions minted when the card went in. Burning all of them returns it. */
  minted: bigint;
  /** Fractions still in this wallet. */
  held: bigint;
  /** Fractions this wallet has put into the CLP pool. */
  inPool: bigint;
}

const SAMPLE_CARDS: CardHolding[] = [
  { constituentId: "001", minted: 4_200n * USDC, held: 3_000n * USDC, inPool: 1_200n * USDC },
  { constituentId: "002", minted: 1_850n * USDC, held: 1_850n * USDC, inPool: 0n },
];

const SAMPLE_CLP = 1_164n * USDC;

export interface Portfolio {
  rows: PositionRow[];
  cards: CardHolding[];
  /** CLP shares held, and what they redeem for at current NAV. */
  clp: bigint;
  clpValue: bigint;
  totalValue: bigint;
  totalPnl: bigint;
  longNotional: bigint;
  shortNotional: bigint;
  cash: bigint;
}

export async function loadPortfolio(owner: PublicKey | null): Promise<Portfolio> {
  const sample = owner !== null && IS_SAMPLE;
  const rows = sample ? SAMPLE_POSITIONS : [];
  const clp = sample ? SAMPLE_CLP : 0n;
  const { poolStats } = await loadMarket();
  const sum = (f: (r: PositionRow) => bigint) => rows.reduce((a, r) => a + f(r), 0n);
  const cash = rows.length ? 5_240n * 1_000_000n : 0n;
  const margin = sum((r) => r.margin);
  return {
    rows,
    cards: sample ? SAMPLE_CARDS : [],
    clp,
    clpValue: (clp * poolStats.clpPrice) / WAD,
    totalValue: margin + cash + sum((r) => r.pnl),
    totalPnl: sum((r) => r.pnl),
    longNotional: sum((r) => (r.side === "long" ? r.notional : 0n)),
    shortNotional: sum((r) => (r.side === "short" ? r.notional : 0n)),
    cash,
  };
}
