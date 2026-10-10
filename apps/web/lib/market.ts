/**
 * The frontend's data boundary.
 *
 * Everything the UI renders comes through here. Today it is served from
 * `SAMPLE`, which is plainly labelled sample content in the interface. When
 * the programs are deployed, only the functions in this file change — no
 * component reaches past it.
 *
 * The shapes are the real ones from `@kadex/types`, and the derived numbers go
 * through the real `@kadex/sdk` maths, so what the screen shows is computed the
 * same way the program computes it. That is the point of routing sample data
 * through the production path rather than hardcoding pretty numbers.
 */

import type { MarketView, OracleView, PoolView, PositionView, Side } from "@kadex/types";
import { gates, oracleTradeable } from "@kadex/types";
import { PublicKey } from "@solana/web3.js";
import { WAD } from "@kadex/types";
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
  readVaultInventory,
} from "@kadex/sdk";
import { readChain, readPositions, readTokenBalances } from "./chain";
import { CLUSTER, type Cluster } from "./cluster";
import { loadVaultCard } from "./collectorCrypt";
import { HISTORY_POINTS, HISTORY_STEP_SECS, type IndexHistoryWire } from "./history";
import { readLedger, simPrice, walletOf, type SimCard } from "./sim";
import { loadTestCards, originalOf } from "./testCards";

export { HISTORY_STEP_SECS };

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
    // `now` so a deposit quote counts the borrow the book owes up to this moment, as the program will.
    const marks = marksOf(chain.oracle, chain.now);
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
  const ledger = readLedger();
  const price = simPrice(Date.now() / 1000);
  const held = Object.values(ledger.wallets).flatMap((w) => w.positions);
  const pool: PoolView = {
    ...SAMPLE_POOL,
    usdcSleeve: ledger.usdcSleeve,
    cardSleeveValue: math.mulWadFloor(ledger.fractionBalance, price),
    clpSupply: ledger.clpSupply,
    marginHeld: held.reduce((a, p) => a + p.margin, 0n),
  };
  const oracle: OracleView = { ...SAMPLE_ORACLE, price, twap: price, spot: price };
  const market: MarketView = {
    ...SAMPLE_MARKET,
    oiLong: ledger.oiLong,
    oiShort: ledger.oiShort,
    openPositions: SAMPLE_MARKET.openPositions + held.length,
  };
  return snapshotOf(pool, oracle, market, { low: price, high: price }, ledger.fractionBalance, navRedeem(pool));
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
export async function loadPositions(owner: PublicKey | null, snapshot: MarketSnapshot | null): Promise<PositionView[]> {
  if (!owner || !snapshot) return [];
  const positions = CLUSTER
    ? (await readPositions(CLUSTER, owner)).filter((p) => p.market.equals(snapshot.market.address))
    : walletOf(readLedger(), owner.toBase58()).positions.map((p) => ({
        ...p,
        address: new PublicKey(p.address),
        owner,
        borrowIdxEntry: RAY,
      }));
  return positions
    .map((p) => {
      const { liquidatable: _liquidatable, ...derived } = derivePosition(p, snapshot.market, snapshot.oracle.price, snapshot.pool.params);
      return {
        address: p.address,
        owner: p.owner,
        side: p.side,
        notional: p.notional,
        margin: p.margin,
        entryPrice: p.entryPrice,
        borrowIdxEntry: p.borrowIdxEntry,
        openedTs: p.openedTs,
        ...derived,
      };
    });
}

export interface IndexPoint {
  ts: number;
  price: bigint;
}

/**
 * The mark price over the last 24 hours, one point per five minutes.
 *
 * On a cluster it comes from the oracle's `PriceRefreshed` events via
 * `/api/index-history`, with the price just read appended so the chart ends
 * where the ticket quotes. An empty list means no refresh is in the window,
 * and the chart says so rather than drawing a line.
 */
