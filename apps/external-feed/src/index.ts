import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { WAD } from "@kadex/types";
import { collectorCryptLimits } from "@kadex/collector-crypt";
import {
  divergenceWad,
  readAppraisalIndex,
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
  /** What is published: "appraisal" (default) or "asks". The other is logged only. */
  source: "appraisal" | "asks";
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
    minSamples: Number(process.env.MIN_SAMPLES ?? 5),
    source: process.env.SOURCE === "asks" ? "asks" : "appraisal",
    publish: process.env.PUBLISH === "1",
  };
}

const fmt = (wad: bigint) => (Number(wad) / Number(WAD)).toFixed(4);

async function tick(conn: Connection, cfg: Config, signer: Keypair): Promise<void> {
  const opts = { limits: collectorCryptLimits() };
  // Both are read every tick so their gap stays visible; only `source` is sent.
  const [appraisal, asks] = await Promise.all([
    readAppraisalIndex(conn, cfg.minSamples, opts),
    readExternalMedian(conn, cfg.minSamples, opts),
  ]);
  const reading = cfg.source === "asks" ? asks : appraisal;
  for (const u of reading.unpriced) console.log(`[feed] skipped  ${u.asset}  ${u.reason}`);
  console.log(
    `[feed] asks ${asks.index === null ? "n/a" : fmt(asks.index)} over ${asks.samples.length} listed  ` +
      `appraisal ${appraisal.index === null ? "n/a" : fmt(appraisal.index)} over ${appraisal.samples.length}`,
  );

  if (reading.index === null || reading.median === null) {
    console.log(`[feed] ${reading.samples.length} ${cfg.source} samples, need ${cfg.minSamples}: nothing to publish`);
    return;
  }

  const price = await readOraclePrice(conn, cfg.oracle);
  console.log(
    `[feed] ${cfg.source} index ${fmt(reading.index)} (weighted median; plain ${fmt(reading.median)}) over ${reading.samples.length} cards  ` +
      `oracle ${fmt(price)}  divergence ${fmt(divergenceWad(price, reading.index))}`,
  );

  if (!cfg.publish) {
    console.log("[feed] dry run: set PUBLISH=1 to send it");
    return;
  }
  const tx = new Transaction().add(setExternalMedianIx(signer.publicKey, cfg.oracle, reading.index));
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
  console.log(`[feed] mode     ${cfg.publish ? "PUBLISH" : "dry run"} ${cfg.source}, min ${cfg.minSamples} cards, every ${cfg.intervalMs}ms`);

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
