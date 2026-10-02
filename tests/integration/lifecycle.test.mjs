/**
 * D9 — the whole protocol, end to end, on a real validator.
 *
 * Deposit into the pool, open a position, move the price, close it, and check
 * that what the trader gained is exactly what the pool lost. That single
 * reconciliation is the economic claim the project rests on; everything else
 * is machinery around it.
 *
 * The pure tests prove each rule in isolation. These prove the rules compose:
 * that token movement, CPI authority, PDA signing and the state machine all
 * agree with the arithmetic.
 *
 * The protocol is built ONCE in `before`. Standing it up costs about thirty
 * transactions, and doing that per test turned a useful suite into a
 * twenty-minute one. Each test gets its own actor and its own position nonce
 * instead, so they stay independent without paying for setup again. The one
 * test that mutates market state for good builds its own protocol.
 */

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import anchor from "@coral-xyz/anchor";
import {
  USDC,
  WAD,
  newProvider,
  programs,
  setupProtocol,
  actor,
  balance,
  refresh,
  swapUsdcIn,
  findPosition,
  mustFail,
  TOKEN_PROGRAM_ID,
} from "./_harness.mjs";

const big = (x) => new anchor.BN(x.toString());

describe("lifecycle", () => {
  let ctx;
  let env;
  let lp;

  const poolState = (pool) => ctx.p.clpPool.account.pool.fetch(pool);
  const marketState = (market) => ctx.p.perp.account.market.fetch(market);
  const oracleState = (oracle) => ctx.p.oracle.account.oracleAccount.fetch(oracle);

  /** Mirrors `Pool::nav` exactly, margin_held included. */
  async function nav(e) {
    const p = await poolState(e.pool);
    const o = await oracleState(e.oracle);
    const price = BigInt(o.price.toString());
    const cards = (BigInt(p.fractionBalance.toString()) * price) / WAD;
    const assets = BigInt(p.usdcSleeve.toString()) + cards;
    const liabilities = BigInt(p.badDebt.toString()) + BigInt(p.marginHeld.toString());
    return assets - liabilities - BigInt(p.traderPnl.toString());
  }

  async function deposit(e, who, amount) {
    await ctx.p.clpPool.methods
      .depositUsdc(big(amount))
      .accounts({
        depositor: who.kp.publicKey,
        pool: e.pool,
        oracle: e.oracle,
        clpMint: e.clpMint,
        usdcVault: e.usdcVault,
        depositorUsdc: who.usdc,
        depositorClp: who.clp,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([who.kp])
      .rpc();
  }

  async function open(e, trader, { nonce, side = "long", notional, margin }) {
    const position = findPosition(e.market, trader.kp.publicKey, nonce);
    await ctx.p.perp.methods
      .openPosition(big(nonce), { [side]: {} }, big(notional), big(margin))
      .accounts({
        trader: trader.kp.publicKey,
        market: e.market,
        pool: e.pool,
        oracle: e.oracle,
        position,
        traderUsdc: trader.usdc,
        usdcVault: e.usdcVault,
        clpPoolProgram: ctx.p.clpPool.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([trader.kp])
      .rpc();
    return position;
  }

  async function close(e, trader, position) {
    await ctx.p.perp.methods
      .closePosition()
      .accounts({
        owner: trader.kp.publicKey,
        market: e.market,
        pool: e.pool,
        oracle: e.oracle,
        position,
        usdcVault: e.usdcVault,
        payoutUsdc: trader.usdc,
        clpPoolProgram: ctx.p.clpPool.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([trader.kp])
      .rpc();
  }

  before(async () => {
    const { conn, payer, provider } = await newProvider();
    ctx = { conn, payer, provider, p: programs(provider) };
    env = await setupProtocol(ctx);
    lp = await actor(ctx, env, 400_000n * USDC);
    await deposit(env, lp, 140_000n * USDC);
  });

  // -------------------------------------------------------------------------

  test("the deposit minted CLP and grew the liquid sleeve", async () => {
    const p = await poolState(env.pool);
    assert.equal(BigInt(p.usdcSleeve.toString()), 140_000n * USDC);
    assert.equal(BigInt(p.clpSupply.toString()), 140_000n * USDC, "first deposit is 1:1");
    assert.equal(await balance(ctx.conn, lp.clp), 140_000n * USDC);
    assert.equal(await balance(ctx.conn, env.usdcVault), 140_000n * USDC, "tokens really moved");
  });

  test("opening takes margin and fee, and records the oracle price as entry", async () => {
    const trader = await actor(ctx, env, 10_000n * USDC);
    const notional = 4_000n * USDC;
    const margin = 1_000n * USDC;
    const fee = (notional * 10n) / 10_000n;

    const before = await balance(ctx.conn, trader.usdc);
    const position = await open(env, trader, { nonce: 1, notional, margin });
    const after = await balance(ctx.conn, trader.usdc);

    assert.equal(before - after, margin + fee, "margin plus fee left the trader");

    const pos = await ctx.p.perp.account.position.fetch(position);
    const o = await oracleState(env.oracle);
    assert.equal(
      BigInt(pos.entryPrice.toString()),
      BigInt(o.price.toString()),
      "entry is the oracle price, never an internal one",
    );

    const p = await poolState(env.pool);
    assert.equal(BigInt(p.marginHeld.toString()), margin, "margin booked as a liability");

    await close(env, trader, position);
  });

  test("margin is a liability, so opening moves NAV only by the fee", async () => {
    const trader = await actor(ctx, env, 10_000n * USDC);
    const notional = 4_000n * USDC;
    const fee = (notional * 10n) / 10_000n;

    const navBefore = await nav(env);
    const position = await open(env, trader, { nonce: 2, notional, margin: 1_000n * USDC });
    const navAfter = await nav(env);

    assert.equal(navAfter - navBefore, fee, "collateral is not the LPs' money");
    await close(env, trader, position);
  });

  test("what the trader gains, the pool loses, to the unit", async () => {
    // The reconciliation the whole design rests on. If this drifts, every
    // number on the LP screen is a guess.
    const trader = await actor(ctx, env, 20_000n * USDC);
    const notional = 4_000n * USDC;

    const navStart = await nav(env);
    const traderStart = await balance(ctx.conn, trader.usdc);

    const position = await open(env, trader, { nonce: 3, notional, margin: 1_000n * USDC });

    // Push the AMM up; the clamp walks the oracle after it 5% at a time.
    await swapUsdcIn(ctx, env.ammPool, 20_000n * USDC);
    for (let i = 0; i < 6; i += 1) await refresh(ctx, env);
    const price = BigInt((await oracleState(env.oracle)).price.toString());
    assert.ok(price > WAD, `oracle did not move, still ${price}`);

    await close(env, trader, position);

    const traderDelta = (await balance(ctx.conn, trader.usdc)) - traderStart;
    const navDelta = (await nav(env)) - navStart;

    // Over the full cycle the two sides net to zero. Every unit the trader
    // walks away with came out of the pool's equity; every unit the pool kept,
    // fees and borrow, came out of the trader's.
    assert.equal(traderDelta + navDelta, 0n, `not zero-sum: trader ${traderDelta}, pool ${navDelta}`);
    assert.ok(traderDelta > 0n, `trader ended ${traderDelta}, expected a gain on a rising index`);

    const p = await poolState(env.pool);
    assert.equal(BigInt(p.marginHeld.toString()), 0n, "liability released");
  });

  test("the lower of the two ceilings is the one enforced", async () => {
    // Depth ceiling at $60k of AMM reserve is about $17.9k; solvency is $233k.
    const trader = await actor(ctx, env, 400_000n * USDC);
    const msg = await mustFail(
      open(env, trader, { nonce: 4, notional: 30_000n * USDC, margin: 7_500n * USDC }),
      "a position past the depth ceiling was accepted",
    );
    assert.match(msg, /CapacityExceeded|capacity/i);
  });

  test("margin below the leverage cap is refused", async () => {
    const trader = await actor(ctx, env, 10_000n * USDC);
    const notional = 1_000n * USDC;

    const msg = await mustFail(
      open(env, trader, { nonce: 5, notional, margin: 200n * USDC - 1n }),
      "an under-margined position was accepted",
    );
    assert.match(msg, /InsufficientMargin|margin/i);

    const position = await open(env, trader, { nonce: 6, notional, margin: 200n * USDC });
    await close(env, trader, position);
  });

  test("only the registered market can make the pool pay out", async () => {
    // `settle_position` is gated on `address = pool.perp_market` over a
    // Signer. Without it, any program could drain the vault.
    const thief = await actor(ctx, env, 0n);
    const vaultBefore = await balance(ctx.conn, env.usdcVault);

    const msg = await mustFail(
      ctx.p.clpPool.methods
        .settlePosition(big(10_000n * USDC), big(0), big(0), big(0), big(0))
        .accounts({
          market: thief.kp.publicKey,
          pool: env.pool,
          usdcVault: env.usdcVault,
          traderUsdc: thief.usdc,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([thief.kp])
        .rpc(),
      "a stranger settled against the pool",
    );
    assert.match(msg, /NotPerpMarket|ConstraintAddress|Address|address/i);
    assert.equal(await balance(ctx.conn, thief.usdc), 0n, "nothing reached the stranger");
    assert.equal(await balance(ctx.conn, env.usdcVault), vaultBefore, "vault untouched");
  });

  test("withdrawals leave through both sleeves, never one", async () => {
    const shares = 10_000n * USDC;
    const before = await balance(ctx.conn, lp.usdc);

    await ctx.p.clpPool.methods
      .withdraw(big(shares))
      .accounts({
        owner: lp.kp.publicKey,
        pool: env.pool,
        oracle: env.oracle,
        clpMint: env.clpMint,
        usdcVault: env.usdcVault,
        fractionVault: env.fractionVault,
        ownerClp: lp.clp,
        ownerUsdc: lp.usdc,
        ownerFractions: lp.fractions,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([lp.kp])
      .rpc();

    // This pool's card sleeve is empty, so the proportional split is all USDC.
    assert.ok((await balance(ctx.conn, lp.usdc)) > before);
    assert.equal(await balance(ctx.conn, lp.fractions), 0n, "no fractions to give");
  });

  test("ReduceOnly stops new risk but still lets positions close", async () => {
    // Its own protocol: this one changes market state for good.
    const e = await setupProtocol(ctx);
    const lp2 = await actor(ctx, e, 200_000n * USDC);
    await deposit(e, lp2, 140_000n * USDC);
    const trader = await actor(ctx, e, 20_000n * USDC);

    const position = await open(e, trader, { nonce: 1, notional: 2_000n * USDC, margin: 500n * USDC });

    await ctx.p.clpPool.methods
      .setState({ reduceOnly: {} })
      .accounts({ admin: ctx.provider.wallet.publicKey, pool: e.pool })
      .rpc();

    const msg = await mustFail(
      open(e, trader, { nonce: 2, notional: 1_000n * USDC, margin: 250n * USDC }),
      "ReduceOnly accepted a new position",
    );
    assert.match(msg, /StateForbidsOpen|state/i);

    // Closing must still work, or rotten positions would accumulate.
    await close(e, trader, position);
    const mk = await marketState(e.market);
    assert.equal(BigInt(mk.oiLong.toString()), 0n);
  });

  test("a settled market unwinds and redeems with an equal haircut", async () => {
    // D11. Its own protocol: settling is permanent.
    const e = await setupProtocol(ctx);
    const whale = await actor(ctx, e, 300_000n * USDC);
    const minnow = await actor(ctx, e, 300_000n * USDC);
    await deposit(e, whale, 80_000n * USDC);
    await deposit(e, minnow, 20_000n * USDC);

    const trader = await actor(ctx, e, 20_000n * USDC);
    const position = await open(e, trader, {
      nonce: 1,
      notional: 4_000n * USDC,
      margin: 1_000n * USDC,
    });

    await ctx.p.clpPool.methods
      .setState({ settled: {} })
      .accounts({ admin: ctx.provider.wallet.publicKey, pool: e.pool })
      .rpc();

    // Nothing new comes in.
    const depMsg = await mustFail(deposit(e, whale, 1_000n * USDC), "settled accepted a deposit");
    assert.match(depMsg, /StateForbids|state/i);
    const openMsg = await mustFail(
      open(e, trader, { nonce: 2, notional: 1_000n * USDC, margin: 250n * USDC }),
      "settled accepted a new position",
    );
    assert.match(openMsg, /StateForbidsOpen|state/i);

    // But the trader can still get their margin back. Without this the margin
    // is stranded and the LPs are haircut forever for money nobody collects.
    const traderBefore = await balance(ctx.conn, trader.usdc);
    await close(e, trader, position);
    assert.ok(
      (await balance(ctx.conn, trader.usdc)) > traderBefore,
      "a settled market must still let a position unwind",
    );

    const p = await poolState(e.pool);
    assert.equal(BigInt(p.marginHeld.toString()), 0n, "no liability left hanging");

    // The normal exit is barred; redemption is the only way out.
    const wMsg = await mustFail(
      ctx.p.clpPool.methods
        .withdraw(big(1_000n * USDC))
        .accounts({
          owner: whale.kp.publicKey,
          pool: e.pool,
          oracle: e.oracle,
          clpMint: e.clpMint,
          usdcVault: e.usdcVault,
          fractionVault: e.fractionVault,
          ownerClp: whale.clp,
          ownerUsdc: whale.usdc,
          ownerFractions: whale.fractions,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([whale.kp])
        .rpc(),
      "the normal withdraw path worked after settlement",
    );
    assert.match(wMsg, /StateForbids|state/i);

    const redeem = (who, shares) =>
      ctx.p.clpPool.methods
        .redeemSettled(big(shares))
        .accounts({
          owner: who.kp.publicKey,
          pool: e.pool,
          oracle: e.oracle,
          clpMint: e.clpMint,
          usdcVault: e.usdcVault,
          fractionVault: e.fractionVault,
          ownerClp: who.clp,
          ownerUsdc: who.usdc,
          ownerFractions: who.fractions,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([who.kp])
        .rpc();

    const wBefore = await balance(ctx.conn, whale.usdc);
    const mBefore = await balance(ctx.conn, minnow.usdc);
    await redeem(whale, 80_000n * USDC);
    await redeem(minnow, 20_000n * USDC);
    const wOut = (await balance(ctx.conn, whale.usdc)) - wBefore;
    const mOut = (await balance(ctx.conn, minnow.usdc)) - mBefore;

    // Four times the shares, four times the payout. The haircut, whatever it
    // is, falls on both identically — that is the whole point of pro-rata.
    const ratio = (wOut * 1_000n) / mOut;
    assert.ok(ratio >= 3_990n && ratio <= 4_010n, `payout ratio was ${ratio}/1000, expected ~4000`);

    const after = await poolState(e.pool);
    assert.equal(BigInt(after.clpSupply.toString()), 0n, "everyone is out");
  });
});