export async function loadIndexHistory(snapshot: MarketSnapshot): Promise<IndexPoint[]> {
  if (!IS_SAMPLE) {
    const res = await fetch("/api/index-history");
    if (!res.ok) return [];
    const body = (await res.json()) as IndexHistoryWire;
    const points = body.points.map((p) => ({ ts: p.ts, price: BigInt(p.price) }));
    const latest = snapshot.oracle.lastUpdateTs;
    if (latest > 0n) {
      const ts = Math.floor(Number(latest) / HISTORY_STEP_SECS) * HISTORY_STEP_SECS;
      const last = points[points.length - 1];
      if (last && last.ts === ts) last.price = snapshot.oracle.price;
      else if (!last || last.ts < ts) points.push({ ts, price: snapshot.oracle.price });
    }
    return points;
  }
  const now = Math.floor(Date.now() / 1000 / HISTORY_STEP_SECS) * HISTORY_STEP_SECS;
  const points = Array.from({ length: HISTORY_POINTS }, (_, i) => {
    const ts = now - (HISTORY_POINTS - 1 - i) * HISTORY_STEP_SECS;
    return { ts, price: simPrice(ts) };
  });
  points[points.length - 1]!.price = snapshot.oracle.price;
  return points;
}

export const priceAt = (snapshot: MarketSnapshot | null, ts: number): bigint | null =>
  IS_SAMPLE ? simPrice(ts) : snapshot?.oracle.price ?? null;

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
  } else if (!oracleTradeable(oracle.state) && oracle.state !== "stale") {
    // A stale price does not block: the order's own transaction refreshes it first (refreshIfAging).
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
  const { usdc, fractions, clp } = walletOf(readLedger(), owner.toBase58());
  return { usdc, fractions, clp };
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
 * paying for a mechanism with no audience. Rates are percent per month.
 */
export function borrowSpread(s: MarketSnapshot) {
  const perMonth = (hourly: bigint) => (Number(hourly) / 1e6) * 24 * 30 * 100;
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

export interface CardHolding extends SimCard {
  redeemable: boolean;
  asset?: string;
  held?: bigint;
}

async function clusterVaultedCards({ connection }: Cluster, owner: PublicKey): Promise<CardHolding[]> {
  const [rows, twins] = await Promise.all([readVaultInventory(connection, owner), loadTestCards()]);
  return Promise.all(
    rows.map(async (row) => {
      const asset = row.asset.toBase58();
      const nftAddress = originalOf(twins, asset) ?? asset;
      const card = await loadVaultCard(nftAddress).catch(() => null);
      return {
        nftAddress,
        asset,
        name: card?.name ?? `${asset.slice(0, 4)}…${asset.slice(-4)}`,
        grade: card ? `${card.gradingCompany} ${card.grade}`.trim() : "",
        image: card?.frontImage ?? null,
        minted: row.supply,
        held: row.held,
        redeemable: row.missing === 0n,
      };
    }),
  );
}

export async function loadVaultedCards(owner: PublicKey | null): Promise<CardHolding[]> {
  if (!owner) return [];
  if (CLUSTER) return clusterVaultedCards(CLUSTER, owner);
  const wallet = walletOf(readLedger(), owner.toBase58());
  return wallet.cards.map((c) => ({ ...c, redeemable: wallet.fractions >= c.minted }));
}

export interface Portfolio {
  cards: CardHolding[];
  fractions: bigint;
  /** CLP shares held, and what they redeem for at current NAV. */
  clp: bigint;
  clpValue: bigint;
  totalValue: bigint;
  totalPnl: bigint;
  longNotional: bigint;
  shortNotional: bigint;
  cash: bigint;
  positions: PositionView[];
}

export async function loadPortfolio(owner: PublicKey | null): Promise<Portfolio> {
  const snapshot = await loadMarket();
  const [positions, balances, cards] = await Promise.all([
    loadPositions(owner, snapshot),
    loadBalances(owner),
    loadVaultedCards(owner),
  ]);
  const sum = (f: (p: PositionView) => bigint) => positions.reduce((a, p) => a + f(p), 0n);
  const totalPnl = sum((p) => p.pnl - p.borrowOwed);
  return {
    cards,
    fractions: balances.fractions,
    clp: balances.clp,
    clpValue: quoteWithdraw(snapshot, balances.clp).totalValue,
    totalValue: balances.usdc + sum((p) => p.margin) + totalPnl,
    totalPnl,
    longNotional: sum((p) => (p.side === "long" ? p.notional : 0n)),
    shortNotional: sum((p) => (p.side === "short" ? p.notional : 0n)),
    cash: balances.usdc,
    positions,
  };
}
