/**
 * Raydium CPMM reader in TypeScript, held to the same captured devnet pool as
 * the Rust tests in programs/oracle/src/adapter.rs, with the same expected
 * numbers and the same refusals. If the two readers drift, one of the two
 * suites fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  AdapterError,
  INITIALIZE_DISCRIMINATOR,
  POOL_DISCRIMINATOR,
  RAYDIUM_CPMM,
  TOKEN_2022,
  createPoolIx,
  decodePool,
  poolAddresses,
  poolAuthority,
  reservesOf,
  sortMints,
} from "../packages/oracle/dist/raydium.js";
import { spotPrice } from "../packages/oracle/dist/index.js";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/raydium_cpmm_pool.json", import.meta.url), "utf8"));

// The same constants as the Rust tests, read off the fixture independently.
const MINT_0 = new PublicKey("5W1Mg5LYmczXTGAqjSoTeMi7tXUQx3bfXsLr1MKvV1Tk");
const MINT_1 = new PublicKey("7rCj8wm31rhSDvSvK2kc9NUSXwvPNChx6R3HYNM6MqxP");
const AUTHORITY = new PublicKey("CXniRufdq5xL8t8jZAPxsPZDpuudwuJSPWnbcD5Y5Nxq");
const USABLE_0 = 1_045_469_077_015n;
const USABLE_1 = 5_194_267_751_955n;
const RAW_0 = 1_045_956_063_151n;

function real() {
  const one = (a) => ({
    address: new PublicKey(a.pubkey),
    owner: new PublicKey(a.account.owner),
    data: Uint8Array.from(Buffer.from(a.account.data[0], "base64")),
  });
  return { pool: one(FIXTURE.pool), vaults: [one(FIXTURE.vault0), one(FIXTURE.vault1)] };
}

const read = (a, basket = MINT_0) => reservesOf(decodePool(a.pool.address, a.pool.owner, a.pool.data), a.vaults, basket);
const refuses = (fn, code) => assert.throws(fn, (e) => e instanceof AdapterError && e.code === code, `expected ${code}`);
const anchorDisc = (s) => [...createHash("sha256").update(s).digest().subarray(0, 8)];

test("discriminators are the ones Anchor derives", () => {
  assert.deepEqual([...POOL_DISCRIMINATOR], anchorDisc("account:PoolState"));
  assert.deepEqual([...INITIALIZE_DISCRIMINATOR], anchorDisc("global:initialize"));
});

test("a real pool reads its reserves net of owed fees — same numbers as the Rust", () => {
  assert.deepEqual(read(real()), { fraction: USABLE_0, usdc: USABLE_1 });
  assert.ok(RAW_0 > USABLE_0);
});

test("the basket mint decides which side is USDC", () => {
  assert.deepEqual(read(real(), MINT_1), { fraction: USABLE_1, usdc: USABLE_0 });
});

test("the price is usdc over index in WAD — same as the Rust", () => {
  assert.equal(spotPrice(read(real())), 4_968_360n);
});

test("the vault authority is Raydium's PDA from the pool's bump", () => {
  const a = real();
  assert.ok(poolAuthority(decodePool(a.pool.address, a.pool.owner, a.pool.data)).equals(AUTHORITY));
});

test("NEGATIVE: a pool not owned by Raydium", () => {
  const a = real();
  a.pool.owner = Keypair.generate().publicKey;
  refuses(() => read(a), "AdapterBadAccount");
});

test("NEGATIVE: a basket the pool does not pair", () => refuses(() => read(real(), Keypair.generate().publicKey), "AdapterWrongMint"));

test("NEGATIVE: swapped vaults", () => {
  const a = real();
  a.vaults.reverse();
  refuses(() => read(a), "AdapterWrongVault");
});

test("NEGATIVE: a substitute vault, even with the right mint", () => {
  const a = real();
  a.vaults[1].address = Keypair.generate().publicKey;
  refuses(() => read(a), "AdapterWrongVault");
});

test("NEGATIVE: missing vaults", () => {
  const a = real();
  a.vaults = [];
  refuses(() => read(a), "AdapterWrongVault");
});

test("NEGATIVE: a vault holding another mint", () => {
  const a = real();
  a.vaults[1].data.set(Keypair.generate().publicKey.toBytes(), 0);
  refuses(() => read(a), "AdapterWrongMint");
});

test("NEGATIVE: a vault owned by someone other than Raydium's authority", () => {
  const a = real();
  a.vaults[0].data.set(Keypair.generate().publicKey.toBytes(), 32);
  refuses(() => read(a), "AdapterWrongAuthority");
});

test("NEGATIVE: a vault not held by the token program", () => {
  const a = real();
  a.vaults[0].owner = Keypair.generate().publicKey;
  refuses(() => read(a), "AdapterWrongVault");
});

test("NEGATIVE: a frozen vault", () => {
  const a = real();
  a.vaults[0].data[108] = 2;
  refuses(() => read(a), "AdapterWrongVault");
});

test("NEGATIVE: wrong discriminator or length", () => {
  const a = real();
  a.pool.data[0] ^= 1;
  refuses(() => read(a), "AdapterBadAccount");
  const b = real();
  b.pool.data = b.pool.data.subarray(0, 636);
  refuses(() => read(b), "AdapterBadAccount");
});

test("NEGATIVE: other decimals are refused, not rescaled", () => {
  const a = real();
  a.pool.data[331] = 9;
  refuses(() => read(a), "AdapterUnsupportedToken");
});

test("NEGATIVE: a Token-2022 side", () => {
  const a = real();
  a.pool.data.set(TOKEN_2022.toBytes(), 264);
  refuses(() => read(a), "AdapterUnsupportedToken");
});

test("NEGATIVE: swaps disabled", () => {
  const a = real();
  a.pool.data[329] |= 1 << 2;
  refuses(() => read(a), "AdapterPoolDisabled");
});

test("NEGATIVE: fees above the vault balance are refused, not wrapped", () => {
  const a = real();
  new DataView(a.pool.data.buffer).setBigUint64(341, RAW_0 + 1n, true);
  refuses(() => read(a), "AdapterInsufficientVault");
});

test("NEGATIVE: fee counters that overflow u64", () => {
  const a = real();
  const v = new DataView(a.pool.data.buffer);
  v.setBigUint64(341, (1n << 64n) - 1n, true);
  v.setBigUint64(357, 1n, true);
  refuses(() => read(a), "AdapterBadAccount");
});

test("NEGATIVE: a pool pairing one mint with itself", () => {
  const a = real();
  a.pool.data.set(a.pool.data.slice(168, 200), 200);
  refuses(() => read(a), "AdapterWrongMint");
});

test("pool addresses derive to the ones the real pool records", () => {
  const a = real();
  const p = decodePool(a.pool.address, a.pool.owner, a.pool.data);
  const d = poolAddresses(RAYDIUM_CPMM.devnet, p.ammConfig, MINT_1, MINT_0);
  assert.ok(d.pool.equals(a.pool.address), "pool PDA");
  assert.ok(d.vault0.equals(p.vaults[0]) && d.vault1.equals(p.vaults[1]), "vault PDAs");
  assert.ok(d.lpMint.equals(p.lpMint), "lp mint PDA");
  assert.ok(d.observation.equals(p.observation), "observation PDA");
  assert.ok(d.authority.equals(AUTHORITY), "authority PDA");
});

test("createPoolIx sorts the mints and keeps each amount with its mint", () => {
  const [lo, hi] = sortMints(MINT_1, MINT_0);
  assert.ok(lo.equals(MINT_0) && hi.equals(MINT_1));
  const ix = createPoolIx({
    program: RAYDIUM_CPMM.devnet,
    ammConfig: Keypair.generate().publicKey,
    createPoolFee: Keypair.generate().publicKey,
    creator: Keypair.generate().publicKey,
    mintA: MINT_1,
    mintB: MINT_0,
    amountA: 111n,
    amountB: 222n,
  });
  assert.equal(ix.keys.length, 20);
  assert.ok(ix.keys[4].pubkey.equals(MINT_0) && ix.keys[5].pubkey.equals(MINT_1));
  assert.equal(ix.data.readBigUInt64LE(8), 222n, "amount 0 belongs to mint 0");
  assert.equal(ix.data.readBigUInt64LE(16), 111n, "amount 1 belongs to mint 1");
});
