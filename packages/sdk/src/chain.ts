import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import type { MarketState, MarketView, OracleState, OracleView, PoolParams, PoolView, Side } from "@kadex/types";
import { PROGRAM_IDS, findPosition } from "@kadex/types";
import * as m from "./math.js";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export const DISCRIMINATORS = {
  pool: [241, 154, 109, 4, 17, 177, 109, 188],
  oracle: [189, 23, 49, 197, 79, 96, 245, 91],
  market: [219, 190, 213, 55, 0, 227, 198, 154],
  depositUsdc: [184, 148, 250, 169, 224, 213, 34, 126],
  depositFractions: [109, 37, 63, 9, 185, 2, 61, 60],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
  refreshPrice: [253, 61, 142, 248, 9, 32, 158, 32],
  position: [170, 188, 143, 228, 122, 64, 247, 208],
  openPosition: [135, 128, 47, 77, 15, 152, 240, 49],
  closePosition: [123, 134, 81, 0, 49, 68, 98, 98],
} as const;

export const POOL_SIZE = 482;
export const ORACLE_SIZE = 1265;
export const MARKET_SIZE = 165;
export const POSITION_SIZE = 130;
export const POSITION_OWNER_OFFSET = 8;
const TOKEN_AMOUNT_OFFSET = 64;

const MARKET_STATES: MarketState[] = ["active", "reduceOnly", "settled"];
const ORACLE_STATES: OracleState[] = ["ok", "stale", "shallowDepth", "diverged", "uninitialized", "catchingUp"];

class Reader {
  private offset = 8;
  private readonly view: DataView;

