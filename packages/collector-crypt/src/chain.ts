import { createHash } from "node:crypto";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { PROGRAM_IDS, WAD } from "@kadex/types";
import {
  fetchAppraisal,
  fetchListing,
  impliedFractionPrice,
  mapLimited,
  medianWad,
  weightedMedianWad,
  type ClientOptions,
  type CollectorCard,
} from "./index.js";

const discriminator = (preimage: string): Buffer =>
  createHash("sha256").update(preimage).digest().subarray(0, 8);

const CARD_SIZE = 8 + 32 + 32 + 8 + 2 + 1 + 1 + 1;
const CARD_FRACTIONS_OFFSET = 8 + 32 + 32;
const CARD_WEIGHT_OFFSET = CARD_FRACTIONS_OFFSET + 8;
const CARD_ENABLED_OFFSET = CARD_WEIGHT_OFFSET + 2;
const CARD_CORE_OFFSET = CARD_ENABLED_OFFSET + 1;
const ORACLE_PRICE_OFFSET = 8 + 32 + 32 + 1 + 32;

export interface WhitelistedCoreCard {
  asset: PublicKey;
  fractionsPerCard: bigint;
  /** The card's share of the index, in basis points. */
  weightBps: number;
  enabled: boolean;
}

export async function whitelistedCoreCards(conn: Connection): Promise<WhitelistedCoreCard[]> {
  const accounts = await conn.getProgramAccounts(PROGRAM_IDS.cardVault, {
    filters: [
      { dataSize: CARD_SIZE },
      { memcmp: { offset: 0, bytes: discriminator("account:WhitelistedCard").toString("base64"), encoding: "base64" } },
      { memcmp: { offset: CARD_CORE_OFFSET, bytes: Buffer.from([1]).toString("base64"), encoding: "base64" } },
    ],
  });
  return accounts.map(({ account }) => {
    const data = account.data as Buffer;
    return {
      asset: new PublicKey(data.subarray(8, 40)),
      fractionsPerCard: data.readBigUInt64LE(CARD_FRACTIONS_OFFSET),
      weightBps: data.readUInt16LE(CARD_WEIGHT_OFFSET),
      enabled: data.readUInt8(CARD_ENABLED_OFFSET) === 1,
    };
  });
}

export async function readOraclePrice(conn: Connection, oracle: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(oracle);
  if (!info) throw new Error(`oracle ${oracle.toBase58()} does not exist`);
  if (!info.owner.equals(PROGRAM_IDS.oracle)) throw new Error(`${oracle.toBase58()} is not an oracle account`);
  return info.data.readBigUInt64LE(ORACLE_PRICE_OFFSET);
}

export function setExternalMedianIx(admin: PublicKey, oracle: PublicKey, median: bigint): TransactionInstruction {
  const arg = Buffer.alloc(8);
  arg.writeBigUInt64LE(median);
  return new TransactionInstruction({
    programId: PROGRAM_IDS.oracle,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: false },
      { pubkey: oracle, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([discriminator("global:set_external_median"), arg]),
  });
}

export const divergenceWad = (price: bigint, median: bigint): bigint =>
  ((price >= median ? price - median : median - price) * WAD) / median;

export interface ExternalMedianReading {
  /** Median implied fraction price over priced cards, every card counted once. */
  median: bigint | null;
  /** The same, each card counted by its index weight: what the feed publishes. */
  index: bigint | null;
  samples: { asset: string; price: bigint; weightBps: number }[];
  unpriced: { asset: string; reason: string }[];
}

/** `weights` maps an asset to its weight in bps; a card missing from it counts 1. */
export function externalMedianFrom(
  cards: CollectorCard[],
  minSamples: number,
  weights: ReadonlyMap<string, number> = new Map(),
): ExternalMedianReading {
  const samples: ExternalMedianReading["samples"] = [];
  const unpriced: ExternalMedianReading["unpriced"] = [];
  for (const card of cards) {
    const price = impliedFractionPrice(card);
    if (price === null || price <= 0n) unpriced.push({ asset: card.nftAddress, reason: "no active USDC listing" });
    else samples.push({ asset: card.nftAddress, price, weightBps: weights.get(card.nftAddress) ?? 1 });
  }
  const enough = samples.length >= minSamples;
  return {
    median: enough ? medianWad(samples.map((s) => s.price)) : null,
    index: enough ? weightedMedianWad(samples.map((s) => ({ price: s.price, weight: BigInt(s.weightBps) }))) : null,
    samples,
    unpriced,
  };
}

