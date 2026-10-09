import { createHash } from "node:crypto";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { PROGRAM_IDS, WAD } from "@kadex/types";
import {
  fetchCard,
  impliedFractionPrice,
  medianWad,
  type ClientOptions,
  type CollectorCard,
} from "./index.js";

const discriminator = (preimage: string): Buffer =>
  createHash("sha256").update(preimage).digest().subarray(0, 8);

const CARD_SIZE = 8 + 32 + 32 + 8 + 2 + 1 + 1 + 1;
const CARD_FRACTIONS_OFFSET = 8 + 32 + 32;
const CARD_ENABLED_OFFSET = CARD_FRACTIONS_OFFSET + 8 + 2;
const CARD_CORE_OFFSET = CARD_ENABLED_OFFSET + 1;
const ORACLE_PRICE_OFFSET = 8 + 32 + 32 + 1 + 32;

export interface WhitelistedCoreCard {
  asset: PublicKey;
  fractionsPerCard: bigint;
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
  median: bigint | null;
  samples: { asset: string; price: bigint }[];
  unpriced: { asset: string; reason: string }[];
}

export function externalMedianFrom(cards: CollectorCard[], minSamples: number): ExternalMedianReading {
  const samples: ExternalMedianReading["samples"] = [];
  const unpriced: ExternalMedianReading["unpriced"] = [];
  for (const card of cards) {
    const price = impliedFractionPrice(card);
    if (price === null || price <= 0n) unpriced.push({ asset: card.nftAddress, reason: "no active USDC listing" });
    else samples.push({ asset: card.nftAddress, price });
  }
  const median = samples.length >= minSamples ? medianWad(samples.map((s) => s.price)) : null;
  return { median, samples, unpriced };
}

export async function readExternalMedian(
  conn: Connection,
  minSamples: number,
  opts: ClientOptions = {},
): Promise<ExternalMedianReading> {
  const whitelisted = (await whitelistedCoreCards(conn)).filter((c) => c.enabled);
  const cards: CollectorCard[] = [];
  const failed: ExternalMedianReading["unpriced"] = [];
  for (const { asset } of whitelisted) {
    try {
      cards.push(await fetchCard(asset.toBase58(), opts));
    } catch (e) {
      failed.push({ asset: asset.toBase58(), reason: e instanceof Error ? e.message : String(e) });
    }
  }
  const reading = externalMedianFrom(cards, minSamples);
  return { ...reading, unpriced: [...reading.unpriced, ...failed] };
}
