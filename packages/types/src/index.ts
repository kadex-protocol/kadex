/**
 * @slab/types — CONTRATO COM O FRONTEND.
 *
 * Espelha em TypeScript exatamente o que `packages/slab-interface` congela em
 * Rust: seeds de PDA, escalas, parametros e estados.
 *
 * Se algo aqui divergir do Rust, o frontend deriva enderecos errados e nada
 * funciona. Os testes em `index.test.ts` existem para pegar essa divergencia.
 */

import { PublicKey } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// program ids — CONGELADO (batem com Anchor.toml e keys/)
// ---------------------------------------------------------------------------

export const PROGRAM_IDS = {
  cardVault: new PublicKey("J8Tef8N4YSfVwAxpBemCZrz3qCxehTeb2cd1jTwoBczW"),
  oracle: new PublicKey("5288ShBXsFxqXiGm22FZi1ZrMnmet4i1ZR3bccyAguqp"),
  clpPool: new PublicKey("3XZkAqLeQDoNXD6Bb9YoGSEdnvqk9r7UMgrKsN5x3L9v"),
  perp: new PublicKey("BcVwJ91Jd1k7xUNcGYzRygq2ubaCYn7p5MeUZzy1EyLR"),
} as const;

// ---------------------------------------------------------------------------
// escalas — tem que bater com packages/slab-math/src/lib.rs
// ---------------------------------------------------------------------------

/** Razoes, precos e parametros. 1.0 === WAD. */
export const WAD = 1_000_000n;
/** Basis points. 100% === BPS. */
export const BPS = 10_000n;
/** Indice de borrow acumulado. */
export const RAY = 1_000_000_000_000n;
/** USDC e as fracoes de card usam 6 casas. */
export const TOKEN_DECIMALS = 6;

/** Converte um valor em WAD para numero legivel. So para exibicao. */
export const fromWad = (x: bigint): number => Number(x) / Number(WAD);
/** Converte USDC nativo para dolares. So para exibicao. */
export const fromUsdc = (x: bigint): number => Number(x) / 10 ** TOKEN_DECIMALS;
/** Dolares para USDC nativo. Trunca, nunca arredonda para cima. */
export const toUsdc = (x: number): bigint => BigInt(Math.trunc(x * 10 ** TOKEN_DECIMALS));

// ---------------------------------------------------------------------------
// seeds — tem que bater com slab_interface::seeds
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
// derivacao de PDA — o frontend nao precisa chamar o programa para saber
// onde as contas estao
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
// estados e enums — tem que bater com o Rust
// ---------------------------------------------------------------------------

export type MarketState = "active" | "reduceOnly" | "settled";
export type OracleState = "ok" | "stale" | "shallowDepth" | "diverged" | "uninitialized";
export type Side = "long" | "short";
export type AmmAdapterKind = "mock" | "meteora" | "orca" | "raydium";

/** Espelha `MarketState::allows_*` do Rust. Usado para habilitar botoes. */
export const gates = (s: MarketState) => ({
  canOpen: s === "active",
  canClose: s === "active" || s === "reduceOnly",
  canLiquidate: s === "active" || s === "reduceOnly",
  canDeposit: s === "active",
  canWithdraw: s === "active",
});

/** So `ok` libera abertura de posicao. */
export const oracleTradeable = (s: OracleState) => s === "ok";

// ---------------------------------------------------------------------------
// formas de conta que o frontend le — CONGELADO
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
  /** Derivados, calculados pelo SDK — nao vem da conta. */
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