/**
 * Every enabled whitelisted card, priced from its listing: one request per
 * card, `concurrency` at a time. Pass `limits` in `opts` to stay inside the
 * provider's rate limit and reuse responses for 30 s.
 */
export async function readExternalMedian(
  conn: Connection,
  minSamples: number,
  opts: ClientOptions = {},
  concurrency = 8,
): Promise<ExternalMedianReading> {
  const whitelisted = (await whitelistedCoreCards(conn)).filter((c) => c.enabled);
  const failed: ExternalMedianReading["unpriced"] = [];
  const found = await mapLimited(whitelisted, concurrency, async ({ asset }) => {
    const address = asset.toBase58();
    try {
      const card = await fetchListing(address, opts);
      if (!card) failed.push({ asset: address, reason: "not listed on the marketplace" });
      return card;
    } catch (e) {
      failed.push({ asset: address, reason: e instanceof Error ? e.message : String(e) });
      return null;
    }
  });
  const weights = new Map(whitelisted.map((c) => [c.asset.toBase58(), c.weightBps]));
  const reading = externalMedianFrom(found.filter((c): c is CollectorCard => c !== null), minSamples, weights);
  return { ...reading, unpriced: [...reading.unpriced, ...failed] };
}

/**
 * What the feed publishes: each card's current Collector Crypt appraisal over
 * the appraisal it was whitelisted at (its `fractions_per_card`, one fraction
 * per dollar), as a price per fraction in WAD, weighted median by
 * `weight_bps`. 1.00 means the basket is appraised where it launched.
 *
 * Not asks: a vaulted card is owned by its vault PDA and cannot be listed,
 * so once the basket is deposited the asks median has no samples at all, and
 * before that asks sit a median 1.5x above appraisal market-wide (issue #11).
 */
export function appraisalIndexFrom(
  whitelisted: readonly WhitelistedCoreCard[],
  appraisals: ReadonlyMap<string, bigint>,
  minSamples: number,
): ExternalMedianReading {
  const samples: ExternalMedianReading["samples"] = [];
  const unpriced: ExternalMedianReading["unpriced"] = [];
  for (const c of whitelisted) {
    const asset = c.asset.toBase58();
    const now = appraisals.get(asset);
    if (now === undefined) unpriced.push({ asset, reason: "no appraisal" });
    else if (now <= 0n || c.fractionsPerCard <= 0n) unpriced.push({ asset, reason: "appraisal is zero" });
    else samples.push({ asset, price: (now * WAD) / c.fractionsPerCard, weightBps: c.weightBps });
  }
  const enough = samples.length >= minSamples;
  return {
    median: enough ? medianWad(samples.map((s) => s.price)) : null,
    index: enough ? weightedMedianWad(samples.map((s) => ({ price: s.price, weight: BigInt(s.weightBps) }))) : null,
    samples,
    unpriced,
  };
}

/** Every enabled whitelisted card's appraisal drift; one request per card. */
export async function readAppraisalIndex(
  conn: Connection,
  minSamples: number,
  opts: ClientOptions = {},
  concurrency = 8,
): Promise<ExternalMedianReading> {
  const whitelisted = (await whitelistedCoreCards(conn)).filter((c) => c.enabled);
  const appraisals = new Map<string, bigint>();
  const failed: ExternalMedianReading["unpriced"] = [];
  await mapLimited(whitelisted, concurrency, async ({ asset }) => {
    const address = asset.toBase58();
    try {
      appraisals.set(address, await fetchAppraisal(address, opts));
    } catch (e) {
      failed.push({ asset: address, reason: e instanceof Error ? e.message : String(e) });
    }
  });
  const reading = appraisalIndexFrom(whitelisted, appraisals, minSamples);
  return { ...reading, unpriced: [...reading.unpriced.filter((u) => !failed.some((f) => f.asset === u.asset)), ...failed] };
}
