/**
 * @slab/types — THE FRONTEND CONTRACT.
 *
 * Mirrors in TypeScript exactly what `packages/slab-interface` freezes in
 * Rust: PDA seeds, scales, parameters and states.
 *
 * If anything here drifts from the Rust, the frontend derives addresses that
 * do not exist. `tests/parity.test.mjs` exists to catch that drift.
 */

import { PublicKey } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// program ids — FROZEN (must match Anchor.toml and keys/)
// ---------------------------------------------------------------------------

export const PROGRAM_IDS = {
  cardVault: new PublicKey("J8Tef8N4YSfVwAxpBemCZrz3qCxehTeb2cd1jTwoBczW"),
  oracle: new PublicKey("5288ShBXsFxqXiGm22FZi1ZrMnmet4i1ZR3bccyAguqp"),
  clpPool: new PublicKey("3XZkAqLeQDoNXD6Bb9YoGSEdnvqk9r7UMgrKsN5x3L9v"),
  perp: new PublicKey("BcVwJ91Jd1k7xUNcGYzRygq2ubaCYn7p5MeUZzy1EyLR"),
} as const;

// ---------------------------------------------------------------------------
// scales — must match packages/slab-math/src/lib.rs
// ---------------------------------------------------------------------------

/** Ratios, prices and parameters. 1.0 === WAD. */
export const WAD = 1_000_000n;
/** Basis points. 100% === BPS. */
export const BPS = 10_000n;
/** Accumulated borrow index. */
export const RAY = 1_000_000_000_000n;
/** USDC and card fractions both use 6 decimals. */
export const TOKEN_DECIMALS = 6;

/** Convert a WAD value to a readable number. Display only. */
export const fromWad = (x: bigint): number => Number(x) / Number(WAD);
/** Convert native USDC to dollars. Display only. */
export const fromUsdc = (x: bigint): number => Number(x) / 10 ** TOKEN_DECIMALS;
/** Dollars to native USDC. Truncates, never rounds up. */
export const toUsdc = (x: number): bigint => BigInt(Math.trunc(x * 10 ** TOKEN_DECIMALS));

// ---------------------------------------------------------------------------
// seeds — must match slab_interface::seeds
// ---------------------------------------------------------------------------

const enc = (s: string) => Buffer.from(s, "utf8");

export const SEEDS = {
  registry: enc("registry"),
  card: enc("card"),
  vault: enc("vault"),
  fractionMint: enc("fraction_mint"),
  nftEscrow: enc("nft_escrow"),
  oracle: enc("oracle"),
  pool: enc("pool"),
  clpMint: enc("clp_mint"),
  usdcVault: enc("usdc_vault"),
  cardSleeve: enc("card_sleeve"),
  market: enc("market"),
  position: enc("position"),
} as const;

// ---------------------------------------------------------------------------
// PDA derivation — the frontend never has to call a program to learn where
// an account lives
// ---------------------------------------------------------------------------

