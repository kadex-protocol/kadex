/**
 * Shared setup for integration tests against a live `solana-test-validator`.
 *
 * Launched by `scripts/with-validator.mjs`, which deploys all five programs at
 * their fixed addresses before any of this runs.
 *
 * These tests are slower than the `cargo test` suite by three orders of
 * magnitude, so they earn their place only by testing what pure tests cannot:
 * account validation, signer constraints, CPI authority, and the state machine
 * against the binary we actually deploy.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

const require = createRequire(import.meta.url);

export const RPC_URL = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
export const USDC = 1_000_000n;
export const WAD = 1_000_000n;

export const IDLS = {
  oracle: require("../../target/idl/oracle.json"),
  mockAmm: require("../../target/idl/mock_amm.json"),
  clpPool: require("../../target/idl/clp_pool.json"),
  perp: require("../../target/idl/perp.json"),
  cardVault: require("../../target/idl/card_vault.json"),
};

/** PDA seeds — must match `kadex_interface::seeds`. */
export const SEEDS = {
  oracle: Buffer.from("oracle"),
  pool: Buffer.from("pool"),
  market: Buffer.from("market"),
  position: Buffer.from("position"),
};

export function findOracle(basket) {
  return PublicKey.findProgramAddressSync(
    [SEEDS.oracle, basket.toBuffer()],
    new PublicKey(IDLS.oracle.address),
  )[0];
}

/**
 * The programs' upgrade authority, handed over by `with-validator.mjs`.
 *
 * Every `initialize_*` is restricted to it, so the provider every suite uses
 * IS the deployer: it creates pools and oracles and performs admin steps.
 * Strangers and attackers are separate `funded()` keypairs.
 */
