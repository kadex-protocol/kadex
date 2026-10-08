#!/usr/bin/env node
/**
 * Run a command against a throwaway `solana-test-validator` with all five
 * SLAB programs deployed at their fixed addresses.
 *
 *     node scripts/with-validator.mjs node --test tests/integration/
 *
 * # Why this exists
 *
 * This is the way around Blocker #6. litesvm cannot load the SBPF v3 binaries
 * Anchor 1.2 produces, and no release reconciles that with the pinned rustc.
 * A real validator has no such problem — SBPFv3 execution is enabled by
 * default — and it tests the artifact we actually deploy.
 *
 * # Why it deploys rather than preloading at genesis
 *
 * `--bpf-program` and `--upgradeable-program` both place the accounts but
 * leave the programs uninvocable here: calls fail with "Program is not
 * deployed". Running `solana program deploy` after boot is the same path the
 * team uses on devnet, so if it works here it works there.
 *
 * Slower than `cargo test` by three orders of magnitude, so it is a separate
 * command. The pure tests stay the fast inner loop; this proves account
 * validation, signer constraints and CPI authority on a real runtime.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RPC_PORT = Number(process.env.RPC_PORT ?? 8899);
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;

/** Must match Anchor.toml and keys/. */
const PROGRAMS = ["card_vault", "oracle", "clp_pool", "perp", "mock_amm"];

/**
 * Metaplex Core, byte for byte as mainnet runs it, so the vault's Core path
 * is tested against the real program rather than a fake. Dumped with
 * `solana program dump -u m CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`.
 */
const EXTERNAL = [["CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d", "tests/fixtures/mpl_core.so"]];

// A live Collector Crypt card, exported from mainnet with getAccountInfo.
const ACCOUNTS = [["CvsHTsAjWdaxViomzmfzqkVFsNkps6Jzs8d24jjMzP43", "tests/fixtures/cc_wartortle_account.json"]];

// NODE_OPTIONS on this machine carries a stale preload that breaks child node
// processes; clearing it keeps the harness self-contained.
const ENV = { ...process.env, NODE_OPTIONS: "", ANCHOR_PROVIDER_URL: RPC_URL };

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", env: ENV, cwd: ROOT, ...opts });
}

async function waitForRpc(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      });
      if ((await res.json()).result === "ok") return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function deployAll(deployerKeypair) {
  for (const name of PROGRAMS) {
    const so = join(ROOT, "target", "deploy", `${name}.so`);
    const programId = join(ROOT, "keys", `${name}-keypair.json`);
    if (!existsSync(so)) {
      console.error(`missing ${so} — run \`anchor build\` first`);
      return false;
    }
    // loader-v4, not `solana program deploy`. Anchor 1.2 emits SBPF v3, and
    // the legacy loader's ELF parser rejects it outright with
    // "invalid file header". This is also the command the team needs on
    // devnet — see docs/deploying.md.
    const r = run("solana", [
      "program-v4", "deploy", so,
      "--program-keypair", programId,
      "--keypair", deployerKeypair,
      "--url", RPC_URL,
      "--commitment", "confirmed",
      "--use-rpc",
    ]);
    if (r.status !== 0) {
      console.error(
        `[validator] deploying ${name} failed (status ${r.status}):\n` +
          `stdout: ${r.stdout}\nstderr: ${r.stderr}\nerror: ${r.error ?? "none"}`,
      );
      return false;
    }
    console.log(`[validator] deployed ${name}`);
  }
  return true;
}

async function main() {
  const command = process.argv.slice(2);
  if (command.length === 0) {
    console.error("usage: node scripts/with-validator.mjs <command...>");
    process.exit(1);
  }

  const workdir = mkdtempSync(join(tmpdir(), "slab-validator-"));
  const ledger = join(workdir, "ledger");
  const deployer = join(workdir, "deployer.json");

  const validator = spawn(
    "solana-test-validator",
    [
      "--reset", "--quiet", "--ledger", ledger, "--rpc-port", String(RPC_PORT),
      ...EXTERNAL.flatMap(([id, so]) => ["--bpf-program", id, join(ROOT, so)]),
      ...ACCOUNTS.flatMap(([id, file]) => ["--account", id, join(ROOT, file)]),
    ],
    { stdio: ["ignore", "ignore", "pipe"], env: ENV },
  );
  let stderr = "";
  validator.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  const cleanup = () => {
    if (!validator.killed) validator.kill("SIGTERM");
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  console.log(`[validator] starting on ${RPC_URL}`);
  if (!(await waitForRpc())) {
    console.error("[validator] never became healthy");
    if (stderr) console.error(stderr.slice(-2000));
    cleanup();
    process.exit(1);
  }

  run("solana-keygen", ["new", "--no-bip39-passphrase", "--silent", "-o", deployer, "-f"]);
  run("solana", ["airdrop", "500", "--keypair", deployer, "--url", RPC_URL]);

  if (!deployAll(deployer)) {
    cleanup();
    process.exit(1);
  }
  console.log("[validator] ready");

  // The deployer is the programs' upgrade authority, and so the only key that
  // may initialize them. Tests act as it for every admin step.
  const child = spawn(command[0], command.slice(1), {
    stdio: "inherit",
    env: { ...ENV, SLAB_DEPLOYER: deployer },
    cwd: ROOT,
  });
  const code = await new Promise((r) => child.on("exit", r));

  cleanup();
  process.exit(code ?? 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
