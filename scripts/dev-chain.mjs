#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import anchor from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import {
  IDLS, RPC_URL, USDC, WAD, TOKEN_PROGRAM_ID, newProvider, programs, setupProtocol, actor, refresh, sleep,
} from "../tests/integration/_harness.mjs";
import { mirrorCards } from "./test-cards.mjs";

const ENV_FILE = process.env.KADEX_ENV_FILE ?? fileURLToPath(new URL("../apps/web/.env.local", import.meta.url));
const RECORD = process.env.KADEX_DEPLOYMENT ?? fileURLToPath(new URL("../deployments/local.json", import.meta.url));
const REFRESH_MS = 20_000;
const MARKET_MS = 3_000;
const SWING = Number(process.env.KADEX_DEV_SWING ?? 0);
const big = (x) => new anchor.BN(x.toString());

const isqrt = (n) => {
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
};

const simulatedPrice = (secs) =>
  BigInt(Math.round((1 + SWING * (0.7 * Math.sin(secs / 95) + 0.3 * Math.sin(secs / 17))) * Number(WAD)));

async function steerMockAmm(price) {
  const pool = await ctx.p.mockAmm.account.mockPool.fetch(env.ammPool);
  const usdc = BigInt(pool.usdc.toString());
  const fraction = BigInt(pool.fraction.toString());
  const wanted = isqrt((usdc * fraction * price) / WAD);
  const usdcIn = wanted > usdc ? wanted - usdc : 0n;
  const fractionIn = wanted < usdc ? (usdc * fraction) / wanted - fraction : 0n;
  if (usdcIn + fractionIn < USDC) return;
  await ctx.p.mockAmm.methods
    .swap(big(usdcIn), big(fractionIn))
    .accounts({ caller: ctx.provider.wallet.publicKey, pool: env.ammPool })
    .rpc();
}

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

// Test copies of real cards for the wallet, so vault and redeem can be tried here too.
const record = { cluster: "local", cards: [] };
const saveRecord = () => {
  mkdirSync(dirname(RECORD), { recursive: true });
  writeFileSync(RECORD, JSON.stringify(record, null, 2) + "\n");
};
saveRecord();
if (wallet && process.env.KADEX_DEV_CARDS !== "0") {
  const vault = new anchor.Program(IDLS.cardVault, ctx.provider);
  await mirrorCards({ conn: ctx.conn, payer: ctx.payer, vault, programData: null, owner: wallet, record, save: saveRecord, log: (line) => console.log(`[dev-chain] card      ${line.trim()}`) })
    .catch((err) => console.error(`[dev-chain] no test cards: ${err.message}`));
}

// Rewrite only the lines this script owns: anything else in the file, such as
// an API key, is the user's and survives every restart.
const ours = {
  NEXT_PUBLIC_KADEX_NETWORK: "local",
  NEXT_PUBLIC_KADEX_RPC_URL: process.env.KADEX_BROWSER_RPC ?? RPC_URL,
  NEXT_PUBLIC_KADEX_USDC_MINT: env.usdcMint.toBase58(),
  KADEX_FAUCET_KEYPAIR: JSON.stringify([...ctx.payer.secretKey]),
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
console.log("[dev-chain] faucet     the web app funds any wallet that connects: 1,000 USDC and 0.05 SOL");
console.log(
  SWING > 0
    ? `[dev-chain] market     simulated: the mock AMM swings ${SWING * 100}% around $1.00`
    : "[dev-chain] market     flat at $1.00; set KADEX_DEV_SWING=0.06 to make the mock AMM move",
);
console.log(`[dev-chain] wrote      ${ENV_FILE}`);
console.log("[dev-chain] restart the web app and leave this running; Ctrl+C stops the validator");

const started = Date.now();
for (;;) {
  await sleep(SWING > 0 ? MARKET_MS : REFRESH_MS);
  if (SWING > 0) {
    await steerMockAmm(simulatedPrice((Date.now() - started) / 1000)).catch((err) => console.error(`[dev-chain] swap failed: ${err.message}`));
  }
  await refresh(ctx, env).catch((err) => console.error(`[dev-chain] refresh failed: ${err.message}`));
}
