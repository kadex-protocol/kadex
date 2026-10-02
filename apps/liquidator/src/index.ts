/**
 * SLAB reference liquidator — OWNER: Backend B.
 *
 * Scans open positions and liquidates the ones below maintenance margin.
 *
 * # Why this is in the repository
 *
 * Liquidation does not happen by itself. `liquidate` is an instruction, and an
 * instruction nobody calls is a rule nobody enforces. A protocol that ships
 * the instruction without shipping an actor has not shipped liquidation — it
 * has shipped the hope that somebody else writes this file.
 *
 * It is also why the maintenance margin is 6.25% rather than zero: there has
 * to be something left to pay whoever sends the transaction.
 *
 * # Economics
 *
 * The reward is 1% of notional. On a $3,200 position that is $32, against a
 * Solana fee of roughly $0.0001. The margin is enormous, which is the point:
 * it has to stay profitable for a bot that loses most races.
 *
 * Run:
 *   LIQUIDATOR_KEYPAIR=~/.config/solana/id.json \
 *   RPC_URL=https://api.devnet.solana.com \
 *   MARKET=<market pda> npx tsx apps/liquidator/src/index.ts
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { PROGRAM_IDS, WAD } from "@slab/types";
import * as math from "@slab/sdk/math";

/** Anchor account discriminator: first 8 bytes of sha256("account:<Name>"). */
function accountDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

/**
 * `Position` layout, in declaration order. Anchor lays an `#[account]` out as
 * the 8-byte discriminator followed by each field, little-endian, no padding.
 *
 * Decoded by hand rather than through the IDL coder so the bot has no
 * dependency on a file that has to be copied around. If `Position` gains a
 * field, `POSITION_SIZE` stops matching and this throws rather than silently
 * reading garbage.
 */
const POSITION_SIZE =
  8 + // discriminator
  32 + // owner
  32 + // market
  1 + // side (enum)
  8 + // notional
  8 + // margin
  8 + // entry_price
  16 + // borrow_idx_entry (u128)
  8 + // opened_ts (i64)
  8 + // nonce
  1; // bump

interface Position {
  address: PublicKey;
  owner: PublicKey;
  market: PublicKey;
  side: "long" | "short";
  notional: bigint;
  margin: bigint;
  entryPrice: bigint;
  borrowIdxEntry: bigint;
}

function decodePosition(address: PublicKey, data: Buffer): Position {
  if (data.length !== POSITION_SIZE) {
    throw new Error(
      `Position account is ${data.length} bytes, expected ${POSITION_SIZE}. ` +
        "The on-chain layout changed; update this decoder before trusting it.",
    );
  }
  let o = 8;
  const take = (n: number): Buffer => data.subarray(o, (o += n));
  const u64 = (): bigint => {
    const v = data.readBigUInt64LE(o);
    o += 8;
    return v;
  };

  const owner = new PublicKey(take(32));
  const market = new PublicKey(take(32));
  const side = take(1).readUInt8(0) === 0 ? "long" : "short";
  const notional = u64();
  const margin = u64();
  const entryPrice = u64();
  // u128, little-endian: low half then high half
  const borrowIdxEntry = u64() + (u64() << 64n);

  return { address, owner, market, side, notional, margin, entryPrice, borrowIdxEntry };
}

async function fetchPositions(conn: Connection, market: PublicKey): Promise<Position[]> {
  const accounts = await conn.getProgramAccounts(PROGRAM_IDS.perp, {
    filters: [
      { memcmp: { offset: 0, bytes: accountDiscriminator("Position").toString("base64"), encoding: "base64" } },
      { memcmp: { offset: 8 + 32, bytes: market.toBase58() } },
    ],
  });
  return accounts.map(({ pubkey, account }) => decodePosition(pubkey, account.data as Buffer));
}

interface MarketState {
  price: bigint;
  borrowIdxLong: bigint;
  borrowIdxShort: bigint;
  maintenanceMargin: bigint;
}

/**
 * Decide whether a position is liquidatable, using exactly the arithmetic the
 * program uses. If this diverges, the bot wastes gas on transactions the
 * program refuses, or worse, skips positions that should be closed.
 */
function isLiquidatable(p: Position, m: MarketState): boolean {
  const idx = p.side === "long" ? m.borrowIdxLong : m.borrowIdxShort;
  const owed = math.borrowOwed(p.notional, p.borrowIdxEntry, idx);
  const pnl = math.pnl(p.side, p.entryPrice, m.price, p.notional);
  const equity = math.equity(p.margin, pnl, owed);
  return math.healthWad(equity, p.notional) < m.maintenanceMargin;
}

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path.replace(/^~/, process.env.HOME ?? "~"), "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8899";
  const marketStr = process.env.MARKET;
  const keypairPath = process.env.LIQUIDATOR_KEYPAIR;
  if (!marketStr || !keypairPath) {
    throw new Error("set MARKET and LIQUIDATOR_KEYPAIR");
  }

  const conn = new Connection(rpcUrl, "confirmed");
  const market = new PublicKey(marketStr);
  const signer = loadKeypair(keypairPath);
  const intervalMs = Number(process.env.INTERVAL_MS ?? 5_000);

  console.log(`[liquidator] rpc    ${rpcUrl}`);
  console.log(`[liquidator] market ${market.toBase58()}`);
  console.log(`[liquidator] caller ${signer.publicKey.toBase58()}`);

  for (;;) {
    try {
      const positions = await fetchPositions(conn, market);

      // TODO(D10): read Market and Pool to fill these in. Until then the bot
      // reports what it sees and liquidates nothing, which is the honest
      // failure mode — a bot that guesses the price would send transactions
      // the program rejects, or miss ones it should send.
      const state: MarketState | null = null;

      if (state === null) {
        console.log(
          `[liquidator] ${positions.length} open position(s); ` +
            "market/pool decoding not wired yet, so nothing was evaluated",
        );
      } else {
        const doomed = positions.filter((p) => isLiquidatable(p, state));
        console.log(`[liquidator] ${positions.length} open, ${doomed.length} liquidatable`);
        for (const p of doomed) {
          console.log(
            `[liquidator] would liquidate ${p.address.toBase58()} ` +
              `(${p.side} ${Number(p.notional) / Number(WAD)})`,
          );
        }
      }
    } catch (err) {
      console.error("[liquidator] scan failed:", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

main().catch((err) => {
  console.error("[liquidator] fatal:", err);
  process.exit(1);
});
