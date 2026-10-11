#!/usr/bin/env node
/**
 * Stand up Kadex on devnet against a real Raydium CPMM pool. Re-runnable:
 * every step checks the chain and skips what already exists, and everything
 * it creates is recorded in deployments/devnet.json (addresses and
 * signatures only — never a key).
 *
 *   node scripts/devnet.mjs check      what is deployed, what it will cost
 *   node scripts/devnet.mjs programs   deploy oracle, clp_pool, perp, card_vault
 *   node scripts/devnet.mjs mints      index token (+ metadata) and devnet USD
 *   node scripts/devnet.mjs pool       Raydium CPMM pool, seeded
 *   node scripts/devnet.mjs protocol   oracle, CLP pool, perp market
 *   node scripts/devnet.mjs verify     refresh, compare Rust and TS, open + close a position
 *   node scripts/devnet.mjs env        faucet key, funded; point apps/web/.env.local at this deployment
 *   node scripts/devnet.mjs all        every step above, in order
 *   node scripts/devnet.mjs cards <wallet>        test copies of real cards, owned by that wallet
 *   node scripts/devnet.mjs fund <wallet> [usd]   mint devnet USD to a wallet (default 10,000)
 *
 * Env: DEVNET_RPC (default https://api.devnet.solana.com), KADEX_DEPLOYER
 * (keypair path, default ~/.config/solana/id.json). The deployer becomes the
 * programs' upgrade authority and must be the one that initializes them.
 *
 * DEVNET ONLY. The index token is a demonstration instrument: it is not
 * backed by and cannot be redeemed for any card. "Kadex Devnet USD" is a
 * mint this script controls, because a $25k-deep pool cannot be funded from
 * the Circle devnet faucet; it is not USDC.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKeypair, redactUrl } from "@kadex/sdk/node";
import anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAccount, createAssociatedTokenAccountIdempotent, createMint, getAccount, getMint, mintTo,
} from "@solana/spl-token";
import { DEFAULT_POOL_PARAMS, IDLS, findMarket, findOracle, findPool } from "../tests/integration/_harness.mjs";
import {
  RAYDIUM_CPMM, RAYDIUM_CREATE_POOL_FEE, createPoolIx, poolAddresses, readRaydium, refreshAccounts, decodePool, spotPrice,
} from "../packages/oracle/dist/index.js";
import {
  closePositionIx, decodeOracle, decodePool as decodeClpPool, depositUsdcIx, findAta, openPositionIx, refreshPriceIx,
} from "../packages/sdk/dist/chain.js";
import { findPosition } from "../packages/types/dist/index.js";
import { mirrorCards } from "./test-cards.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// KADEX_DEPLOYMENT lets a local dry run write elsewhere than the devnet record.
const RECORD = process.env.KADEX_DEPLOYMENT ?? join(ROOT, "deployments/devnet.json");
const RPC = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
const KEYPAIR = (process.env.KADEX_DEPLOYER ?? join(homedir(), ".config/solana/id.json")).replace(/^~/, homedir());
const USDC = 1_000_000n;
const ENV_FILE = process.env.KADEX_ENV_FILE ?? join(ROOT, "apps/web/.env.local");
const NETWORK = process.env.KADEX_NETWORK ?? (/\/\/(localhost|127\.0\.0\.1)[:/]/.test(RPC) ? "local" : "devnet");
/** What the web app's faucet hands out comes from this wallet, never from the deployer. */
const FAUCET = { sol: 1, usd: 100_000n * USDC };

/** Raydium devnet fee config index 0: 0.25% trade fee. Read off devnet. */
const AMM_CONFIG = new PublicKey("5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy");
const TOKEN_METADATA = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const LOADER_V3 = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/**
 * Seed: 50,000 index tokens against 50,000 Kadex Devnet USD, so $1.00 per
 * index token, the same $1-per-fraction convention the vault uses. $50k of
 * depth is above the oracle's $25k floor and, per scripts/size-market.mjs,
 * supports about $7.5k of open interest. A devnet demonstration size, not
 * the answer to who funds launch liquidity (#2).
 */
const SEED = { index: 50_000n * USDC, usd: 50_000n * USDC };

/** The defences docs/oracle.md documents, unchanged. */
const ORACLE_PARAMS = {
  twapWindowSecs: 1800,
  maxTickMove: new anchor.BN(50_000),
  maxStalenessSecs: 900,
  minPoolDepth: new anchor.BN(25_000_000_000),
  maxDivergence: new anchor.BN(150_000),
  slowAlpha: new anchor.BN(10_000),
  clampPeriodSecs: 15,
};

