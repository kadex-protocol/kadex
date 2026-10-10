#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotent, getAccount, getMint, mintTo } from "@solana/spl-token";
import { readRaydium, refreshAccounts, spotPrice, swapBaseInputIx } from "../packages/oracle/dist/index.js";
import { decodeOracle, refreshPriceIx } from "../packages/sdk/dist/chain.js";

const USAGE = `Move the price of the devnet index pool by trading in it. DEVNET AND LOCAL ONLY.

  node scripts/devnet-market.mjs status                 spot, oracle price and the trader's balances
  node scripts/devnet-market.mjs to 1.03                trade until the pool's spot price is 1.03
  node scripts/devnet-market.mjs nudge -2               move the spot price by -2% from where it is
  node scripts/devnet-market.mjs swing 0.03 600 15      oscillate 3% around the current price, one
                                                        cycle every 600 s, one trade every 15 s

Reads the addresses from deployments/devnet.json (KADEX_DEPLOYMENT overrides the path).
Env: DEVNET_RPC (default https://api.devnet.solana.com), KADEX_MARKET_KEYPAIR (default
KADEX_DEPLOYER, then ~/.config/solana/id.json). The trader needs index tokens and test USD;
if it is the mint authority of either, as the devnet deployer is, it mints what a trade lacks.
Each trade moves the spot price at most KADEX_MARKET_MAX_STEP (default 0.02) and is followed,
in the same transaction, by refresh_price. Run \`npm run typecheck\` first: it builds the packages.`;

const WAD = 1_000_000n;
const UNIT = 1_000_000n;
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export function isqrt(n) {
  if (n < 0n) throw new Error("square root of a negative number");
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}

export function planSwap(reserves, target) {
  const k = reserves.usdc * reserves.fraction;
  const usdc = isqrt((k * target) / WAD);
  if (usdc > reserves.usdc) return { input: "usdc", amountIn: usdc - reserves.usdc };
  const fraction = usdc === 0n ? 0n : k / usdc;
  return { input: "fraction", amountIn: fraction > reserves.fraction ? fraction - reserves.fraction : 0n };
}

export function clampStep(spot, target, maxStep) {
  const reach = (spot * maxStep) / WAD;
  if (target > spot + reach) return spot + reach;
  return target < spot - reach ? spot - reach : target;
}

export const wave = (base, amplitude, periodSecs, secs) =>
  BigInt(Math.round(Number(base) * (1 + amplitude * Math.sin((2 * Math.PI * secs) / periodSecs))));

export const toWad = (text) => {
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`not a positive number: ${text}`);
  return BigInt(Math.round(n * Number(WAD)));
};

