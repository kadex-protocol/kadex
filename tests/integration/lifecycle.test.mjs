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
  refreshOver,
  sleep,
  swapUsdcIn,
  findPosition,
  mustFail,
  DEFAULT_ORACLE_PARAMS,
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

  /**
   * Mirrors `Pool::nav_redeem`: the sleeve (LP money only — margin and the
   * protocol's fees are held apart), cards at the low mark, minus traders'
   * unrealized gains marked at today's price.
   */
  async function nav(e) {
    const p = await poolState(e.pool);
    const o = await oracleState(e.oracle);
    const price = BigInt(o.price.toString());
    const slow = BigInt(o.slowTwap.toString());
    const low = slow > 0n && slow < price ? slow : price;
    const cards = (BigInt(p.fractionBalance.toString()) * low) / WAD;
    const b = p.book;
    const pnl =
      (BigInt(b.unitsLong.toString()) * price) / WAD - BigInt(b.oiLong.toString()) +
      (BigInt(b.oiShort.toString()) - (BigInt(b.unitsShort.toString()) * price) / WAD);
    return BigInt(p.usdcSleeve.toString()) + cards - (pnl > 0n ? pnl : 0n);
  }

  const protocolFees = async (e) => BigInt((await poolState(e.pool)).accruedFeesProtocol.toString());

  async function withdraw(e, who, shares) {
    return ctx.p.clpPool.methods
      .withdraw(big(shares))
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
    assert.equal(BigInt(p.marginHeld.toString()), margin, "margin held apart from the sleeve");

    await close(env, trader, position);
  });

  test("margin is not LP money, so opening moves NAV only by the LPs' fee share", async () => {
    const trader = await actor(ctx, env, 10_000n * USDC);
    const notional = 4_000n * USDC;
    const fee = (notional * 10n) / 10_000n;
    const lpShare = (fee * 7_500n) / 10_000n;

    const navBefore = await nav(env);
    const sleeveBefore = BigInt((await poolState(env.pool)).usdcSleeve.toString());
    const position = await open(env, trader, { nonce: 2, notional, margin: 1_000n * USDC });
    const navAfter = await nav(env);
    const sleeveAfter = BigInt((await poolState(env.pool)).usdcSleeve.toString());

    assert.equal(sleeveAfter - sleeveBefore, lpShare, "the margin did not join the sleeve");
    assert.equal(navAfter - navBefore, lpShare, "collateral is not the LPs' money");
    await close(env, trader, position);
  });

  test("the vault holds exactly sleeve + margin + protocol fees", async () => {
    const trader = await actor(ctx, env, 10_000n * USDC);
    const position = await open(env, trader, { nonce: 20, notional: 4_000n * USDC, margin: 1_000n * USDC });
    const p = await poolState(env.pool);
    const books =
      BigInt(p.usdcSleeve.toString()) + BigInt(p.marginHeld.toString()) + BigInt(p.accruedFeesProtocol.toString());
    assert.equal(await balance(ctx.conn, env.usdcVault), books);
    await close(env, trader, position);
  });

  test("what the trader gains, the pool loses, to the unit", async () => {
    // The reconciliation the whole design rests on. If this drifts, every
    // number on the LP screen is a guess.
    const trader = await actor(ctx, env, 20_000n * USDC);
    const notional = 4_000n * USDC;

    const navStart = await nav(env);
    const feesStart = await protocolFees(env);
    const traderStart = await balance(ctx.conn, trader.usdc);

    const position = await open(env, trader, { nonce: 3, notional, margin: 1_000n * USDC });

    // Push the AMM up; the clamp lets the oracle follow at 5% per second.
    await swapUsdcIn(ctx, env.ammPool, 20_000n * USDC);
    await refreshOver(ctx, env, 6);
    const price = BigInt((await oracleState(env.oracle)).price.toString());
    assert.ok(price > WAD, `oracle did not move, still ${price}`);

    await close(env, trader, position);

    const traderDelta = (await balance(ctx.conn, trader.usdc)) - traderStart;
    const navDelta = (await nav(env)) - navStart;
    const feeDelta = (await protocolFees(env)) - feesStart;

    // Over the full cycle the three parties net to zero. Every unit the
    // trader walks away with came out of the LPs' equity; every unit the pool
    // kept — LP fees and borrow to the sleeve, the protocol's share outside
    // it — came out of the trader's.
    assert.equal(
      traderDelta + navDelta + feeDelta,
      0n,
      `not zero-sum: trader ${traderDelta}, LPs ${navDelta}, protocol ${feeDelta}`,
    );
    assert.ok(traderDelta > 0n, `trader ended ${traderDelta}, expected a gain on a rising index`);

    const p = await poolState(env.pool);
    assert.equal(BigInt(p.marginHeld.toString()), 0n, "liability released");

    // The oracle is still catching up with the AMM, which stops new risk by
    // design. Let it arrive so the suites after this one can open.
    for (let i = 0; i < 30 && !("ok" in (await oracleState(env.oracle)).state); i += 1) {
      await refreshOver(ctx, env, 1);
    }
    assert.ok("ok" in (await oracleState(env.oracle)).state, "the oracle never caught up");
  });

  test("the lower of the two ceilings is the one enforced", async () => {
    // Depth ceiling at $60k of AMM reserve is ~$9k after the 2x attack-safety
    // factor; solvency is $233k. The lower one has to win.
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

  // -------------------------------------------------------------------------
  // regressions for the audit of 6 Oct 2026
  // -------------------------------------------------------------------------

  test("deposit then withdraw at once returns no more than went in", async () => {
    // The validator-proven exploit: with $25k of trader margin in the vault,
    // $100k in and straight out returned $110,416.
    const e = await setupProtocol(ctx);
    const seed = await actor(ctx, e, 140_000n * USDC);
    await deposit(e, seed, 140_000n * USDC);
    const trader = await actor(ctx, e, 30_000n * USDC);
    await open(e, trader, { nonce: 1, notional: 2_000n * USDC, margin: 25_000n * USDC });

    const atk = await actor(ctx, e, 100_000n * USDC);
    await deposit(e, atk, 100_000n * USDC);
    await withdraw(e, atk, await balance(ctx.conn, atk.clp));
    const out = await balance(ctx.conn, atk.usdc);
    assert.ok(out <= 100_000n * USDC, `round trip returned ${out}`);
  });

  test("LPs cannot withdraw the sleeve open positions were admitted against", async () => {
    // Deep AMM so the solvency ceiling is the one that binds.
    const e = await setupProtocol(ctx, { usdc: 2_000_000n * USDC, fraction: 2_000_000n * USDC });
    const lp1 = await actor(ctx, e, 30_000n * USDC);
    await deposit(e, lp1, 30_000n * USDC); // solvency cap 50k
    const trader = await actor(ctx, e, 20_000n * USDC);
    await open(e, trader, { nonce: 1, notional: 40_000n * USDC, margin: 10_000n * USDC });

    // 40k open needs 24k of sleeve; taking 10k leaves ~20k
    const msg = await mustFail(withdraw(e, lp1, 10_000n * USDC), "LP drained the sleeve under open interest");
    assert.match(msg, /WithdrawBreachesCapacity|capacity/i);
    // a small withdrawal that stays above the line still works
    await withdraw(e, lp1, 2_000n * USDC);
  });

  test("a stale oracle admits no new risk, whatever its stored state says", async () => {
    const quick = { ...DEFAULT_ORACLE_PARAMS, maxStalenessSecs: 3 };
    const e = await setupProtocol(ctx, { oracleParams: quick });
    const lp1 = await actor(ctx, e, 140_000n * USDC);
    const trader = await actor(ctx, e, 10_000n * USDC);
    await refresh(ctx, e);
    await deposit(e, lp1, 140_000n * USDC);
    await sleep(4_500); // nobody refreshes: state still reads ok

    const o = await oracleState(e.oracle);
    assert.ok("ok" in o.state, "the stored state never changed");
    const msg = await mustFail(
      open(e, trader, { nonce: 1, notional: 1_000n * USDC, margin: 250n * USDC }),
      "opened on a stale price",
    );
    assert.match(msg, /OracleStale|stale/i);

    // a trader refreshes in the same breath and is through
    await refresh(ctx, e);
    await open(e, trader, { nonce: 2, notional: 1_000n * USDC, margin: 250n * USDC });
  });

  test("borrow is charged without anybody calling accrue_borrow", async () => {
    const e = await setupProtocol(ctx);
    const lp1 = await actor(ctx, e, 140_000n * USDC);
    await deposit(e, lp1, 140_000n * USDC);
    const trader = await actor(ctx, e, 10_000n * USDC);
    const position = await open(e, trader, { nonce: 1, notional: 4_000n * USDC, margin: 1_000n * USDC });
    const stamped = BigInt((await ctx.p.perp.account.position.fetch(position)).borrowIdxEntry.toString());

    await refreshOver(ctx, e, 3);
    await close(e, trader, position);
    const idx = BigInt((await marketState(e.market)).borrowIdxLong.toString());
    assert.ok(idx > stamped, "the close did not accrue borrow");
  });

  test("a position is stamped with an index accrued to the moment it opens", async () => {
    const e = await setupProtocol(ctx);
    const lp1 = await actor(ctx, e, 140_000n * USDC);
    await deposit(e, lp1, 140_000n * USDC);
    const a = await actor(ctx, e, 10_000n * USDC);
    await open(e, a, { nonce: 1, notional: 4_000n * USDC, margin: 1_000n * USDC });
    await refreshOver(ctx, e, 3);
    const b = await actor(ctx, e, 10_000n * USDC);
    const pb = await open(e, b, { nonce: 1, notional: 1_000n * USDC, margin: 250n * USDC });
    const mk = await marketState(e.market);
    const pos = await ctx.p.perp.account.position.fetch(pb);
    assert.equal(pos.borrowIdxEntry.toString(), mk.borrowIdxLong.toString(), "stamped with a stale index");
  });
});
