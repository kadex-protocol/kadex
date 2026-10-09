/**
 * An LP's history and the market's utilisation, read back from the events
 * the programs emitted, against what the accounts actually recorded.
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { mintTo } from "@solana/spl-token";
import { USDC, newProvider, programs, setupProtocol, actor, sendIxs } from "./_harness.mjs";
import {
  decodeMarket,
  decodeOracle,
  decodePool,
  depositFractionsIx,
  depositUsdcIx,
  lpReturn,
  openPositionIx,
  closePositionIx,
  readLpEvents,
  readUtilisation,
  refreshPriceIx,
  withdrawIx,
} from "../../packages/sdk/dist/index.js";
import { findPosition } from "../../packages/types/dist/index.js";

describe("LP history and utilisation from events", () => {
  let ctx, env, lp, trader;
  const raw = async (k) => (await ctx.conn.getAccountInfo(k)).data;
  const target = async () => ({ address: env.pool, pool: decodePool(await raw(env.pool)) });

  before(async () => {
    ctx = await newProvider();
    ctx.p = programs(ctx.provider);
    env = await setupProtocol(ctx);
    lp = await actor(ctx, env, 50_000n * USDC);
    await mintTo(ctx.conn, ctx.payer, env.fractionMint, lp.fractions, ctx.payer, 2_000n * USDC);
    trader = await actor(ctx, env, 5_000n * USDC);
  });

  test("the LP's deposits and withdrawal come back with the amounts that moved", async () => {
    const mine = { usdc: lp.usdc, fractions: lp.fractions, clp: lp.clp };
    await sendIxs(ctx.conn, [lp.kp], refreshPriceIx(lp.kp.publicKey, env.oracle, env.ammPool), depositUsdcIx(await target(), lp.kp.publicKey, mine, 20_000n * USDC));
    await sendIxs(ctx.conn, [lp.kp], depositFractionsIx(await target(), lp.kp.publicKey, mine, 1_000n * USDC));
    const clpHeld = (await ctx.conn.getTokenAccountBalance(lp.clp)).value.amount;
    await sendIxs(ctx.conn, [lp.kp], withdrawIx(await target(), lp.kp.publicKey, mine, BigInt(clpHeld) / 4n));

    const events = await readLpEvents(ctx.conn, env.pool, lp.kp.publicKey);
    assert.deepEqual(events.map((e) => e.kind), ["deposit", "deposit", "withdraw"]);
    assert.equal(events[0].usdc, 20_000n * USDC);
    assert.equal(events[1].fractions, 1_000n * USDC);
    assert.equal(events[2].shares, BigInt(clpHeld) / 4n);
    const remaining = BigInt((await ctx.conn.getTokenAccountBalance(lp.clp)).value.amount);
    assert.equal(events[0].shares + events[1].shares - events[2].shares, remaining, "shares in minus out is what the LP holds");

    const price = decodeOracle(await raw(env.oracle)).price;
    const r = lpReturn(events, 0n, () => ({ price, exact: true }));
    assert.equal(r.contributed, 20_000n * USDC + (1_000n * USDC * price) / 1_000_000n);
    assert.ok(r.withdrawn > 0n && r.firstDepositTs !== null);
  });

  test("utilisation at each open is the market's own open interest over the cap it was checked against", async () => {
    const accountsOf = { market: env.market, pool: env.pool, oracle: env.oracle, usdcVault: env.usdcVault };
    const order = { nonce: 3n, side: "long", notional: 1_000n * USDC, margin: 250n * USDC };
    await sendIxs(ctx.conn, [trader.kp], refreshPriceIx(trader.kp.publicKey, env.oracle, env.ammPool), openPositionIx(accountsOf, trader.kp.publicKey, trader.usdc, order));
    const oiOpen = decodeMarket(await raw(env.market));
    await sendIxs(ctx.conn, [trader.kp], closePositionIx(accountsOf, trader.kp.publicKey, findPosition(env.market, trader.kp.publicKey, order.nonce), trader.usdc));

    const series = await readUtilisation(ctx.conn, env.market);
    assert.equal(series.length, 2, "one point at the open, one at the close");
    assert.equal(series[0].oi, oiOpen.oiLong + oiOpen.oiShort, "open interest after the open, as the market account holds it");
    assert.ok(series[0].utilization > 0n);
    assert.equal(series[1].oi, 0n, "the close takes the position's notional back out");
    assert.equal(series[1].utilization, 0n);
  });
});
