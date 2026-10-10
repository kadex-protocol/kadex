/**
 * Publishes the basket's Collector Crypt appraisal drift as the oracle's
 * `external_median`, the sanity bound (issue #11). Never a price.
 *
 * It signs with the oracle's admin key, the only key `set_external_median`
 * accepts. So it checks that key against the oracle at start, and refuses to
 * send anything that would weaken the bound: no zero, nothing from too few
 * cards, nothing outside the safety bounds.
 *
 * If it stops, the bound lapses after the oracle's `max_staleness_secs` and
 * the market runs on the AMM alone, one defence fewer; it does not halt.
 *
 * Run:
 *   FEED_KEYPAIR=~/.config/solana/id.json ORACLE=<oracle pda> \
 *   RPC_URL=https://api.devnet.solana.com [PUBLISH=1] \
 *   npx tsx apps/external-feed/src/index.ts
 */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { WAD } from "@kadex/types";
import { collectorCryptLimits } from "@kadex/collector-crypt";
import {
  DEFAULT_PUBLISH_BOUNDS,
  divergenceWad,
  publishDecision,
  readAppraisalIndex,
  readExternalMedian,
  readOracleAdmin,
  readOraclePrice,
  setExternalMedianIx,
  type PublishBounds,
} from "@kadex/collector-crypt/chain";
import { ConfigError, intFromEnv, loadKeypair, redactUrl } from "@kadex/sdk/node";

interface Config {
  rpcUrl: string;
  oracle: PublicKey;
  intervalMs: number;
  minSamples: number;
  /** What is published: "appraisal" (default) or "asks". The other is logged only. */
  source: "appraisal" | "asks";
  publish: boolean;
  bounds: PublishBounds;
}

function loadConfig(): Config {
  const oracle = process.env.ORACLE;
  if (!oracle) throw new ConfigError("missing env ORACLE: the oracle account to publish to");
  let oracleKey: PublicKey;
  try {
    oracleKey = new PublicKey(oracle);
  } catch {
    throw new ConfigError(`ORACLE is not a public key: ${JSON.stringify(oracle)}`);
  }
  const wad = (name: string, fallback: bigint) => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    if (!/^\d+(\.\d{1,6})?$/.test(raw)) throw new ConfigError(`${name} must be a decimal like 0.1 or 10, got ${JSON.stringify(raw)}`);
    const [whole = "0", frac = ""] = raw.split(".");
    return BigInt(whole) * WAD + BigInt(frac.padEnd(6, "0"));
  };
  const bounds = { minIndex: wad("MIN_INDEX", DEFAULT_PUBLISH_BOUNDS.minIndex), maxIndex: wad("MAX_INDEX", DEFAULT_PUBLISH_BOUNDS.maxIndex) };
  if (bounds.minIndex <= 0n || bounds.minIndex >= bounds.maxIndex) throw new ConfigError("need 0 < MIN_INDEX < MAX_INDEX");
  return {
    rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8899",
    oracle: oracleKey,
    intervalMs: intFromEnv("INTERVAL_MS", 60_000, 1_000),
    minSamples: intFromEnv("MIN_SAMPLES", 5, 1),
    source: process.env.SOURCE === "asks" ? "asks" : "appraisal",
    publish: process.env.PUBLISH === "1",
    bounds,
  };
}

const fmt = (wad: bigint) => (Number(wad) / Number(WAD)).toFixed(4);

/** Returns true when it published. */
async function tick(conn: Connection, cfg: Config, signer: Keypair): Promise<boolean> {
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

  const decision = publishDecision(reading, cfg.minSamples, cfg.bounds);
  if (!decision.publish) {
    console.warn(`[feed] not publishing: ${decision.reason}`);
    return false;
  }

  const price = await readOraclePrice(conn, cfg.oracle);
  console.log(
    `[feed] ${cfg.source} index ${fmt(decision.value)} over ${reading.samples.length} cards  ` +
      `oracle ${fmt(price)}  divergence ${fmt(divergenceWad(price, decision.value))}`,
  );

  if (!cfg.publish) {
    console.log("[feed] dry run: set PUBLISH=1 to send it");
    return false;
  }
  // Preflight simulates it; confirmation throws on a program error or an
  // expired blockhash, and the caller counts that as a failed tick.
  const tx = new Transaction().add(setExternalMedianIx(signer.publicKey, cfg.oracle, decision.value));
  const sig = await sendAndConfirmTransaction(conn, tx, [signer], { commitment: "confirmed" });
  console.log(`[feed] published  sig=${sig}`);
  return true;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const signer = loadKeypair(process.env.FEED_KEYPAIR, "FEED_KEYPAIR");

  // A wrong key would fail every publish as NotAdmin. Say so once, at start.
  const admin = await readOracleAdmin(conn, cfg.oracle);
  if (!admin.equals(signer.publicKey)) {
    const msg = `FEED_KEYPAIR is ${signer.publicKey.toBase58()}, but the oracle's admin is ${admin.toBase58()}; set_external_median will refuse it`;
    if (cfg.publish) throw new ConfigError(msg);
    console.warn(`[feed] ${msg} (dry run, continuing)`);
  }

  console.log(`[feed] rpc      ${redactUrl(cfg.rpcUrl)}`);
  console.log(`[feed] oracle   ${cfg.oracle.toBase58()}`);
  console.log(`[feed] signer   ${signer.publicKey.toBase58()}`);
  console.log(`[feed] mode     ${cfg.publish ? "PUBLISH" : "dry run"} ${cfg.source}, min ${cfg.minSamples} cards, every ${cfg.intervalMs}ms`);
  console.log(`[feed] bounds   ${fmt(cfg.bounds.minIndex)}..${fmt(cfg.bounds.maxIndex)}`);

  let failures = 0;
  let lastPublished = Date.now();
  for (;;) {
    try {
      if (await tick(conn, cfg, signer)) lastPublished = Date.now();
      failures = 0;
    } catch (err) {
      failures += 1;
      console.error(`[feed] tick failed (${failures} in a row):`, err instanceof Error ? err.message : err);
    }
    // The oracle stops applying the bound once the median is older than its
    // staleness limit (900 s by default). Say so before it happens.
    const silent = Math.round((Date.now() - lastPublished) / 1000);
    if (cfg.publish && silent >= 600 && silent - cfg.intervalMs / 1000 < 600) {
      console.error(`[feed] nothing published for ${silent}s: the divergence bound lapses at the oracle's max_staleness_secs`);
    }
    await new Promise((r) => setTimeout(r, cfg.intervalMs));
  }
}

main().catch((err) => {
  console.error(`[feed] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
