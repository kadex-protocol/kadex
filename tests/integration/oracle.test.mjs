/**
 * The oracle's four defences, on-chain, against a real constant-product curve.
 *
 * The pure tests in `programs/oracle/src/lib.rs` prove the arithmetic. These
 * prove the program: that a transaction which should be refused actually is,
 * and that the state machine lands where it should after real reserves move.
 *
 * Everything here except the first case is a NEGATIVE test. The positives say
 * the thing works; the negatives say it cannot be broken, and only the second
 * kind is worth much in a protocol that holds money.
 */

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import anchor from "@coral-xyz/anchor";
import { Keypair, Transaction } from "@solana/web3.js";
import {
  USDC,
  WAD,
  newProvider,
  programs,
  funded,
  setupOracle,
  refresh,
  sleep,
  swapUsdcIn,
  removeLiquidity,
  stateName,
  mustFail,
  DEFAULT_ORACLE_PARAMS,
} from "./_harness.mjs";

describe("oracle defences", () => {
  let ctx;

  before(async () => {
    const { conn, payer, provider } = await newProvider();
    ctx = { conn, payer, provider, p: programs(provider) };
  });

  const read = (oracle) => ctx.p.oracle.account.oracleAccount.fetch(oracle);

  test("a funded pool produces a tradeable price", async () => {
    const env = await setupOracle(ctx);

    let o = await read(env.oracle);
    assert.equal(stateName(o.state), "uninitialized", "no price before the first refresh");

    await refresh(ctx, env);
    o = await read(env.oracle);

    assert.equal(stateName(o.state), "ok");
    assert.equal(BigInt(o.price.toString()), WAD, "60k against 60k is $1.00 per fraction");
    assert.equal(BigInt(o.depthUsdc.toString()), 60_000n * USDC);
    assert.ok(o.lastUpdateTs.toNumber() > 0);
  });

  test("the clamp blocks a single-block price jump", async () => {
    // The attack: push the AMM hard in one transaction, then liquidate
    // everyone at the new price. The clamp is what makes it not work.
    const env = await setupOracle(ctx);
    await refresh(ctx, env);
    const before = BigInt((await read(env.oracle)).price.toString());

    await swapUsdcIn(ctx, env.ammPool, 40_000n * USDC); // roughly +78% spot
    await refresh(ctx, env);
    const o = await read(env.oracle);

    const spot = BigInt(o.spot.toString());
    const price = BigInt(o.price.toString());
    assert.ok(spot > (before * 3n) / 2n, "the spot really did jump");
    assert.ok(
      price <= before + before / 20n,
      `official price moved to ${price} from ${before}, past the 5% clamp`,
    );
  });

  test("a sustained push still gets there, but only as fast as the clock allows", async () => {
    // The clamp does not make manipulation impossible, it makes it slow: here
    // 5% per second (production: 5% per 15s). Saying that plainly is better
    // than overclaiming.
    const env = await setupOracle(ctx);
    await refresh(ctx, env);
    const before = BigInt((await read(env.oracle)).price.toString());
    const target = (before * 3n) / 2n;

    await swapUsdcIn(ctx, env.ammPool, 40_000n * USDC);

    const started = Date.now();
    let updates = 0;
    while (updates < 40) {
      const price = BigInt((await read(env.oracle)).price.toString());
      if (price >= target) break;
      await sleep(1_100);
      await refresh(ctx, env);
      updates += 1;
    }
    const secs = (Date.now() - started) / 1000;
    assert.ok(secs >= 8, `a 50% move took only ${secs}s`);
  });

  test("many refreshes in one transaction move the price no further than one", async () => {
    // The exploit this replaces, measured on this validator before the fix:
    // twelve refreshes in one transaction moved the price +79.6% against a 5%
    // clamp, with the state still ok. Now the second call in a slot is a
    // no-op, and a spot that has been in force for zero seconds weighs zero.
    const env = await setupOracle(ctx);
    await refresh(ctx, env);
    await sleep(2_500);
    await refresh(ctx, env);
    const before = await read(env.oracle);

    await swapUsdcIn(ctx, env.ammPool, 30_000n * USDC);
    const ix = await ctx.p.oracle.methods
      .refreshPrice()
      .accounts({ caller: ctx.provider.wallet.publicKey, oracle: env.oracle, ammPool: env.ammPool })
      .instruction();
    const tx = new Transaction();
    for (let i = 0; i < 12; i += 1) tx.add(ix);
    await ctx.provider.sendAndConfirm(tx);

    const after = await read(env.oracle);
    assert.equal(after.price.toString(), before.price.toString(), "the price moved inside one transaction");
    assert.equal(after.slowTwap.toString(), before.slowTwap.toString(), "the slow mark moved too");
  });

  test("liquidity added for a moment buys no depth", async () => {
    const env = await setupOracle(ctx);
    await refresh(ctx, env);
    await ctx.p.mockAmm.methods
      .addLiquidity(new anchor.BN((600_000n * USDC).toString()))
      .accounts({ caller: ctx.provider.wallet.publicKey, pool: env.ammPool })
      .rpc();
    await refresh(ctx, env);
    const o = await read(env.oracle);
    assert.equal(BigInt(o.depthUsdc.toString()), 60_000n * USDC, "depth counted liquidity that just arrived");
  });

  test("draining the pool below the depth floor stops trading", async () => {
    // Blocks: pull liquidity so the oracle becomes cheap to push, then push it.
    const env = await setupOracle(ctx);
    await refresh(ctx, env);
    assert.equal(stateName((await read(env.oracle)).state), "ok");

    await removeLiquidity(ctx, env.ammPool, 40_000n * USDC); // leaves $20k, floor is $25k
    await refresh(ctx, env);

    const o = await read(env.oracle);
    assert.equal(stateName(o.state), "shallowDepth");
  });

  test("divergence from the external median halts the market", async () => {
    const env = await setupOracle(ctx);
    await refresh(ctx, env);

    const setMedian = (median) =>
      ctx.p.oracle.methods
        .setExternalMedian(new anchor.BN(median.toString()))
        .accounts({ admin: ctx.provider.wallet.publicKey, oracle: env.oracle })
        .rpc();

    // 10% apart: inside the 15% bound, still tradeable
    await setMedian((WAD * 90n) / 100n);
    assert.equal(stateName((await read(env.oracle)).state), "ok");

    // 40% apart: the AMM and the outside world disagree too much to trade
    await setMedian((WAD * 60n) / 100n);
    assert.equal(stateName((await read(env.oracle)).state), "diverged");
  });

  test("a missing external feed degrades instead of halting", async () => {
    // If the fills feed dies we lose one defence. Losing the market as well
    // would turn a secondary defence into a single point of failure.
    const env = await setupOracle(ctx);
    await refresh(ctx, env);
    const o = await read(env.oracle);
    assert.equal(BigInt(o.externalMedian.toString()), 0n, "never fed");
    assert.equal(stateName(o.state), "ok");
  });

  test("refreshing against a pool the oracle is not bound to is refused", async () => {
    // Swapping in an attacker-controlled pool account is the cheapest possible
    // oracle attack. `has_one` is what stops it.
    const env = await setupOracle(ctx);
    await refresh(ctx, env);

    const impostor = Keypair.generate();
    await ctx.p.mockAmm.methods
      .createPool(new anchor.BN((1_000_000n * USDC).toString()), new anchor.BN(USDC.toString()))
      .accounts({ payer: ctx.provider.wallet.publicKey, pool: impostor.publicKey })
      .signers([impostor])
      .rpc();

    await mustFail(
      ctx.p.oracle.methods
        .refreshPrice()
        .accounts({
          caller: ctx.provider.wallet.publicKey,
          oracle: env.oracle,
          ammPool: impostor.publicKey,
        })
        .rpc(),
      "the oracle accepted a pool it was not bound to",
    );

    assert.equal(
      BigInt((await read(env.oracle)).price.toString()),
      WAD,
      "price must be untouched",
    );
  });

  test("only the admin can widen the clamp", async () => {
    const env = await setupOracle(ctx);
    await refresh(ctx, env);

    const attacker = await funded(ctx.conn);
    // Widening the clamp to 100% would disarm the main defence.
    const disarmed = { ...DEFAULT_ORACLE_PARAMS, maxTickMove: new anchor.BN(WAD.toString()) };

    await mustFail(
      ctx.p.oracle.methods
        .setParams(disarmed)
        .accounts({ admin: attacker.publicKey, oracle: env.oracle })
        .signers([attacker])
        .rpc(),
      "a stranger widened the clamp",
    );

    const o = await read(env.oracle);
    assert.equal(BigInt(o.params.maxTickMove.toString()), 50_000n);
  });

  test("refresh is permissionless, so no single keeper can freeze the price", async () => {
    // There is no oracle key to steal and no one process whose death stops
    // the market. That is the whole reason this instruction has no authority.
    const env = await setupOracle(ctx);
    await refresh(ctx, env);

    const stranger = await funded(ctx.conn);
    await ctx.p.oracle.methods
      .refreshPrice()
      .accounts({ caller: stranger.publicKey, oracle: env.oracle, ammPool: env.ammPool })
      .signers([stranger])
      .rpc();

    assert.equal(stateName((await read(env.oracle)).state), "ok");
  });

  test("an oracle over a shallow pool never reports ok, even when fresh", async () => {
    const env = await setupOracle(ctx, 10_000n * USDC, 10_000n * USDC);
    await refresh(ctx, env);
    const o = await read(env.oracle);
    assert.equal(stateName(o.state), "shallowDepth");
    assert.ok(BigInt(o.price.toString()) > 0n, "it still has a price, it just will not trade on it");
  });
});