const PROGRAMS = [
  ["oracle", IDLS.oracle.address],
  ["clp_pool", IDLS.clpPool.address],
  ["perp", IDLS.perp.address],
  ["card_vault", IDLS.cardVault.address],
];

// --- record ---------------------------------------------------------------

const record = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) : { cluster: "devnet", transactions: {} };
const save = () => {
  mkdirSync(dirname(RECORD), { recursive: true });
  writeFileSync(RECORD, JSON.stringify(record, null, 2) + "\n");
};
const note = (step, sig) => {
  record.transactions[step] = sig;
  save();
  console.log(`  ${step}: ${sig}`);
};
const pk = (s) => (s ? new PublicKey(s) : null);

// --- chain ----------------------------------------------------------------

const conn = new Connection(RPC, "confirmed");
const payer = loadKeypair(KEYPAIR, "KADEX_DEPLOYER");
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: "confirmed" });
const p = {
  oracle: new anchor.Program(IDLS.oracle, provider),
  clpPool: new anchor.Program(IDLS.clpPool, provider),
  perp: new anchor.Program(IDLS.perp, provider),
  cardVault: new anchor.Program(IDLS.cardVault, provider),
};
const send = (...ixs) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [payer], { commitment: "confirmed" });
const exists = async (key) => (await conn.getAccountInfo(key)) !== null;
/**
 * Every initialize checks the signer is the upgrade authority. Under the v3
 * loader (what `solana program deploy` uses, and the only one devnet runs:
 * SIMD-0167 loader-v4 is inactive there) it lives in a separate ProgramData
 * account; under loader v4 (the local harness) in the program account itself.
 */
async function programData(id) {
  const info = await conn.getAccountInfo(new PublicKey(id));
  if (!info) throw new Error(`program ${id} is not deployed`);
  return info.owner.equals(LOADER_V3) ? PublicKey.findProgramAddressSync([new PublicKey(id).toBuffer()], LOADER_V3)[0] : null;
}

