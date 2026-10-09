/**
 * The oracle reading a REAL Raydium CPMM pool, end to end on a validator.
 *
 * The pool is created by Raydium's own program (devnet binary, loaded from
 * tests/fixtures/raydium_cpmm.so), swaps go through it, and fees accrue in
 * it. Nothing here is a mock of Raydium: if the adapter misreads the layout,
 * the vaults or the fees, these tests see a different number from the one
 * Raydium's own accounts hold.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { createAccount } from "@solana/spl-token";
import {
  USDC,
  IDLS,
  DEFAULT_ORACLE_PARAMS,
  findOracle,
  newProvider,
  programs,
  refresh,
  setupProtocol,
  setupRaydiumOracle,
  sendIxs,
  mustFail,
  sleep,
  stateName,
  RAYDIUM_AMM_CONFIG_0,
} from "./_harness.mjs";
import { decodePool, readRaydium, spotPrice, swapBaseInputIx, raydiumAdapter } from "../../packages/oracle/dist/index.js";
import {
  closePositionIx,
  decodeOracle,
  findAta,
  openPositionIx,
  refreshAccountsFor,
  refreshPriceIx,
} from "../../packages/sdk/dist/chain.js";

// One provider for the file, and its websocket closed at the end: a
// confirmation subscription can outlive its transaction and hold the test
// process open (seen in a diagnostic report as a live TCP socket to :8900).
let shared;
const context = async () => {
  if (!shared) {
    shared = await newProvider();
    shared.p = programs(shared.provider);
  }
  return shared;
};
after(() => shared?.conn._rpcWebSocket?.close());

/**
 * The refusal is the oracle's named error. Depending on whether preflight
 * caught it, the message carries the name, `custom program error: 0x…` or
 * `{"Custom":6008}`, so the code is read from the IDL and matched in all three.
 */
const ORACLE_ERRORS = Object.fromEntries(IDLS.oracle.errors.map((e) => [e.name, e.code]));
function refusedWith(msg, name) {
  const code = ORACLE_ERRORS[name.charAt(0).toLowerCase() + name.slice(1)] ?? ORACLE_ERRORS[name];
  assert.ok(code, `no oracle error ${name}`);
  const forms = [name, `0x${code.toString(16)}`, `"Custom":${code}`];
  assert.ok(forms.some((f) => msg.includes(f)), `expected ${name} (${code}), got: ${msg.slice(0, 300)}`);
}

