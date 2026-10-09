import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { WAD } from "@kadex/types";
import {
  divergenceWad,
  readExternalMedian,
  readOraclePrice,
  setExternalMedianIx,
} from "@kadex/collector-crypt/chain";

interface Config {
  rpcUrl: string;
  keypairPath: string;
  oracle: PublicKey;
  intervalMs: number;
  minSamples: number;
  publish: boolean;
}

function loadConfig(): Config {
  const need = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`missing env ${k}`);
    return v;
  };
  return {
    rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8899",
    keypairPath: need("FEED_KEYPAIR").replace(/^~/, process.env.HOME ?? "~"),
    oracle: new PublicKey(need("ORACLE")),
    intervalMs: Number(process.env.INTERVAL_MS ?? 60_000),
    minSamples: Number(process.env.MIN_SAMPLES ?? 3),
    publish: process.env.PUBLISH === "1",
  };
}

const fmt = (wad: bigint) => (Number(wad) / Number(WAD)).toFixed(4);

async function tick(conn: Connection, cfg: Config, signer: Keypair): Promise<void> {
  const reading = await readExternalMedian(conn, cfg.minSamples);
  for (const u of reading.unpriced) console.log(`[feed] skipped  ${u.asset}  ${u.reason}`);

  if (reading.median === null) {
    console.log(`[feed] ${reading.samples.length} priced cards, need ${cfg.minSamples}: nothing to publish`);
    return;
  }

  const price = await readOraclePrice(conn, cfg.oracle);
  console.log(
    `[feed] median ${fmt(reading.median)} over ${reading.samples.length} cards  ` +
      `oracle ${fmt(price)}  divergence ${fmt(divergenceWad(price, reading.median))}`,
  );

  if (!cfg.publish) {
    console.log("[feed] dry run: set PUBLISH=1 to send it");
    return;
  }
  const tx = new Transaction().add(setExternalMedianIx(signer.publicKey, cfg.oracle, reading.median));
  const sig = await sendAndConfirmTransaction(conn, tx, [signer], { commitment: "confirmed" });
  console.log(`[feed] published  sig=${sig}`);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(cfg.keypairPath, "utf8")) as number[]));

  console.log(`[feed] rpc      ${cfg.rpcUrl}`);
  console.log(`[feed] oracle   ${cfg.oracle.toBase58()}`);
  console.log(`[feed] admin    ${signer.publicKey.toBase58()}`);
  console.log(`[feed] mode     ${cfg.publish ? "PUBLISH" : "dry run"}, every ${cfg.intervalMs}ms`);

  for (;;) {
    try {
      await tick(conn, cfg, signer);
    } catch (err) {
      console.error("[feed] tick failed:", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, cfg.intervalMs));
  }
}

main().catch((err) => {
  console.error("[feed] fatal:", err);
  process.exit(1);
});
