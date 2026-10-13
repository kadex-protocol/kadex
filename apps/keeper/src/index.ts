/**
 * Kadex keeper — OWNER: Backend A.
 *
 * Calls `refresh_price` on a loop so the oracle stays fresh.
 *
 * This process is a convenience, not a dependency. `refresh_price` is
 * permissionless and recomputes everything from on-chain state, so if this
 * keeper dies anyone can keep the price alive and nothing is lost but
 * freshness. That is the whole reason the instruction has no privileged
 * signer: there is no key here worth stealing and no single process whose
 * death stops the market.
 *
 * # Liveness (issue #5)
 *
 * Permissionless means anyone CAN call it, not that anyone WILL. Run at least
 * two instances, on different machines, with different payers. They will
 * sometimes race and one will lose; a lost race costs a failed transaction
 * and nothing else, because `refresh_price` recomputes from scratch and is
 * idempotent within a slot.
 *
 * If every keeper stops, the oracle ages past `max_staleness_secs` and the
 * market goes ReduceOnly on its own. Positions can still be closed and
 * liquidated. The failure mode is "no new risk", not "funds stuck".
 *
 * What it deliberately does NOT do:
 *
 * - it does not compute a price. The program reads the AMM itself.
 * - it does not sign a price. There is no oracle signature in this design.
 * - it does not decide anything. If the oracle goes ShallowDepth or Diverged,
 *   that is the program's judgement and the keeper just reports it.
 *
 * Run:
 *   KEEPER_KEYPAIR=~/.config/solana/id.json \
 *   RPC_URL=https://api.devnet.solana.com \
 *   ORACLE=<oracle pda> AMM_POOL=<pool account> \
 *   npx tsx apps/keeper/src/index.ts
 */

import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { PROGRAM_IDS } from "@kadex/types";
import { decodeOracle, refreshAccountsFor } from "@kadex/sdk";
import { intFromEnv, loadKeypair, redactUrl } from "@kadex/sdk/node";

/**
 * Anchor's instruction discriminator: the first 8 bytes of
 * `sha256("global:<snake_case_name>")`.
 *
 * Computed rather than pasted. A wrong constant here does not fail loudly —
 * it produces a transaction the program rejects as an unknown instruction,
 * which looks like a dozen other problems.
 */
function discriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

const REFRESH_PRICE = discriminator("refresh_price");

interface Config {
  rpcUrl: string;
  oracle: PublicKey;
  ammPool: PublicKey;
  /** Accounts the adapter reads after the pool (Raydium: the two vaults). */
  extra: PublicKey[];
  intervalMs: number;
}

function loadConfig(): Config {
  const need = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`missing env ${k}`);
    return v;
  };
  return {
    rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8899",
    oracle: new PublicKey(need("ORACLE")),
    ammPool: new PublicKey(need("AMM_POOL")),
    extra: [],
    // 5s, and the binding reason is liquidation rather than staleness.
    //
    // Liquidation uses the CLAMPED oracle price, which moves at most 5% per
    // refresh. A 5x position liquidates after a 13.75% move, so the oracle
    // needs three refreshes to get there. At 30s that is 90 seconds during
    // which a position is underwater at spot but not yet liquidatable — and
    // that window is where bad debt comes from. At 5s it is 15 seconds.
    //
    // The 900s staleness bound is far looser than this, so it never binds.
    intervalMs: intFromEnv("INTERVAL_MS", 5_000, 500),
  };
}

function refreshPriceIx(cfg: Config, caller: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_IDS.oracle,
    keys: [
      { pubkey: caller, isSigner: true, isWritable: false },
      { pubkey: cfg.oracle, isSigner: false, isWritable: true },
      { pubkey: cfg.ammPool, isSigner: false, isWritable: false },
      ...cfg.extra.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    ],
    data: REFRESH_PRICE,
  });
}

async function tick(conn: Connection, cfg: Config, signer: Keypair): Promise<void> {
  const tx = new Transaction().add(refreshPriceIx(cfg, signer.publicKey));
  const sig = await sendAndConfirmTransaction(conn, tx, [signer], {
    commitment: "confirmed",
    skipPreflight: false,
  });
  console.log(`[keeper] refreshed  sig=${sig}`);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const signer = loadKeypair(process.env.KEEPER_KEYPAIR, "KEEPER_KEYPAIR");

  // The oracle says which AMM it reads; a real pool also needs its vaults.
  // Fail at start, not on every tick, if AMM_POOL is not the oracle's pool.
  const oracleInfo = await conn.getAccountInfo(cfg.oracle, "confirmed");
  if (!oracleInfo) throw new Error(`oracle ${cfg.oracle.toBase58()} does not exist on ${redactUrl(cfg.rpcUrl)}`);
  const oracle = decodeOracle(oracleInfo.data);
  if (!oracle.ammPool.equals(cfg.ammPool)) {
    throw new Error(`AMM_POOL ${cfg.ammPool.toBase58()} is not the oracle's pool ${oracle.ammPool.toBase58()}`);
  }
  cfg.extra = await refreshAccountsFor(conn, oracle);

  console.log(`[keeper] rpc      ${redactUrl(cfg.rpcUrl)}`);
  console.log(`[keeper] oracle   ${cfg.oracle.toBase58()}`);
  console.log(`[keeper] amm pool ${cfg.ammPool.toBase58()} (${oracle.adapter})`);
  for (const k of cfg.extra) console.log(`[keeper] + vault  ${k.toBase58()}`);
  console.log(`[keeper] caller   ${signer.publicKey.toBase58()}`);
  console.log(`[keeper] every    ${cfg.intervalMs}ms`);

  let consecutiveFailures = 0;

  for (;;) {
    try {
      await tick(conn, cfg, signer);
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      // A failing refresh is not an emergency: the oracle simply ages, and
      // the program refuses to open new risk once it goes stale. Log it
      // plainly and keep trying rather than exiting and leaving nobody
      // refreshing at all.
      console.error(
        `[keeper] refresh failed (${consecutiveFailures} in a row):`,
        err instanceof Error ? err.message : err,
      );
      if (consecutiveFailures === 10) {
        console.error(
          "[keeper] ten consecutive failures — the oracle will go stale and " +
            "the market will stop accepting new positions. Check the RPC, the " +
            "signer's balance, and that AMM_POOL matches the one the oracle " +
            "was bound to.",
        );
      }
    }
    await new Promise((r) => setTimeout(r, cfg.intervalMs));
  }
}

// web3.js keeps polling a signature after a confirmation gives up; without this one failed poll ends the process.
process.on("unhandledRejection", (reason) => {
  console.error(`[keeper] unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

main().catch((err) => {
  console.error(`[keeper] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