async function check() {
  const sol = (await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;
  console.log(`deployer ${payer.publicKey.toBase58()}  balance ${sol} SOL on ${redactUrl(RPC)}`);
  // 0.15 Raydium pool fee + mint, metadata, vault and account rent + fees.
  let need = 0.5;
  // `solana program deploy` writes into a buffer first, which needs the same
  // rent again until the deploy closes it: the largest one is the peak.
  let buffer = 0;
  for (const [name, id] of PROGRAMS) {
    const deployed = await exists(new PublicKey(id));
    const size = readFileSync(join(ROOT, `target/deploy/${name}.so`)).length;
    const rent = (await conn.getMinimumBalanceForRentExemption(size + 45)) / LAMPORTS_PER_SOL;
    if (!deployed) {
      need += rent;
      buffer = Math.max(buffer, rent);
    }
    console.log(`  ${name.padEnd(9)} ${id}  ${deployed ? "deployed" : `not deployed — ~${rent.toFixed(2)} SOL`}`);
  }
  console.log(`  raydium   ${(await exists(RAYDIUM_CPMM.devnet)) ? "present" : "MISSING"}  metadata ${(await exists(TOKEN_METADATA)) ? "present" : "MISSING"}`);
  need += buffer;
  console.log(`needs about ${need.toFixed(2)} SOL at the peak (${buffer.toFixed(2)} of it a deploy buffer, refunded)`);
  if (sol < need) {
    console.log(`\nNOT ENOUGH SOL. Fund ${payer.publicKey.toBase58()} with ~${Math.ceil(need - sol)} SOL:`);
    console.log("  https://faucet.solana.com  (sign in with GitHub for a larger allowance)");
    console.log(`  or: solana airdrop 2 ${payer.publicKey.toBase58()} --url devnet   (rate-limited)`);
    return false;
  }
  return true;
}

async function programs() {
  record.deployer = payer.publicKey.toBase58();
  record.programs = {};
  for (const [name, id] of PROGRAMS) {
    record.programs[name] = id;
    if (await exists(new PublicKey(id))) {
      console.log(`  ${name}: already deployed at ${id}`);
      continue;
    }
    console.log(`  ${name}: deploying…`);
    execFileSync(
      "solana",
      ["program", "deploy", join(ROOT, `target/deploy/${name}.so`), "--program-id", join(ROOT, `keys/${name}-keypair.json`),
        "--keypair", KEYPAIR, "--url", RPC, "--use-rpc"],
      { stdio: "inherit" },
    );
  }
  save();
}

// Metaplex Token Metadata `CreateMetadataAccountV3`, built by hand: one
// instruction is not worth a dependency.
function metadataIx(mint, { name, symbol, uri }) {
  const str = (s) => {
    const b = Buffer.from(s, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    return Buffer.concat([len, b]);
  };
  const data = Buffer.concat([
    Buffer.from([33]), str(name), str(symbol), str(uri),
    Buffer.from([0, 0]), // seller fee bps
    Buffer.from([0, 0, 0]), // creators, collection, uses: none
    Buffer.from([1]), // is_mutable
    Buffer.from([0]), // collection_details: none
  ]);
  const metadata = PublicKey.findProgramAddressSync([Buffer.from("metadata"), TOKEN_METADATA.toBuffer(), mint.toBuffer()], TOKEN_METADATA)[0];
  return {
    metadata,
    ix: new TransactionInstruction({
      programId: TOKEN_METADATA,
      keys: [
        { pubkey: metadata, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    }),
  };
}

const MINTS = {
  index: { name: "Kadex Card Index (devnet test)", symbol: "tKDX", uri: "https://github.com/kadex-protocol/kadex/blob/main/docs/spec.md" },
  usd: { name: "Kadex Devnet USD (test, not USDC)", symbol: "kdUSD", uri: "https://github.com/kadex-protocol/kadex/blob/main/docs/deploying.md" },
};

async function mints() {
  record.mints ??= {};
  for (const [key, meta] of Object.entries(MINTS)) {
    const known = pk(record.mints[key]?.address);
    if (known && (await exists(known))) {
      console.log(`  ${key}: already ${known.toBase58()}`);
      continue;
    }
    // 6 decimals like USDC and FRACTION_DECIMALS; mint authority the deployer
    // (devnet only, to seed the pool); no freeze authority.
    const mint = await createMint(conn, payer, payer.publicKey, null, 6);
    const { metadata, ix } = metadataIx(mint, meta);
    record.mints[key] = { address: mint.toBase58(), decimals: 6, mintAuthority: payer.publicKey.toBase58(), freezeAuthority: null, metadata: null, ...meta };
    if (await exists(TOKEN_METADATA)) {
      note(`metadata_${key}`, await send(ix));
      record.mints[key].metadata = metadata.toBase58();
    } else {
      console.log(`  ${key}: Token Metadata is not on this cluster (local run) — no metadata`);
    }
    console.log(`  ${key}: ${mint.toBase58()}`);
  }
  save();
}

async function pool() {
  const index = new PublicKey(record.mints.index.address);
  const usd = new PublicKey(record.mints.usd.address);
  const a = poolAddresses(RAYDIUM_CPMM.devnet, AMM_CONFIG, index, usd);
  if (!(await exists(a.pool))) {
    // Pool address is a PDA of (config, mints): a second run cannot create a duplicate.
    for (const [mint, amount] of [[index, SEED.index], [usd, SEED.usd]]) {
      const account = await createAssociatedTokenAccountIdempotent(conn, payer, mint, payer.publicKey);
      const have = (await getAccount(conn, account)).amount;
      if (have < amount) await mintTo(conn, payer, mint, account, payer, amount - have);
    }
    const sig = await send(createPoolIx({
      program: RAYDIUM_CPMM.devnet, ammConfig: AMM_CONFIG, createPoolFee: RAYDIUM_CREATE_POOL_FEE.devnet,
      creator: payer.publicKey, mintA: index, mintB: usd, amountA: SEED.index, amountB: SEED.usd,
    }));
    note("create_pool", sig);
  } else {
    console.log(`  pool: already ${a.pool.toBase58()}`);
  }
  const { pool: decoded, reserves } = await readRaydium(conn, a.pool, index);
  record.raydium = {
    program: RAYDIUM_CPMM.devnet.toBase58(), ammConfig: AMM_CONFIG.toBase58(), tradeFee: "0.25%",
    pool: a.pool.toBase58(), authority: a.authority.toBase58(), lpMint: a.lpMint.toBase58(), observation: a.observation.toBase58(),
    vaults: decoded.vaults.map(String), mints: decoded.mints.map(String),
    seeded: { index: SEED.index.toString(), usd: SEED.usd.toString(), price: "1.000000" },
  };
  save();
  console.log(`  reserves  index ${reserves.fraction}  usd ${reserves.usdc}  spot ${Number(spotPrice(reserves)) / 1e6}`);
}

async function protocol() {
  const index = new PublicKey(record.mints.index.address);
  const usd = new PublicKey(record.mints.usd.address);
  const ammPool = new PublicKey(record.raydium.pool);
  const oracle = findOracle(index);
  if (!(await exists(oracle))) {
    const sig = await p.oracle.methods.initialize({ raydium: {} }, ORACLE_PARAMS)
      .accounts({ admin: payer.publicKey, programData: await programData(IDLS.oracle.address), basket: index, ammPool, oracle })
      .rpc();
    note("initialize_oracle", sig);
  }
  const extra = refreshAccounts(decodePool(ammPool, RAYDIUM_CPMM.devnet, (await conn.getAccountInfo(ammPool)).data));
  note("refresh_price_initial", await send(refreshPriceIx(payer.publicKey, oracle, ammPool, extra)));

  const clp = findPool(usd);
  if (!(await exists(clp))) {
    const clpMint = await createMint(conn, payer, clp, null, 6);
    const usdcVault = await createAccount(conn, payer, usd, clp, Keypair.generate());
    const fractionVault = await createAccount(conn, payer, index, clp, Keypair.generate());
    const sig = await p.clpPool.methods.initializePool(DEFAULT_POOL_PARAMS)
      .accounts({ admin: payer.publicKey, programData: await programData(IDLS.clpPool.address), usdcMint: usd, clpMint, usdcVault, fractionMint: index, fractionVault, oracle, pool: clp })
      .rpc();
    note("initialize_pool", sig);
  }
  const market = findMarket(clp);
  if (!(await exists(market))) {
    note("initialize_market", await p.perp.methods.initializeMarket().accounts({ admin: payer.publicKey, pool: clp, oracle, market }).rpc());
    note("set_perp_market", await p.clpPool.methods.setPerpMarket(market).accounts({ admin: payer.publicKey, pool: clp }).rpc());
  }
  const decoded = decodeClpPool((await conn.getAccountInfo(clp)).data);
  record.protocol = { oracle: oracle.toBase58(), clpPool: clp.toBase58(), clpMint: decoded.clpMint.toBase58(), usdcVault: decoded.usdcVault.toBase58(), fractionVault: decoded.fractionVault.toBase58(), market: market.toBase58() };
  save();
}

async function verify() {
  const index = new PublicKey(record.mints.index.address);
  const usd = new PublicKey(record.mints.usd.address);
  const ammPool = new PublicKey(record.raydium.pool);
  const oracle = new PublicKey(record.protocol.oracle);
  const extra = record.raydium.vaults.map((v) => new PublicKey(v));

  note("verify_refresh", await send(refreshPriceIx(payer.publicKey, oracle, ammPool, extra)));
  const o = decodeOracle((await conn.getAccountInfo(oracle)).data);
  const { reserves } = await readRaydium(conn, ammPool, index);
  const ts = spotPrice(reserves);
  console.log(`  program spot ${o.spot}  TypeScript spot ${ts}  ${o.spot === ts ? "AGREE" : "DISAGREE"}`);
  console.log(`  price ${o.price}  twap ${o.twap}  depth ${o.depthUsdc}  state ${o.state}`);
  if (o.spot !== ts) throw new Error("Rust and TypeScript read different reserves");
  if (o.state !== "ok") throw new Error(`oracle state is ${o.state}, not ok`);

  // The perp market consumes it: deposit into the CLP, open and close a small long.
  const clp = new PublicKey(record.protocol.clpPool);
  const pool = decodeClpPool((await conn.getAccountInfo(clp)).data);
  const mine = { usdc: findAta(payer.publicKey, usd), fractions: findAta(payer.publicKey, index), clp: findAta(payer.publicKey, pool.clpMint) };
  await createAssociatedTokenAccountIdempotent(conn, payer, pool.clpMint, payer.publicKey);
  const have = (await getAccount(conn, mine.usdc)).amount;
  if (have < 20_000n * USDC) await mintTo(conn, payer, usd, mine.usdc, payer, 20_000n * USDC - have);
  if (pool.usdcSleeve < 10_000n * USDC) note("deposit_usdc", await send(depositUsdcIx({ address: clp, pool }, payer.publicKey, mine, 10_000n * USDC)));

  const accounts = { market: new PublicKey(record.protocol.market), pool: clp, oracle, usdcVault: pool.usdcVault };
  const nonce = BigInt(Date.now());
  const order = { nonce, side: "long", notional: 100n * USDC, margin: 25n * USDC };
  note("open_position", await send(refreshPriceIx(payer.publicKey, oracle, ammPool, extra), openPositionIx(accounts, payer.publicKey, mine.usdc, order)));
  const position = findPosition(accounts.market, payer.publicKey, nonce);
  const entry = await p.perp.account.position.fetch(position);
  console.log(`  position entry ${entry.entryPrice.toString()} = oracle price ${decodeOracle((await conn.getAccountInfo(oracle)).data).price}`);
  note("close_position", await send(closePositionIx(accounts, payer.publicKey, position, mine.usdc)));
}

async function env() {
  const usd = new PublicKey(record.mints.usd.address);
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split("\n") : [];
  const saved = lines.find((line) => line.startsWith("KADEX_FAUCET_KEYPAIR=["))?.slice("KADEX_FAUCET_KEYPAIR=".length);
  let faucet = saved ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved))) : Keypair.generate();
  if (faucet.publicKey.equals(payer.publicKey)) faucet = Keypair.generate();

  if ((await conn.getBalance(faucet.publicKey)) < (FAUCET.sol * LAMPORTS_PER_SOL) / 2) {
    note("fund_faucet_sol", await send(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: faucet.publicKey, lamports: FAUCET.sol * LAMPORTS_PER_SOL })));
  }
  const account = await createAssociatedTokenAccountIdempotent(conn, payer, usd, faucet.publicKey);
  const have = (await getAccount(conn, account)).amount;
  if (have < FAUCET.usd / 2n) note("fund_faucet_usd", await mintTo(conn, payer, usd, account, payer, FAUCET.usd - have));

  // Rewrite only the lines this script owns: anything else in the file is the user's.
  const ours = {
    NEXT_PUBLIC_KADEX_RPC_URL: process.env.KADEX_BROWSER_RPC ?? RPC,
    NEXT_PUBLIC_KADEX_USDC_MINT: usd.toBase58(),
    NEXT_PUBLIC_KADEX_NETWORK: NETWORK,
    KADEX_FAUCET_KEYPAIR: JSON.stringify([...faucet.secretKey]),
  };
  const kept = lines.filter((line) => line.trim() && !(line.split("=")[0].trim() in ours));
  writeFileSync(ENV_FILE, [...kept, ...Object.entries(ours).map(([k, v]) => `${k}=${v}`)].join("\n") + "\n");
  record.faucet = { address: faucet.publicKey.toBase58() };
  save();
  console.log(`  faucet ${faucet.publicKey.toBase58()}  wrote ${ENV_FILE}`);
}