describe("oracle on a real Raydium CPMM pool", () => {
  let ctx, env;

  const oracleNow = async () => decodeOracle((await ctx.conn.getAccountInfo(env.oracle)).data);
  const poolNow = async () => {
    const info = await ctx.conn.getAccountInfo(env.ammPool);
    return decodePool(env.ammPool, info.owner, info.data);
  };
  const swap = (inputMint, amountIn) =>
    poolNow().then((pool) =>
      sendIxs(ctx.conn, [ctx.payer], swapBaseInputIx({ pool, payer: ctx.payer.publicKey, inputMint, amountIn })),
    );

  before(async () => {
    ctx = await context();
    env = await setupRaydiumOracle(ctx);
  });

  test("the pool exists, holds both sides, and pairs the index mint with USDC", async () => {
    const pool = await poolNow();
    assert.ok(pool.program.equals(env.raydium.program));
    assert.ok(pool.mints.some((m) => m.equals(env.indexMint)) && pool.mints.some((m) => m.equals(env.usdcMint)));
    const { reserves } = await readRaydium(ctx.conn, env.ammPool, env.indexMint);
    assert.deepEqual(reserves, { usdc: 60_000n * USDC, fraction: 60_000n * USDC });
  });

  test("refresh_price reads the pool's vaults and publishes $1.00", async () => {
    await refresh(ctx, env);
    const o = await oracleNow();
    assert.equal(o.adapter, "raydium");
    assert.equal(o.spot, 1_000_000n);
    assert.equal(o.price, 1_000_000n);
    assert.equal(o.depthUsdc, 60_000n * USDC);
    assert.equal(o.state, "ok");
  });

  test("the TypeScript adapter and the program agree after a real swap, fees included", async () => {
    await swap(env.usdcMint, 3_000n * USDC);
    await sleep(500);
    await refresh(ctx, env);
    const o = await oracleNow();
    const pool = await poolNow();
    const { reserves } = await readRaydium(ctx.conn, env.ammPool, env.indexMint);
    assert.ok(pool.fees[0] + pool.fees[1] > 0n, "the swap left protocol/fund fees owed in the pool");
    assert.equal(o.spot, spotPrice(reserves), "program and TypeScript read the same spot");
    assert.ok(o.spot > 1_000_000n, "buying the index with USDC raised its price");
    assert.deepEqual(await raydiumAdapter.readReserves(ctx.conn, env.ammPool, env.indexMint), reserves);
  });

  test("the existing clamp still holds a real price move to one step per period", async () => {
    const before = (await oracleNow()).price;
    await swap(env.usdcMint, 20_000n * USDC); // ~+75% spot
    // The new spot enters the TWAP only from the next refresh, so it takes
    // two refreshes a period apart before the TWAP sees it.
    await sleep(1_100);
    await refresh(ctx, env);
    const first = await oracleNow();
    assert.ok(first.spot > (before * 15n) / 10n, "spot jumped");
    assert.ok(first.price <= (before * 1_050_000n) / 1_000_000n + 1n, `one step at most, got ${first.price} from ${before}`);
    await sleep(1_100);
    await refresh(ctx, env);
    const o = await oracleNow();
    assert.ok(o.twap > o.price, "the TWAP has moved past what the clamp lets through");
    assert.ok(o.price <= (first.price * 1_050_000n) / 1_000_000n + 1n, `one step per period, got ${o.price} from ${first.price}`);
    assert.equal(o.state, "catchingUp", "the oracle says it is behind the market");
  });

  test("SDK refreshAccountsFor finds the vaults, and the SDK instruction refreshes", async () => {
    const o = await oracleNow();
    const extra = await refreshAccountsFor(ctx.conn, o);
    assert.deepEqual(extra.map(String), env.refreshAccounts.map(String));
    await sleep(1_100);
    await sendIxs(ctx.conn, [ctx.payer], refreshPriceIx(ctx.payer.publicKey, env.oracle, env.ammPool, extra));
  });

  test("NEGATIVE: refresh without the vaults is refused", async () => {
    await sleep(500);
    const msg = await mustFail(
      sendIxs(ctx.conn, [ctx.payer], refreshPriceIx(ctx.payer.publicKey, env.oracle, env.ammPool)),
      "refresh with no vaults",
    );
    refusedWith(msg, "AdapterWrongVault");
  });

  test("NEGATIVE: refresh with the vaults swapped is refused", async () => {
    await sleep(500);
    const msg = await mustFail(
      sendIxs(ctx.conn, [ctx.payer], refreshPriceIx(ctx.payer.publicKey, env.oracle, env.ammPool, [...env.refreshAccounts].reverse())),
      "swapped vaults",
    );
    refusedWith(msg, "AdapterWrongVault");
  });

  test("NEGATIVE: a look-alike vault holding the right mint, owned by an attacker, is refused", async () => {
    await sleep(500);
    const forged = await createAccount(ctx.conn, ctx.payer, env.usdcMint, ctx.payer.publicKey, Keypair.generate());
    const side = env.raydium.mints[0].equals(env.usdcMint) ? 0 : 1;
    const extra = [...env.refreshAccounts];
    extra[side] = forged;
    const msg = await mustFail(
      sendIxs(ctx.conn, [ctx.payer], refreshPriceIx(ctx.payer.publicKey, env.oracle, env.ammPool, extra)),
      "forged vault",
    );
    refusedWith(msg, "AdapterWrongVault");
  });

  test("NEGATIVE: an oracle cannot be created for a basket the pool does not pair", async () => {
    const stranger = Keypair.generate().publicKey;
    const msg = await mustFail(
      ctx.p.oracle.methods
        .initialize({ raydium: {} }, DEFAULT_ORACLE_PARAMS)
        .accounts({ admin: ctx.provider.wallet.publicKey, programData: null, basket: stranger, ammPool: env.ammPool, oracle: findOracle(stranger) })
        .rpc(),
      "oracle for an unpaired basket",
    );
    refusedWith(msg, "AdapterWrongMint");
  });

  test("NEGATIVE: an oracle cannot be created on a pool Raydium does not own", async () => {
    const basket = env.indexMint;
    const fakePool = Keypair.generate().publicKey;
    const other = Keypair.generate().publicKey;
    const msg = await mustFail(
      ctx.p.oracle.methods
        .initialize({ raydium: {} }, DEFAULT_ORACLE_PARAMS)
        .accounts({ admin: ctx.provider.wallet.publicKey, programData: null, basket: other, ammPool: fakePool, oracle: findOracle(other) })
        .rpc(),
      "oracle on a non-Raydium pool",
    );
    refusedWith(msg, "AdapterBadAccount");
    assert.ok(basket);
  });
});

