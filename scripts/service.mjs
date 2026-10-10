#!/usr/bin/env node
/**
 * Run the keeper or the liquidator against a recorded deployment, so nobody
 * copies addresses into environment variables by hand.
 *
 *   node scripts/service.mjs keeper
 *   node scripts/service.mjs liquidator
 *
 * Env: KADEX_DEPLOYMENT (default deployments/devnet.json), DEVNET_RPC,
 * KADEX_SERVICE_KEYPAIR (default KADEX_DEPLOYER, then ~/.config/solana/id.json).
 * Anything already set (ORACLE, MARKET, RPC_URL, ...) wins over the record.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RECORD = process.env.KADEX_DEPLOYMENT ?? join(ROOT, "deployments/devnet.json");
const KEYPAIR = process.env.KADEX_SERVICE_KEYPAIR ?? process.env.KADEX_DEPLOYER ?? join(homedir(), ".config/solana/id.json");

export function serviceEnv(name, record, base = {}) {
  const protocol = record.protocol ?? {};
  const settings = {
    keeper: { KEEPER_KEYPAIR: KEYPAIR, ORACLE: protocol.oracle, AMM_POOL: record.raydium?.pool },
    liquidator: { LIQUIDATOR_KEYPAIR: KEYPAIR, MARKET: protocol.market, IDL_DIR: join(ROOT, "target/idl") },
  }[name];
  if (!settings) throw new Error(`unknown service ${name}; one of keeper, liquidator`);
  const missing = Object.entries(settings).filter(([key, value]) => !value && !base[key]).map(([key]) => key);
  if (missing.length > 0) throw new Error(`the deployment record has no value for ${missing.join(", ")}; run the protocol step first`);
  return { RPC_URL: process.env.DEVNET_RPC ?? "https://api.devnet.solana.com", ...settings, ...base };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const name = process.argv[2];
  if (!existsSync(RECORD)) {
    console.error(`no deployment record at ${RECORD}; run node scripts/devnet.mjs all first`);
    process.exit(1);
  }
  let env;
  try {
    env = serviceEnv(name, JSON.parse(readFileSync(RECORD, "utf8")), process.env);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const child = spawn("npx", ["--yes", "tsx", join(ROOT, `apps/${name}/src/index.ts`)], { stdio: "inherit", env, shell: process.platform === "win32" });
  child.on("exit", (code) => process.exit(code ?? 1));
}