async function cards() {
  const owner = pk(process.argv[3]);
  if (!owner) throw new Error("usage: node scripts/devnet.mjs cards <wallet that will own the test cards>");
  await mirrorCards({ conn, payer, vault: p.cardVault, programData: await programData(IDLS.cardVault.address), owner, record, save });
}

async function fund() {
  const wallet = pk(process.argv[3]);
  if (!wallet) throw new Error("usage: node scripts/devnet.mjs fund <wallet> [usd]");
  const amount = BigInt(process.argv[4] ?? 10_000) * USDC;
  const usd = new PublicKey(record.mints.usd.address);
  const account = await createAssociatedTokenAccountIdempotent(conn, payer, usd, wallet);
  await mintTo(conn, payer, usd, account, payer, amount);
  console.log(`  minted ${amount / USDC} kdUSD to ${wallet.toBase58()}`);
}

const steps = { check, programs, mints, pool, protocol, verify, env, cards, fund };
const which = process.argv[2] ?? "check";
if (which === "all") {
  if (!(await check())) process.exit(1);
  for (const s of ["programs", "mints", "pool", "protocol", "verify", "env"]) {
    console.log(`\n== ${s}`);
    await steps[s]();
  }
} else if (steps[which]) {
  const ok = await steps[which]();
  if (ok === false) process.exit(1);
} else {
  console.error(`unknown step ${which}; one of ${Object.keys(steps).join(", ")}, all`);
  process.exit(1);
}
