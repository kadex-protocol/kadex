#!/usr/bin/env node
/**
 * Build the programs so they can actually be deployed.
 *
 *     npm run build:programs
 *
 * # Why this is not just `anchor build`
 *
 * Anchor 1.2 hardcodes `--arch v3`, so `anchor build` emits SBPF v3 binaries.
 * The Solana CLI 3.1.10 shipped with this toolchain cannot parse them at all:
 *
 *     $ solana program deploy target/deploy/oracle.so
 *     Error: ELF error: Failed to parse ELF file: invalid file header
 *
 * It fails the same way through `solana program-v4 deploy`, and litesvm
 * rejects them too. The runtime supports SBPFv3 — the feature gate is active —
 * but every tool that has to read the ELF before sending it is capped lower.
 *
 * So: `anchor build` for the IDLs and TypeScript types, then `cargo-build-sbf
 * --arch v1` to overwrite the binaries with something deployable. The source
 * is identical; only the bytecode target differs.
 *
 * This script verifies `e_flags` on every output, because a silent reversion
 * to v3 would not show up until someone tries to deploy.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT = join(ROOT, "target", "deploy");
// The shim rewrites Anchor's hardcoded `--arch v3` to v1, so a single
// `anchor build` now produces deployable binaries. Without it Anchor builds
// v3 and we would have to build everything a second time.
const ENV = {
  ...process.env,
  NODE_OPTIONS: "",
  PATH: join(ROOT, "scripts", "bin") + delimiter + process.env.PATH,
};

/** directory name -> output .so name */
const PROGRAMS = {
  "card-vault": "card_vault",
  oracle: "oracle",
  "clp-pool": "clp_pool",
  perp: "perp",
  "mock-amm": "mock_amm",
};

/** SBPF version the deployable binaries must carry. */
const REQUIRED_ARCH = "v1";
const REQUIRED_E_FLAGS = 1;

function sh(cmd, args, cwd = ROOT) {
  const r = spawnSync(cmd, args, { stdio: "inherit", env: ENV, cwd });
  if (r.status !== 0) {
    console.error(`\n${cmd} ${args.join(" ")} failed`);
    process.exit(r.status ?? 1);
  }
}

function eFlags(path) {
  const buf = readFileSync(path);
  return buf.readUInt32LE(48);
}

console.log(`[build] anchor build, with the --arch ${REQUIRED_ARCH} shim on PATH`);
sh("anchor", ["build"]);

let bad = 0;
for (const name of Object.values(PROGRAMS)) {
  const so = join(OUT, `${name}.so`);
  if (!existsSync(so)) {
    console.error(`[build] MISSING ${name}.so`);
    bad += 1;
    continue;
  }
  const flags = eFlags(so);
  const ok = flags === REQUIRED_E_FLAGS;
  console.log(`[build] ${ok ? "ok  " : "BAD "} ${name}.so  e_flags=${flags}`);
  if (!ok) bad += 1;
}

if (bad > 0) {
  console.error(
    `\n[build] ${bad} binary(ies) are not SBPF ${REQUIRED_ARCH}. ` +
      "They will fail to deploy with \"invalid file header\". " +
      "Check that cargo-build-sbf ran after anchor build, not before.",
  );
  process.exit(1);
}
console.log("[build] all programs are deployable");