describe("the perp market consumes a Raydium-priced oracle", () => {
  let ctx, env, trader;

  before(async () => {
    ctx = await context();
    const oracleEnv = await setupRaydiumOracle(ctx);
    env = await setupProtocol(ctx, { oracleEnv, usdcMint: oracleEnv.usdcMint, fractionMint: oracleEnv.indexMint });
    trader = ctx.payer;
    // The pool needs USDC in its sleeve to back positions.
    const { depositUsdcIx } = await import("../../packages/sdk/dist/chain.js");
    const { decodePool: decodeClp } = await import("../../packages/sdk/dist/chain.js");
    const clp = decodeClp((await ctx.conn.getAccountInfo(env.pool)).data);
    const { createAssociatedTokenAccountIdempotentInstruction } = await import("@solana/spl-token");
    await sendIxs(
      ctx.conn,
      [trader],
      createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, findAta(trader.publicKey, env.clpMint), trader.publicKey, env.clpMint),
      depositUsdcIx(
        { address: env.pool, pool: clp },
        trader.publicKey,
        { usdc: findAta(trader.publicKey, env.usdcMint), fractions: findAta(trader.publicKey, env.indexMint), clp: findAta(trader.publicKey, env.clpMint) },
        100_000n * USDC,
      ),
    );
  });

  test("a position opens and closes at the price read from Raydium", async () => {
    const o = decodeOracle((await ctx.conn.getAccountInfo(env.oracle)).data);
    assert.equal(stateName({ [o.state]: {} }), o.state);
    const accountsOf = { market: env.market, pool: env.pool, oracle: env.oracle, usdcVault: env.usdcVault };
    const order = { nonce: 1n, side: "long", notional: 1_000n * USDC, margin: 250n * USDC };
    const usdc = findAta(trader.publicKey, env.usdcMint);
    const extra = await refreshAccountsFor(ctx.conn, o);
    await sleep(500);
    await sendIxs(ctx.conn, [trader], refreshPriceIx(trader.publicKey, env.oracle, env.ammPool, extra), openPositionIx(accountsOf, trader.publicKey, usdc, order));
    const { findPosition } = await import("../../packages/types/dist/index.js");
    const position = findPosition(env.market, trader.publicKey, order.nonce);
    const perp = await ctx.p.perp.account.position.fetch(position);
    const now = decodeOracle((await ctx.conn.getAccountInfo(env.oracle)).data);
    assert.equal(BigInt(perp.entryPrice.toString()), now.price, "entry is the oracle price derived from Raydium");
    await sendIxs(ctx.conn, [trader], closePositionIx(accountsOf, trader.publicKey, position, usdc));
    assert.equal(await ctx.conn.getAccountInfo(position), null);
  });
});
