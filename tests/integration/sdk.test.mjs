import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { USDC, newProvider, programs, setupProtocol, funded, mustFail, stateName } from "./_harness.mjs";
import {
  DISCRIMINATORS,
  createAtaIdempotentIx,
  decodeMarket,
  decodeOracle,
  decodePool,
  decodeTokenAmount,
  depositFractionsIx,
  closePositionIx,
  decodePosition,
  depositUsdcIx,
  findAta,
  marksOf,
  navIssue,
  openPositionIx,
  poolView,
  refreshPriceIx,
  withdrawIx,
} from "../../packages/sdk/dist/chain.js";
import { navRedeem } from "../../packages/sdk/dist/views.js";
import { readPriceHistory, toSeries } from "../../packages/sdk/dist/history.js";
import * as math from "../../packages/sdk/dist/math.js";
import { findPosition } from "../../packages/types/dist/index.js";

const big = (bn) => BigInt(bn.toString());

describe("@kadex/sdk against the deployed programs", () => {
  let ctx, env, lp, target;

  const raw = async (address) => (await ctx.conn.getAccountInfo(address)).data;
  const tokens = async (address) => {
    const info = await ctx.conn.getAccountInfo(address);
    return info ? decodeTokenAmount(info.data) : 0n;
  };
  const send = (...instructions) =>
    sendAndConfirmTransaction(ctx.conn, new Transaction().add(...instructions), [lp], { commitment: "confirmed" });
  const accounts = () => ({
    usdc: findAta(lp.publicKey, env.usdcMint),
    fractions: findAta(lp.publicKey, env.fractionMint),
    clp: findAta(lp.publicKey, env.clpMint),
  });

  before(async () => {
    ctx = await newProvider();
    ctx.p = programs(ctx.provider);
    env = await setupProtocol(ctx);
    lp = await funded(ctx.conn, 20);
    const usdc = await createAssociatedTokenAccount(ctx.conn, ctx.payer, env.usdcMint, lp.publicKey);
    const fractions = await createAssociatedTokenAccount(ctx.conn, ctx.payer, env.fractionMint, lp.publicKey);
    await mintTo(ctx.conn, ctx.payer, env.usdcMint, usdc, ctx.payer, 50_000n * USDC);
    await mintTo(ctx.conn, ctx.payer, env.fractionMint, fractions, ctx.payer, 10_000n * USDC);
    target = { address: env.pool, pool: decodePool(await raw(env.pool)) };
  });

  test("the hardcoded discriminators are the ones Anchor derives", () => {
    const of = (preimage) => [...createHash("sha256").update(preimage).digest().subarray(0, 8)];
    assert.deepEqual([...DISCRIMINATORS.pool], of("account:Pool"));
    assert.deepEqual([...DISCRIMINATORS.oracle], of("account:OracleAccount"));
    assert.deepEqual([...DISCRIMINATORS.market], of("account:Market"));
    assert.deepEqual([...DISCRIMINATORS.depositUsdc], of("global:deposit_usdc"));
    assert.deepEqual([...DISCRIMINATORS.depositFractions], of("global:deposit_fractions"));
    assert.deepEqual([...DISCRIMINATORS.withdraw], of("global:withdraw"));
    assert.deepEqual([...DISCRIMINATORS.refreshPrice], of("global:refresh_price"));
  });

  test("a USDC deposit built by the SDK mints CLP into a fresh token account", async () => {
    assert.equal(await ctx.conn.getAccountInfo(accounts().clp), null);
    await send(
      createAtaIdempotentIx(lp.publicKey, lp.publicKey, env.clpMint),
      depositUsdcIx(target, lp.publicKey, accounts(), 20_000n * USDC),
    );
    assert.equal(await tokens(accounts().clp), 20_000n * USDC);
    assert.equal(await tokens(accounts().usdc), 30_000n * USDC);
  });

  test("a fraction deposit mints exactly what the SDK quotes", async () => {
    const pool = decodePool(await raw(env.pool));
    const marks = marksOf(decodeOracle(await raw(env.oracle)));
    const amount = 2_000n * USDC;
    const gross = math.mulWadFloor(amount, marks.low);
    const net = gross - (gross * BigInt(pool.params.depositHaircutBps) + 9_999n) / 10_000n;
    const quoted = math.sharesForDeposit(net, navIssue(pool, marks), pool.clpSupply);

    const before = await tokens(accounts().clp);
    await send(depositFractionsIx(target, lp.publicKey, accounts(), amount));
    assert.equal((await tokens(accounts().clp)) - before, quoted);
  });

  test("decodePool reads every field the Anchor coder reads", async () => {
    const mine = decodePool(await raw(env.pool));
    const theirs = await ctx.p.clpPool.account.pool.fetch(env.pool);
    for (const key of ["admin", "usdcMint", "clpMint", "usdcVault", "fractionMint", "fractionVault", "oracle", "perpMarket"]) {
      assert.equal(mine[key].toBase58(), theirs[key].toBase58(), key);
    }
    for (const key of ["usdcSleeve", "fractionBalance", "clpSupply", "badDebt", "marginHeld", "accruedFeesLp", "accruedFeesProtocol"]) {
      assert.equal(mine[key], big(theirs[key]), key);
    }
    for (const key of ["oiLong", "oiShort", "unitsLong", "unitsShort"]) {
      assert.equal(mine.book[key], big(theirs.book[key]), key);
    }
    for (const [key, value] of Object.entries(theirs.params)) {
      assert.equal(BigInt(mine.params[key]), big(value), key);
    }
    assert.equal(mine.state, stateName(theirs.state));
    assert.equal(mine.usdcSleeve, 20_000n * USDC);
    assert.equal(mine.fractionBalance, 2_000n * USDC);
  });

  test("decodeOracle and decodeMarket agree with the Anchor coder", async () => {
    const oracle = decodeOracle(await raw(env.oracle));
    const theirs = await ctx.p.oracle.account.oracleAccount.fetch(env.oracle);
    assert.equal(oracle.basket.toBase58(), theirs.basket.toBase58());
    assert.equal(oracle.ammPool.toBase58(), env.ammPool.toBase58());
    for (const key of ["price", "twap", "spot", "slowTwap", "depthUsdc", "lastUpdateTs", "externalMedian"]) {
      assert.equal(oracle[key], big(theirs[key]), key);
    }
    assert.equal(oracle.maxStalenessSecs, theirs.params.maxStalenessSecs);
    assert.equal(oracle.state, stateName(theirs.state));
    assert.ok(oracle.price > 0n);

    const market = decodeMarket(await raw(env.market));
    const theirMarket = await ctx.p.perp.account.market.fetch(env.market);
    assert.equal(market.pool.toBase58(), env.pool.toBase58());
    assert.equal(market.oracle.toBase58(), env.oracle.toBase58());
    for (const key of ["oiLong", "oiShort", "borrowIdxLong", "borrowIdxShort", "lastAccrualTs"]) {
      assert.equal(market[key], big(theirMarket[key]), key);
    }
    assert.equal(market.openPositions, theirMarket.openPositions);
  });

  test("a withdrawal built by the SDK returns both sleeves, as quoted", async () => {
    await send(refreshPriceIx(lp.publicKey, env.oracle, env.ammPool));
    const pool = decodePool(await raw(env.pool));
    const marks = marksOf(decodeOracle(await raw(env.oracle)));
    const view = poolView(env.pool, pool, marks);
    const shares = 5_000n * USDC;
    const value = math.assetsForShares(shares, navRedeem(view), pool.clpSupply);
    const assets = view.usdcSleeve + view.cardSleeveValue;

    const before = { usdc: await tokens(accounts().usdc), fractions: await tokens(accounts().fractions) };
    await send(
      createAtaIdempotentIx(lp.publicKey, lp.publicKey, env.usdcMint),
      createAtaIdempotentIx(lp.publicKey, lp.publicKey, env.fractionMint),
      withdrawIx(target, lp.publicKey, accounts(), shares),
    );
    const usdcOut = (await tokens(accounts().usdc)) - before.usdc;
    const fractionsOut = (await tokens(accounts().fractions)) - before.fractions;
    assert.equal(usdcOut, (pool.usdcSleeve * value) / assets);
    assert.equal(fractionsOut, (pool.fractionBalance * value) / assets);
    assert.ok(usdcOut > 0n && fractionsOut > 0n, "a withdrawal is never one sleeve alone");
  });

  test("a position opened and closed through the SDK moves margin out and back", async () => {
    await send(refreshPriceIx(lp.publicKey, env.oracle, env.ammPool));
    const accountsOf = { market: env.market, pool: env.pool, oracle: env.oracle, usdcVault: env.usdcVault };
    const order = { nonce: 7n, side: "short", notional: 1_000n * USDC, margin: 200n * USDC };
    const fee = (order.notional * BigInt(target.pool.params.openCloseFeeBps) + 9_999n) / 10_000n;

    const before = await tokens(accounts().usdc);
    await send(openPositionIx(accountsOf, lp.publicKey, accounts().usdc, order));
    assert.equal(before - (await tokens(accounts().usdc)), order.margin + fee);

    const address = findPosition(env.market, lp.publicKey, order.nonce);
    const mine = decodePosition(await raw(address));
    const theirs = await ctx.p.perp.account.position.fetch(address);
    assert.equal(mine.owner.toBase58(), lp.publicKey.toBase58());
    assert.equal(mine.market.toBase58(), env.market.toBase58());
    assert.equal(mine.side, "short");
    for (const key of ["notional", "margin", "entryPrice", "borrowIdxEntry", "openedTs", "nonce"]) {
      assert.equal(mine[key], big(theirs[key]), key);
    }
    assert.equal(decodeMarket(await raw(env.market)).oiShort, order.notional);

    await send(closePositionIx(accountsOf, lp.publicKey, address, accounts().usdc));
    assert.equal(await ctx.conn.getAccountInfo(address), null);
    const back = (await tokens(accounts().usdc)) - (before - order.margin - fee);
    assert.ok(back > 0n && back <= order.margin, `closing returns margin net of fee and borrow, got ${back}`);
  });

  test("price history read from the logs matches what the oracle account says", async () => {
    const sig = await send(refreshPriceIx(lp.publicKey, env.oracle, env.ammPool));
    const stored = decodeOracle(await raw(env.oracle));
    const { events, newest } = await readPriceHistory(ctx.conn, env.oracle, { from: 0, step: 1 });
    assert.ok(events.length > 0, "at least the refresh just sent");
    const last = events[events.length - 1];
    assert.equal(last.price, stored.price);
    assert.equal(last.ts, stored.lastUpdateTs);
    assert.equal(last.depthUsdc, stored.depthUsdc);
    assert.ok(last.oracle.equals(env.oracle));
    assert.equal(newest, sig, "the newest signature is the one to resume from");

    const again = await readPriceHistory(ctx.conn, env.oracle, { from: 0, step: 1, until: newest });
    assert.deepEqual(again.events, [], "resuming from the newest signature reads nothing old");

    const now = Number(stored.lastUpdateTs);
    const series = toSeries(events, 300, now - 3_600, now);
    assert.equal(series[series.length - 1].price, stored.price, "the chart ends at the oracle price");
  });

  test("the program refuses an SDK deposit of zero", async () => {
    const message = await mustFail(send(depositUsdcIx(target, lp.publicKey, accounts(), 0n)), "a zero deposit");
    assert.match(message, /ZeroAmount|custom program error/);
  });

  test("an account of the wrong size or kind is refused, not read as garbage", async () => {
    const data = await raw(env.pool);
    assert.throws(() => decodePool(data.subarray(0, data.length - 1)), /layout changed/);
    const flipped = Uint8Array.from(data);
    flipped[0] ^= 0xff;
    assert.throws(() => decodePool(flipped), /not a Pool account/);
  });
});
