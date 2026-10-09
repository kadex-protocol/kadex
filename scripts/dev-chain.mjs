#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import anchor from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import {
  RPC_URL, USDC, TOKEN_PROGRAM_ID, newProvider, programs, setupProtocol, actor, refresh, sleep,
} from "../tests/integration/_harness.mjs";

const ENV_FILE = process.env.KADEX_ENV_FILE ?? fileURLToPath(new URL("../apps/web/.env.local", import.meta.url));
const REFRESH_MS = 20_000;
const big = (x) => new anchor.BN(x.toString());

const wallet = process.argv[2] ? new PublicKey(process.argv[2]) : null;

const ctx = await newProvider();
ctx.p = programs(ctx.provider);
const env = await setupProtocol(ctx);

const seed = await actor(ctx, env, 140_000n * USDC);
await mintTo(ctx.conn, ctx.payer, env.fractionMint, seed.fractions, ctx.payer, 40_000n * USDC);
const shared = {
  depositor: seed.kp.publicKey,
  pool: env.pool,
  oracle: env.oracle,
  clpMint: env.clpMint,
  depositorClp: seed.clp,
  tokenProgram: TOKEN_PROGRAM_ID,
};
await ctx.p.clpPool.methods
  .depositUsdc(big(140_000n * USDC))
  .accounts({ ...shared, usdcVault: env.usdcVault, depositorUsdc: seed.usdc })
  .signers([seed.kp])
  .rpc();
await ctx.p.clpPool.methods
  .depositFractions(big(40_000n * USDC))
  .accounts({ ...shared, fractionVault: env.fractionVault, depositorFractions: seed.fractions })
  .signers([seed.kp])
  .rpc();

if (wallet) {
  const sig = await ctx.conn.requestAirdrop(wallet, 10 * LAMPORTS_PER_SOL);
  await ctx.conn.confirmTransaction(sig, "confirmed");
  const usdc = await createAssociatedTokenAccount(ctx.conn, ctx.payer, env.usdcMint, wallet);
  const fractions = await createAssociatedTokenAccount(ctx.conn, ctx.payer, env.fractionMint, wallet);
  await mintTo(ctx.conn, ctx.payer, env.usdcMint, usdc, ctx.payer, 5_000n * USDC);
  await mintTo(ctx.conn, ctx.payer, env.fractionMint, fractions, ctx.payer, 3_000n * USDC);
}

// Rewrite only the two cluster lines: anything else in the file, such as an
// API key, is the user's and survives every restart.
const ours = {
  NEXT_PUBLIC_KADEX_RPC_URL: process.env.KADEX_BROWSER_RPC ?? RPC_URL,
  NEXT_PUBLIC_KADEX_USDC_MINT: env.usdcMint.toBase58(),
};
const kept = existsSync(ENV_FILE)
  ? readFileSync(ENV_FILE, "utf8").split("\n").filter((line) => line.trim() && !(line.split("=")[0].trim() in ours))
  : [];
writeFileSync(ENV_FILE, [...kept, ...Object.entries(ours).map(([k, v]) => `${k}=${v}`)].join("\n") + "\n");

console.log(`[dev-chain] pool       ${env.pool.toBase58()}`);
console.log(`[dev-chain] USDC mint  ${env.usdcMint.toBase58()}`);
console.log("[dev-chain] seeded     140,000 USDC + 40,000 fractions");
console.log(
  wallet
    ? `[dev-chain] funded     ${wallet.toBase58()} with 10 SOL, 5,000 USDC, 3,000 fractions`
    : "[dev-chain] no wallet given: pass a public key to fund it",
);
console.log(`[dev-chain] wrote      ${ENV_FILE}`);
console.log("[dev-chain] restart the web app and leave this running; Ctrl+C stops the validator");

for (;;) {
  await sleep(REFRESH_MS);
  await refresh(ctx, env).catch((err) => console.error(`[dev-chain] refresh failed: ${err.message}`));
}