const fmt = (wad) => (Number(wad) / Number(WAD)).toFixed(4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!["status", "to", "nudge", "swing"].includes(command)) {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }

  const root = fileURLToPath(new URL("..", import.meta.url));
  const recordPath = process.env.KADEX_DEPLOYMENT ?? join(root, "deployments/devnet.json");
  if (!existsSync(recordPath)) throw new Error(`${recordPath} does not exist: run scripts/devnet.mjs first`);
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  if (!record.mints?.index?.address || !record.mints?.usd?.address || !record.raydium?.pool) {
    throw new Error(`${recordPath} has no mints or pool yet: run the "mints" and "pool" steps of scripts/devnet.mjs`);
  }

  const rpc = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
  const keypairPath = (process.env.KADEX_MARKET_KEYPAIR ?? process.env.KADEX_DEPLOYER ?? join(homedir(), ".config/solana/id.json")).replace(/^~/, homedir());
  const maxStep = toWad(process.env.KADEX_MARKET_MAX_STEP ?? "0.02");
  const conn = new Connection(rpc, "confirmed");
  if ((await conn.getGenesisHash()) === MAINNET_GENESIS) throw new Error("this script never trades on mainnet");

  const trader = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))));
  const index = new PublicKey(record.mints.index.address);
  const usd = new PublicKey(record.mints.usd.address);
  const ammPool = new PublicKey(record.raydium.pool);
  const oracle = record.protocol?.oracle ? new PublicKey(record.protocol.oracle) : null;
  const mints = { usdc: usd, fraction: index };
  const names = { usdc: "test USD", fraction: "index tokens" };

  const accounts = {
    usdc: await createAssociatedTokenAccountIdempotent(conn, trader, usd, trader.publicKey),
    fraction: await createAssociatedTokenAccountIdempotent(conn, trader, index, trader.publicKey),
  };
  const balance = async (side) => (await getAccount(conn, accounts[side])).amount;

  async function fund(side, amount) {
    const have = await balance(side);
    if (have >= amount) return;
    const authority = (await getMint(conn, mints[side])).mintAuthority;
    if (!authority?.equals(trader.publicKey)) {
      throw new Error(`the trader holds ${fmt(have)} ${names[side]} and this trade needs ${fmt(amount)}; fund ${trader.publicKey.toBase58()}`);
    }
    await mintTo(conn, trader, mints[side], accounts[side], trader, amount - have);
    console.log(`[market] minted ${fmt(amount - have)} ${names[side]} to the trader`);
  }

  async function step(target) {
    const { pool, reserves } = await readRaydium(conn, ammPool, index);
    const spot = spotPrice(reserves);
    const plan = planSwap(reserves, clampStep(spot, target, maxStep));
    if (plan.amountIn < UNIT) return spot;
    await fund(plan.input, plan.amountIn);
    const tx = new Transaction().add(swapBaseInputIx({ pool, payer: trader.publicKey, inputMint: mints[plan.input], amountIn: plan.amountIn }));
    if (oracle) tx.add(refreshPriceIx(trader.publicKey, oracle, ammPool, refreshAccounts(pool)));
    const signature = await sendAndConfirmTransaction(conn, tx, [trader], { commitment: "confirmed" });
    const after = spotPrice((await readRaydium(conn, ammPool, index)).reserves);
    console.log(`[market] ${fmt(spot)} -> ${fmt(after)}  paid ${fmt(plan.amountIn)} ${names[plan.input]}  ${signature}`);
    return after;
  }

  async function moveTo(target) {
    if (target < WAD / 5n || target > WAD * 5n) throw new Error(`${fmt(target)} is outside 0.20 to 5.00`);
    for (let i = 0; i < 60; i += 1) {
      const spot = await step(target);
      const gap = spot > target ? spot - target : target - spot;
      if (gap * 2_000n <= target) return spot;
      await sleep(1_500);
    }
    throw new Error("the pool did not reach the target in 60 trades");
  }

  const spotNow = async () => spotPrice((await readRaydium(conn, ammPool, index)).reserves);

  if (command === "status") {
    const { reserves } = await readRaydium(conn, ammPool, index);
    console.log(`pool    spot ${fmt(spotPrice(reserves))}  reserves ${fmt(reserves.usdc)} USD / ${fmt(reserves.fraction)} index`);
    if (oracle) {
      const info = await conn.getAccountInfo(oracle);
      const o = info ? decodeOracle(info.data) : null;
      console.log(o ? `oracle  price ${fmt(o.price)}  twap ${fmt(o.twap)}  state ${o.state}  updated ${new Date(Number(o.lastUpdateTs) * 1000).toISOString()}` : "oracle  not found");
    }
    console.log(`trader  ${trader.publicKey.toBase58()}  ${fmt(await balance("usdc"))} USD  ${fmt(await balance("fraction"))} index`);
    return;
  }
  if (command === "to") {
    await moveTo(toWad(args[0]));
    return;
  }
  if (command === "nudge") {
    const percent = Number(args[0]);
    if (!Number.isFinite(percent) || percent === 0) throw new Error("nudge needs a percentage, such as 2 or -2");
    const spot = await spotNow();
    await moveTo(BigInt(Math.round(Number(spot) * (1 + percent / 100))));
    return;
  }

  const amplitude = Number(args[0] ?? 0.03);
  const period = Number(args[1] ?? 600);
  const interval = Number(args[2] ?? 15);
  if (!(amplitude > 0 && amplitude < 0.5) || !(period > 0) || !(interval > 0)) throw new Error("swing takes an amplitude below 0.5, a period and an interval in seconds");
  const base = await spotNow();
  console.log(`[market] swinging ${amplitude * 100}% around ${fmt(base)}, period ${period} s, a trade every ${interval} s. Ctrl+C stops it.`);
  const started = Date.now();
  for (;;) {
    await step(wave(base, amplitude, period, (Date.now() - started) / 1000)).catch((e) => console.error(`[market] trade failed: ${e.message.split("\n")[0]}`));
    await sleep(interval * 1000);
  }
}

const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

if (process.argv[1] && samePath(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