const pda = (seeds: Buffer[], programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

export const findRegistry = () => pda([SEEDS.registry], PROGRAM_IDS.cardVault);

export const findCard = (nftMint: PublicKey) =>
  pda([SEEDS.card, nftMint.toBuffer()], PROGRAM_IDS.cardVault);

export const findVaultedCard = (nftMint: PublicKey) =>
  pda([SEEDS.vault, nftMint.toBuffer()], PROGRAM_IDS.cardVault);

export const findFractionMint = (nftMint: PublicKey) =>
  pda([SEEDS.fractionMint, nftMint.toBuffer()], PROGRAM_IDS.cardVault);

export const findNftEscrow = (nftMint: PublicKey) =>
  pda([SEEDS.nftEscrow, nftMint.toBuffer()], PROGRAM_IDS.cardVault);

export const findOracle = (basket: PublicKey) =>
  pda([SEEDS.oracle, basket.toBuffer()], PROGRAM_IDS.oracle);

export const findPool = (usdcMint: PublicKey) =>
  pda([SEEDS.pool, usdcMint.toBuffer()], PROGRAM_IDS.clpPool);

export const findMarket = (pool: PublicKey) =>
  pda([SEEDS.market, pool.toBuffer()], PROGRAM_IDS.perp);

export const findPosition = (market: PublicKey, owner: PublicKey, nonce: bigint) => {
  const n = Buffer.alloc(8);
  n.writeBigUInt64LE(nonce);
  return pda([SEEDS.position, market.toBuffer(), owner.toBuffer(), n], PROGRAM_IDS.perp);
};

// ---------------------------------------------------------------------------
// states and enums — must match the Rust
// ---------------------------------------------------------------------------

export type MarketState = "active" | "reduceOnly" | "settled";
export type OracleState =
  | "ok"
  | "stale"
  | "shallowDepth"
  | "diverged"
  | "uninitialized"
  /** The clamp is holding the price behind the TWAP: positions close, nothing opens. */
  | "catchingUp";
export type Side = "long" | "short";
export type AmmAdapterKind = "mock" | "meteora" | "orca" | "raydium";

/**
 * Mirrors `MarketState::allows_*` from Rust. Used to enable controls.
 *
 * Close and liquidate are allowed in EVERY state, settled included. A settled
 * market still has to unwind: margin that cannot be released is margin stranded
 * forever, and LPs carrying it are haircut permanently. A UI that greys out
 * Close here would trap exactly the people who most need it.
 *
 * Kept honest by `gates_match_the_rust` in tests/parity.test.mjs.
 */
export const gates = (s: MarketState) => ({
  canOpen: s === "active",
  canClose: true,
  canLiquidate: true,
  canDeposit: s === "active",
  canWithdraw: s === "active",
});

/** Only `ok` allows a position to be opened. */
export const oracleTradeable = (s: OracleState) => s === "ok";

// ---------------------------------------------------------------------------
// account shapes the frontend reads — FROZEN
// ---------------------------------------------------------------------------

export interface PoolParams {
  cardSleeveTarget: bigint;
  phi: bigint;
  deltaMax: bigint;
  mu: bigint;
  deltaLiq: bigint;
  baseLeverage: bigint;
  maintenanceMargin: bigint;
  r0: bigint;
  r1: bigint;
  psi: bigint;
  openCloseFeeBps: number;
  liquidatorFeeBps: number;
  depositHaircutBps: number;
  maxCardWeight: bigint;
  lpFeeShareBps: number;
  reduceOnlyUtilization: bigint;
  /**
   * How many times attacking must cost what it pays, at the depth ceiling. WAD.
   *
   * Without it `cap = cost / mu` means `cap * mu == cost` exactly, so an attack
   * breaks even at the ceiling and rounding decides whether it pays. Default 2.0.
   */
  attackSafety: bigint;
}

export interface PoolView {
  address: PublicKey;
  usdcSleeve: bigint;
  cardSleeveValue: bigint;
  clpSupply: bigint;
  traderPnl: bigint;
  badDebt: bigint;
  accruedFeesLp: bigint;
  accruedFeesProtocol: bigint;
  params: PoolParams;
  state: MarketState;
}

export interface OracleView {
  address: PublicKey;
  price: bigint;
  twap: bigint;
  spot: bigint;
  depthUsdc: bigint;
  lastUpdateTs: bigint;
  externalMedian: bigint;
  state: OracleState;
}

export interface MarketView {
  address: PublicKey;
  oiLong: bigint;
  oiShort: bigint;
  borrowIdxLong: bigint;
  borrowIdxShort: bigint;
  lastAccrualTs: bigint;
  openPositions: number;
}

export interface PositionView {
  address: PublicKey;
  owner: PublicKey;
  side: Side;
  notional: bigint;
  margin: bigint;
  entryPrice: bigint;
  borrowIdxEntry: bigint;
  openedTs: bigint;
  /** Derived by the SDK — these are not stored on the account. */
  pnl: bigint;
  borrowOwed: bigint;
  equity: bigint;
  healthWad: bigint;
  liquidationPrice: bigint;
}

export interface CardView {
  nftMint: PublicKey;
  fractionMint: PublicKey;
  fractionsPerCard: bigint;
  weightBps: number;
  enabled: boolean;
  locked: boolean;
}
