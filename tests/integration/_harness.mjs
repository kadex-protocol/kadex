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

/** PDA seeds — must match `slab_interface::seeds`. */
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

/** A funded wallet and an Anchor provider bound to it. */
export async function newProvider() {
  const conn = new Connection(RPC_URL, "confirmed");
  const payer = Keypair.generate();
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

export const DEFAULT_ORACLE_PARAMS = {
  twapWindowSecs: 1800,
  maxTickMove: new anchor.BN(50_000),
  maxStalenessSecs: 900,
  minPoolDepth: new anchor.BN(25_000_000_000),
  maxDivergence: new anchor.BN(150_000),
};

/**
 * Create a mock AMM pool and an oracle bound to it, refreshed once.
 *
 * `usdc` and `fraction` are in native units. 60k against 60k is $1.00 per
 * fraction, which is what every test starts from unless it says otherwise.
 */
export async function setupOracle({ conn, provider, p }, usdc = 60_000n * USDC, fraction = 60_000n * USDC) {
  const pool = Keypair.generate();
  const basket = Keypair.generate().publicKey;
  const oracle = findOracle(basket);

  await p.mockAmm.methods
    .createPool(new anchor.BN(usdc.toString()), new anchor.BN(fraction.toString()))
    .accounts({ payer: provider.wallet.publicKey, pool: pool.publicKey })
    .signers([pool])
    .rpc();

  await p.oracle.methods
    .initialize({ mock: {} }, DEFAULT_ORACLE_PARAMS)
    .accounts({
      admin: provider.wallet.publicKey,
      basket,
      ammPool: pool.publicKey,
      oracle,
    })
    .rpc();

  return { pool: pool.publicKey, basket, oracle };
}

export async function refresh({ provider, p }, { oracle, pool }) {
  return p.oracle.methods
    .refreshPrice()
    .accounts({ caller: provider.wallet.publicKey, oracle, ammPool: pool })
    .rpc();
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