function deployer() {
  const path = process.env.KADEX_DEPLOYER;
  if (!path) throw new Error("KADEX_DEPLOYER unset: run through scripts/with-validator.mjs");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A funded wallet and an Anchor provider bound to it. */
export async function newProvider() {
  const conn = new Connection(RPC_URL, "confirmed");
  const payer = deployer();
  const sig = await conn.requestAirdrop(payer.publicKey, 100 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(conn, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  return { conn, payer, provider };
}

export function programs(provider) {
  return {
    oracle: new anchor.Program(IDLS.oracle, provider),
    mockAmm: new anchor.Program(IDLS.mockAmm, provider),
    clpPool: new anchor.Program(IDLS.clpPool, provider),
    perp: new anchor.Program(IDLS.perp, provider),
  };
}

/** Fund a fresh keypair so it can pay for its own transactions. */
export async function funded(conn, sol = 10) {
  const kp = Keypair.generate();
  const sig = await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
  return kp;
}

/**
 * Production defences, on a clock a test can wait out: the clamp is 5% per
 * SECOND and the TWAP window two seconds, where production uses 5% per 15s
 * and 30 minutes. The mechanics are identical; only the time scale differs,
 * because a local validator cannot warp its clock.
 */
export const DEFAULT_ORACLE_PARAMS = {
  twapWindowSecs: 2,
  maxTickMove: new anchor.BN(50_000),
  maxStalenessSecs: 900,
  minPoolDepth: new anchor.BN(25_000_000_000),
  maxDivergence: new anchor.BN(150_000),
  slowAlpha: new anchor.BN(10_000),
  clampPeriodSecs: 1,
};

/**
 * Create a mock AMM pool and an oracle bound to it, refreshed once.
 *
 * `usdc` and `fraction` are in native units. 60k against 60k is $1.00 per
 * fraction, which is what every test starts from unless it says otherwise.
 */
export async function setupOracle(
  { conn, provider, p },
  usdc = 60_000n * USDC,
  fraction = 60_000n * USDC,
  params = DEFAULT_ORACLE_PARAMS,
) {
  const pool = Keypair.generate();
  const basket = Keypair.generate().publicKey;
  const oracle = findOracle(basket);

  await p.mockAmm.methods
    .createPool(new anchor.BN(usdc.toString()), new anchor.BN(fraction.toString()))
    .accounts({ payer: provider.wallet.publicKey, pool: pool.publicKey })
    .signers([pool])
    .rpc();

  await p.oracle.methods
    .initialize({ mock: {} }, params)
    .accounts({
      admin: provider.wallet.publicKey,
      programData: null,
      basket,
      ammPool: pool.publicKey,
      oracle,
    })
    .rpc();

  return { ammPool: pool.publicKey, basket, oracle };
}

export async function refresh({ provider, p }, { oracle, ammPool }) {
  return p.oracle.methods
    .refreshPrice()
    .accounts({ caller: provider.wallet.publicKey, oracle, ammPool })
    .rpc();
}

/** Refresh once a second for `n` seconds, so the clamp can let the price move. */
export async function refreshOver(ctx, env, n) {
  for (let i = 0; i < n; i += 1) {
    await sleep(1_100);
    await refresh(ctx, env);
  }
}

export async function swapUsdcIn({ provider, p }, pool, amount) {
  return p.mockAmm.methods
    .swap(new anchor.BN(amount.toString()), new anchor.BN(0))
    .accounts({ caller: provider.wallet.publicKey, pool })
    .rpc();
}

export async function removeLiquidity({ provider, p }, pool, usdc) {
  return p.mockAmm.methods
    .removeLiquidity(new anchor.BN(usdc.toString()))
    .accounts({ caller: provider.wallet.publicKey, pool })
    .rpc();
}

/** The oracle's state enum arrives as `{ ok: {} }`; flatten it to a string. */
export function stateName(state) {
  return Object.keys(state)[0];
}

/** Assert a transaction fails, and return its message for inspection. */
export async function mustFail(promise, what) {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error(`expected a failure: ${what}`);
}

// ---------------------------------------------------------------------------
// SPL token + pool/market setup for the lifecycle tests
// ---------------------------------------------------------------------------

import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";

export function findPool(usdcMint) {
  return PublicKey.findProgramAddressSync(
    [SEEDS.pool, usdcMint.toBuffer()],
    new PublicKey(IDLS.clpPool.address),
  )[0];
}

export function findMarket(pool) {
  return PublicKey.findProgramAddressSync(
    [SEEDS.market, pool.toBuffer()],
    new PublicKey(IDLS.perp.address),
  )[0];
}

export function findPosition(market, owner, nonce) {
  const n = Buffer.alloc(8);
  n.writeBigUInt64LE(BigInt(nonce));
  return PublicKey.findProgramAddressSync(
    [SEEDS.position, market.toBuffer(), owner.toBuffer(), n],
    new PublicKey(IDLS.perp.address),
  )[0];
}

export const DEFAULT_POOL_PARAMS = {
  cardSleeveTarget: new anchor.BN(300_000),
  phi: new anchor.BN(500_000),
  deltaMax: new anchor.BN(300_000),
  mu: new anchor.BN(300_000),
  deltaLiq: new anchor.BN(187_500),
  baseLeverage: new anchor.BN(5_000_000),
  maintenanceMargin: new anchor.BN(62_500),
  r0: new anchor.BN(50),
  r1: new anchor.BN(500),
  psi: new anchor.BN(500_000),
  openCloseFeeBps: 10,
  liquidatorFeeBps: 100,
  depositHaircutBps: 300,
  maxCardWeight: new anchor.BN(150_000),
  lpFeeShareBps: 7500,
  reduceOnlyUtilization: new anchor.BN(950_000),
  attackSafety: new anchor.BN(2_000_000),
};

/**
 * Stand up the whole protocol: mints, vaults, pool, market, oracle.
 *
 * The CLP mint and both vaults are created with the pool PDA as authority
 * before `initialize_pool` runs, because the program never takes authority of
 * an account it did not already own — it only records the addresses.
 */
export async function setupProtocol(
  ctx,
  { usdc = 60_000n * USDC, fraction = 60_000n * USDC, oracleParams = DEFAULT_ORACLE_PARAMS } = {},
) {
  const { conn, payer, provider, p } = ctx;
  const oracleEnv = await setupOracle(ctx, usdc, fraction, oracleParams);
  await refresh(ctx, oracleEnv);

  const usdcMint = await createMint(conn, payer, payer.publicKey, null, 6);
  const pool = findPool(usdcMint);

  // Authority is the pool PDA from the start.
  const clpMint = await createMint(conn, payer, pool, null, 6);
  const fractionMint = await createMint(conn, payer, payer.publicKey, null, 6);
  const usdcVault = await createAccount(conn, payer, usdcMint, pool, Keypair.generate());
  const fractionVault = await createAccount(conn, payer, fractionMint, pool, Keypair.generate());

  await p.clpPool.methods
    .initializePool(DEFAULT_POOL_PARAMS)
    .accounts({
      admin: provider.wallet.publicKey,
      programData: null,
      usdcMint,
      clpMint,
      usdcVault,
      fractionMint,
      fractionVault,
      oracle: oracleEnv.oracle,
      pool,
    })
    .rpc();

  const market = findMarket(pool);
  await p.perp.methods
    .initializeMarket()
    .accounts({ admin: provider.wallet.publicKey, pool, oracle: oracleEnv.oracle, market })
    .rpc();

  // Only this PDA may ask the pool to pay out.
  await p.clpPool.methods
    .setPerpMarket(market)
    .accounts({ admin: provider.wallet.publicKey, pool })
    .rpc();

  // `ammPool` from the oracle env and `pool` here are different accounts;
  // they used to share a key and the AMM address was silently overwritten.
  return { ...oracleEnv, usdcMint, clpMint, fractionMint, usdcVault, fractionVault, pool, market };
}

/** A funded actor with USDC, CLP and fraction token accounts. */
export async function actor(ctx, env, usdcAmount = 0n) {
  const { conn, payer } = ctx;
  const kp = await funded(conn, 20);
  const usdcAcct = await createAccount(conn, payer, env.usdcMint, kp.publicKey, Keypair.generate());
  const clpAcct = await createAccount(conn, payer, env.clpMint, kp.publicKey, Keypair.generate());
  const fracAcct = await createAccount(conn, payer, env.fractionMint, kp.publicKey, Keypair.generate());
  if (usdcAmount > 0n) {
    await mintTo(conn, payer, env.usdcMint, usdcAcct, payer, usdcAmount);
  }
  return { kp, usdc: usdcAcct, clp: clpAcct, fractions: fracAcct };
}

export async function balance(conn, account) {
  return (await getAccount(conn, account)).amount;
}

export { TOKEN_PROGRAM_ID };