  constructor(private readonly data: Uint8Array, name: string, size: number, discriminator: readonly number[]) {
    if (data.length !== size) {
      throw new Error(`${name} account is ${data.length} bytes, expected ${size}: the on-chain layout changed`);
    }
    if (discriminator.some((byte, i) => data[i] !== byte)) throw new Error(`not a ${name} account`);
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  key() {
    const bytes = this.data.subarray(this.offset, this.offset + 32);
    this.offset += 32;
    return new PublicKey(bytes);
  }
  u8() {
    return this.view.getUint8(this.offset++);
  }
  u16() {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }
  u32() {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  u64() {
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }
  i64() {
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }
  u128() {
    return this.u64() + (this.u64() << 64n);
  }
  skip(bytes: number) {
    this.offset += bytes;
  }
}

export interface Book {
  oiLong: bigint;
  oiShort: bigint;
  unitsLong: bigint;
  unitsShort: bigint;
}

export interface PoolAccount {
  admin: PublicKey;
  usdcMint: PublicKey;
  clpMint: PublicKey;
  usdcVault: PublicKey;
  fractionMint: PublicKey;
  fractionVault: PublicKey;
  oracle: PublicKey;
  perpMarket: PublicKey;
  usdcSleeve: bigint;
  fractionBalance: bigint;
  clpSupply: bigint;
  book: Book;
  badDebt: bigint;
  marginHeld: bigint;
  accruedFeesLp: bigint;
  accruedFeesProtocol: bigint;
  params: PoolParams;
  state: MarketState;
}

export interface OracleAccount {
  basket: PublicKey;
  ammPool: PublicKey;
  price: bigint;
  twap: bigint;
  spot: bigint;
  slowTwap: bigint;
  depthUsdc: bigint;
  lastUpdateTs: bigint;
  externalMedian: bigint;
  maxStalenessSecs: number;
  state: OracleState;
}

export interface MarketAccount {
  pool: PublicKey;
  oracle: PublicKey;
  oiLong: bigint;
  oiShort: bigint;
  borrowIdxLong: bigint;
  borrowIdxShort: bigint;
  lastAccrualTs: bigint;
  openPositions: number;
}

function enumAt<T>(names: T[], index: number, what: string): T {
  const name = names[index];
  if (name === undefined) throw new Error(`unknown ${what} variant ${index}`);
  return name;
}

export function decodePool(data: Uint8Array): PoolAccount {
  const r = new Reader(data, "Pool", POOL_SIZE, DISCRIMINATORS.pool);
  return {
    admin: r.key(),
    usdcMint: r.key(),
    clpMint: r.key(),
    usdcVault: r.key(),
    fractionMint: r.key(),
    fractionVault: r.key(),
    oracle: r.key(),
    perpMarket: r.key(),
    usdcSleeve: r.u64(),
    fractionBalance: r.u64(),
    clpSupply: r.u64(),
    book: { oiLong: r.u64(), oiShort: r.u64(), unitsLong: r.u128(), unitsShort: r.u128() },
    badDebt: r.u64(),
    marginHeld: r.u64(),
    accruedFeesLp: r.u64(),
    accruedFeesProtocol: r.u64(),
    params: {
      cardSleeveTarget: r.u64(),
      phi: r.u64(),
      deltaMax: r.u64(),
      mu: r.u64(),
      deltaLiq: r.u64(),
      baseLeverage: r.u64(),
      maintenanceMargin: r.u64(),
      r0: r.u64(),
      r1: r.u64(),
      psi: r.u64(),
      openCloseFeeBps: r.u16(),
      liquidatorFeeBps: r.u16(),
      depositHaircutBps: r.u16(),
      maxCardWeight: r.u64(),
      lpFeeShareBps: r.u16(),
      reduceOnlyUtilization: r.u64(),
      attackSafety: r.u64(),
    },
    state: enumAt(MARKET_STATES, r.u8(), "MarketState"),
  };
}

export function decodeOracle(data: Uint8Array): OracleAccount {
  const r = new Reader(data, "OracleAccount", ORACLE_SIZE, DISCRIMINATORS.oracle);
  const basket = r.key();
  const ammPool = r.key();
  r.skip(1 + 32);
  const price = r.u64();
  const twap = r.u64();
  const spot = r.u64();
  r.skip(16);
  const slowTwap = r.u64();
  const depthUsdc = r.u64();
  const lastUpdateTs = r.i64();
  r.skip(8);
  const externalMedian = r.u64();
  r.skip(8 + 4 + 8);
  const maxStalenessSecs = r.u32();
  r.skip(8 + 8 + 8 + 4);
  const state = enumAt(ORACLE_STATES, r.u8(), "OracleState");
  return { basket, ammPool, price, twap, spot, slowTwap, depthUsdc, lastUpdateTs, externalMedian, maxStalenessSecs, state };
}

export function decodeMarket(data: Uint8Array): MarketAccount {
  const r = new Reader(data, "Market", MARKET_SIZE, DISCRIMINATORS.market);
  const pool = r.key();
  const oracle = r.key();
  const oiLong = r.u64();
  const oiShort = r.u64();
  r.skip(32);
  return {
    pool,
    oracle,
    oiLong,
    oiShort,
    borrowIdxLong: r.u128(),
    borrowIdxShort: r.u128(),
    lastAccrualTs: r.i64(),
    openPositions: r.u32(),
  };
}

export interface PositionAccount {
  owner: PublicKey;
  market: PublicKey;
  side: Side;
  notional: bigint;
  margin: bigint;
  entryPrice: bigint;
  borrowIdxEntry: bigint;
  openedTs: bigint;
  nonce: bigint;
}

export function decodePosition(data: Uint8Array): PositionAccount {
  const r = new Reader(data, "Position", POSITION_SIZE, DISCRIMINATORS.position);
  return {
    owner: r.key(),
    market: r.key(),
    side: enumAt<Side>(["long", "short"], r.u8(), "Side"),
    notional: r.u64(),
    margin: r.u64(),
    entryPrice: r.u64(),
    borrowIdxEntry: r.u128(),
    openedTs: r.i64(),
    nonce: r.u64(),
  };
}

export function decodeTokenAmount(data: Uint8Array): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(TOKEN_AMOUNT_OFFSET, true);
}

export interface Marks {
  trade: bigint;
  low: bigint;
  high: bigint;
}

export function marksOf(oracle: Pick<OracleAccount, "price" | "slowTwap">): Marks {
  const { price, slowTwap } = oracle;
  return {
    trade: price,
    low: slowTwap === 0n || price < slowTwap ? price : slowTwap,
    high: price > slowTwap ? price : slowTwap,
  };
}

export const oracleIsFresh = (oracle: Pick<OracleAccount, "lastUpdateTs" | "maxStalenessSecs">, now: bigint) =>
  oracle.lastUpdateTs > 0n && now - oracle.lastUpdateTs <= BigInt(oracle.maxStalenessSecs);

export function bookPnl(book: Book, price: bigint): bigint {
  return m.mulWadFloor(book.unitsLong, price) - book.oiLong + (book.oiShort - m.mulWadFloor(book.unitsShort, price));
}

export function poolView(address: PublicKey, pool: PoolAccount, marks: Marks): PoolView {
  return {
    address,
    usdcSleeve: pool.usdcSleeve,
    cardSleeveValue: m.mulWadFloor(pool.fractionBalance, marks.low),
    clpSupply: pool.clpSupply,
    traderPnl: bookPnl(pool.book, marks.trade),
    badDebt: pool.badDebt,
    marginHeld: pool.marginHeld,
    accruedFeesLp: pool.accruedFeesLp,
    accruedFeesProtocol: pool.accruedFeesProtocol,
    params: pool.params,
    state: pool.state,
  };
}

export function navIssue(pool: PoolAccount, marks: Marks): bigint {
  return m.nav(pool.usdcSleeve, m.mulWadFloor(pool.fractionBalance, marks.high), bookPnl(pool.book, marks.trade), 0n);
}

export function oracleView(address: PublicKey, oracle: OracleAccount, now: bigint): OracleView {
  return {
    address,
    price: oracle.price,
    twap: oracle.twap,
    spot: oracle.spot,
    depthUsdc: oracle.depthUsdc,
    lastUpdateTs: oracle.lastUpdateTs,
    externalMedian: oracle.externalMedian,
    state: oracle.state === "ok" && !oracleIsFresh(oracle, now) ? "stale" : oracle.state,
  };
}

export function marketView(address: PublicKey, market: MarketAccount): MarketView {
  return {
    address,
    oiLong: market.oiLong,
    oiShort: market.oiShort,
    borrowIdxLong: market.borrowIdxLong,
    borrowIdxShort: market.borrowIdxShort,
    lastAccrualTs: market.lastAccrualTs,
    openPositions: market.openPositions,
  };
}

export const findAta = (owner: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];

const writable = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
const readonly = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
const signer = (pubkey: PublicKey, isWritable: boolean) => ({ pubkey, isSigner: true, isWritable });

function amountData(discriminator: readonly number[], amount: bigint): Buffer {
  const data = new Uint8Array(16);
  data.set(discriminator, 0);
  new DataView(data.buffer).setBigUint64(8, amount, true);
  return Buffer.from(data);
}

export function createAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      signer(payer, true),
      writable(findAta(owner, mint)),
      readonly(owner),
      readonly(mint),
      readonly(SystemProgram.programId),
      readonly(TOKEN_PROGRAM_ID),
    ],
    data: Buffer.from([1]),
  });
}

export function refreshPriceIx(caller: PublicKey, oracle: PublicKey, ammPool: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_IDS.oracle,
    keys: [signer(caller, false), writable(oracle), readonly(ammPool)],
    data: Buffer.from(DISCRIMINATORS.refreshPrice),
  });
}

export interface PoolAccounts {
  address: PublicKey;
  pool: Pick<PoolAccount, "oracle" | "clpMint" | "usdcVault" | "fractionVault">;
}

export function depositUsdcIx(
  { address, pool }: PoolAccounts,
  depositor: PublicKey,
  accounts: { usdc: PublicKey; clp: PublicKey },
  amount: bigint,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_IDS.clpPool,
    keys: [
      signer(depositor, true),
      writable(address),
      readonly(pool.oracle),
      writable(pool.clpMint),
      writable(pool.usdcVault),
      writable(accounts.usdc),
      writable(accounts.clp),
      readonly(TOKEN_PROGRAM_ID),
    ],
    data: amountData(DISCRIMINATORS.depositUsdc, amount),
  });
}

export function depositFractionsIx(
  { address, pool }: PoolAccounts,
  depositor: PublicKey,
  accounts: { fractions: PublicKey; clp: PublicKey },
  amount: bigint,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_IDS.clpPool,
    keys: [
      signer(depositor, true),
      writable(address),
      readonly(pool.oracle),
      writable(pool.clpMint),
      writable(pool.fractionVault),
      writable(accounts.fractions),
      writable(accounts.clp),
      readonly(TOKEN_PROGRAM_ID),
    ],
    data: amountData(DISCRIMINATORS.depositFractions, amount),
  });
}

export function withdrawIx(
  { address, pool }: PoolAccounts,
  owner: PublicKey,
  accounts: { clp: PublicKey; usdc: PublicKey; fractions: PublicKey },
  shares: bigint,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_IDS.clpPool,
    keys: [
      signer(owner, true),
      writable(address),
      readonly(pool.oracle),
      writable(pool.clpMint),
      writable(pool.usdcVault),
      writable(pool.fractionVault),
      writable(accounts.clp),
      writable(accounts.usdc),
      writable(accounts.fractions),
      readonly(TOKEN_PROGRAM_ID),
    ],
    data: amountData(DISCRIMINATORS.withdraw, shares),
  });
}

export interface MarketAccounts {
  market: PublicKey;
  pool: PublicKey;
  oracle: PublicKey;
  usdcVault: PublicKey;
}

export function openPositionIx(
  accounts: MarketAccounts,
  trader: PublicKey,
  traderUsdc: PublicKey,
  order: { nonce: bigint; side: Side; notional: bigint; margin: bigint },
): TransactionInstruction {
  const data = new Uint8Array(33);
  const view = new DataView(data.buffer);
  data.set(DISCRIMINATORS.openPosition, 0);
  view.setBigUint64(8, order.nonce, true);
  view.setUint8(16, order.side === "long" ? 0 : 1);
  view.setBigUint64(17, order.notional, true);
  view.setBigUint64(25, order.margin, true);
  return new TransactionInstruction({
    programId: PROGRAM_IDS.perp,
    keys: [
      signer(trader, true),
      writable(accounts.market),
      writable(accounts.pool),
      readonly(accounts.oracle),
      writable(findPosition(accounts.market, trader, order.nonce)),
      writable(traderUsdc),
      writable(accounts.usdcVault),
      readonly(PROGRAM_IDS.clpPool),
      readonly(TOKEN_PROGRAM_ID),
      readonly(SystemProgram.programId),
    ],
    data: Buffer.from(data),
  });
}

export function closePositionIx(
  accounts: MarketAccounts,
  owner: PublicKey,
  position: PublicKey,
  payoutUsdc: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_IDS.perp,
    keys: [
      signer(owner, true),
      writable(accounts.market),
      writable(accounts.pool),
      readonly(accounts.oracle),
      writable(position),
      writable(accounts.usdcVault),
      writable(payoutUsdc),
      readonly(PROGRAM_IDS.clpPool),
      readonly(TOKEN_PROGRAM_ID),
    ],
    data: Buffer.from(DISCRIMINATORS.closePosition),
  });
}
