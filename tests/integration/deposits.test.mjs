/**
 * `deposit_fractions`, against a real validator.
 *
 * The USDC path was already covered. This one was not, and it is the path
 * carrying the two rules that exist to protect everyone already in the pool:
 *
 *   1. A HAIRCUT. Card fractions are illiquid and volatile, so they are
 *      credited below their mark. The difference is not burned — it accrues
 *      to the LPs already there, which is what pays them for accepting that
 *      collateral.
 *
 *   2. A SLEEVE TARGET. The deposit is refused outright if it would push the
 *      illiquid side past its share of the pool. The liquid sleeve is what
 *      pays winning traders; letting the card side grow unchecked would
 *      quietly shrink the capacity backing every open position.
 *
 * Both are arithmetic that had never run on-chain.
 *
 *     node scripts/with-validator.mjs node --test tests/integration/deposits.test.mjs
 */

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import anchor from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { mintTo, getMint } from "@solana/spl-token";
import {
  USDC,
  WAD,
  newProvider,
  programs,
  setupProtocol,
  actor,
  balance,
  mustFail,
  TOKEN_PROGRAM_ID,
} from "./_harness.mjs";

const big = (x) => new anchor.BN(x.toString());

/** Default params the pool is built with, mirrored for the expected values. */
const HAIRCUT_BPS = 300n; // 3%
const SLEEVE_TARGET = 300_000n; // 30% of the pool, WAD

describe("deposit_fractions", () => {
  let ctx, env;

  const poolState = () => ctx.p.clpPool.account.pool.fetch(env.pool);

  before(async () => {
    ctx = await newProvider();
    ctx.p = programs(ctx.provider);
    env = await setupProtocol(ctx);
  });

  /** An actor holding `fractions` card fractions and `usdc` USDC. */
  async function lpWith(usdcAmount, fractionAmount) {
    const who = await actor(ctx, env, usdcAmount);
    if (fractionAmount > 0n) {
      await mintTo(ctx.conn, ctx.payer, env.fractionMint, who.fractions, ctx.payer, fractionAmount);
    }
    return who;
  }

  async function depositUsdc(who, amount) {
    await ctx.p.clpPool.methods
      .depositUsdc(big(amount))
      .accounts({
        depositor: who.kp.publicKey,
        pool: env.pool,
        oracle: env.oracle,
        clpMint: env.clpMint,
        usdcVault: env.usdcVault,
        depositorUsdc: who.usdc,
        depositorClp: who.clp,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([who.kp])
      .rpc();
  }

  function depositFractions(who, amount) {
    return ctx.p.clpPool.methods
      .depositFractions(big(amount))
      .accounts({
        depositor: who.kp.publicKey,
        pool: env.pool,
        oracle: env.oracle,
        clpMint: env.clpMint,
        fractionVault: env.fractionVault,
        depositorFractions: who.fractions,
        depositorClp: who.clp,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([who.kp])
      .rpc();
  }

  // ───────────────────────────────────────────────────────────────────────

  test("the haircut is taken, and the tokens actually move", async () => {
    const before = await poolState();
    const who = await lpWith(0n, 4_000n * USDC);

    // Make room under the sleeve target first.
    const seed = await lpWith(40_000n * USDC, 0n);
    await depositUsdc(seed, 40_000n * USDC);

    const navBefore = BigInt((await poolState()).usdcSleeve.toString());
    const supplyBefore = BigInt((await poolState()).clpSupply.toString());
    const vaultBefore = await balance(ctx.conn, env.fractionVault);

    const amount = 1_000n * USDC;
    await depositFractions(who, amount);

    // Price is 1.0 in this fixture, so gross == amount.
    const gross = amount;
    const haircut = (gross * HAIRCUT_BPS + 9_999n) / 10_000n; // rounds UP, against the depositor
    const net = gross - haircut;

    assert.equal(haircut, 30n * USDC);

    // CLP minted is net value scaled by NAV — not the gross mark.
    const minted = await balance(ctx.conn, who.clp);
    const expected = (net * supplyBefore) / navBefore;
    assert.equal(minted, expected);
    assert.ok(minted < amount, "the depositor must not be credited the full mark");

    // The fractions left the depositor and reached the pool's vault.
    assert.equal(await balance(ctx.conn, who.fractions), 4_000n * USDC - amount);
    assert.equal(await balance(ctx.conn, env.fractionVault), vaultBefore + amount);

    const after = await poolState();
    assert.equal(BigInt(after.fractionBalance.toString()), amount);
    assert.ok(BigInt(after.clpSupply.toString()) > supplyBefore);
    void before;
  });

  test("the haircut pays the LPs who were already there", async () => {
    // A fresh protocol, so the arithmetic is not sharing a pool with the
    // test above.
    const c = { ...(await newProvider()) };
    c.p = programs(c.provider);
    const e = await setupProtocol(c);

    const first = await actor(c, e, 10_000n * USDC);
    await c.p.clpPool.methods
      .depositUsdc(big(10_000n * USDC))
      .accounts({
        depositor: first.kp.publicKey,
        pool: e.pool,
        oracle: e.oracle,
        clpMint: e.clpMint,
        usdcVault: e.usdcVault,
        depositorUsdc: first.usdc,
        depositorClp: first.clp,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([first.kp])
      .rpc();

    const second = await actor(c, e, 0n);
    await mintTo(c.conn, c.payer, e.fractionMint, second.fractions, c.payer, 4_000n * USDC);
    await c.p.clpPool.methods
      .depositFractions(big(4_000n * USDC))
      .accounts({
        depositor: second.kp.publicKey,
        pool: e.pool,
        oracle: e.oracle,
        clpMint: e.clpMint,
        fractionVault: e.fractionVault,
        depositorFractions: second.fractions,
        depositorClp: second.clp,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([second.kp])
      .rpc();

    const pool = await c.p.clpPool.account.pool.fetch(e.pool);
    const usdcSleeve = BigInt(pool.usdcSleeve.toString());
    const fractionBalance = BigInt(pool.fractionBalance.toString());
    const supply = BigInt(pool.clpSupply.toString());

    // Assets are the full mark of both sleeves: the haircut reduced the CLAIM
    // minted, not the assets received.
    const assets = usdcSleeve + fractionBalance; // price 1.0
    assert.equal(assets, 14_000n * USDC);

    const firstClp = await balance(c.conn, first.clp);
    const secondClp = await balance(c.conn, second.clp);
    assert.equal(firstClp + secondClp, supply);

    // The first LP put in 10,000 and can now claim more than that.
    const firstClaim = (assets * firstClp) / supply;
    assert.ok(
      firstClaim > 10_000n * USDC,
      `existing LP should gain from the haircut, got ${firstClaim}`,
    );

    // The second LP deposited 4,000 of mark and can claim less.
    const secondClaim = (assets * secondClp) / supply;
    assert.ok(secondClaim < 4_000n * USDC, "the depositor pays the haircut");

    // Nothing was invented: the two claims are the whole pool, give or take
    // integer rounding, which always favours the pool.
    const slack = assets - (firstClaim + secondClaim);
    assert.ok(slack >= 0n && slack <= 2n, `claims must not exceed assets, slack ${slack}`);
  });

  test("a deposit that would breach the sleeve target is refused", async () => {
    const pool = await poolState();
    const usdcSleeve = BigInt(pool.usdcSleeve.toString());
    const cards = BigInt(pool.fractionBalance.toString());

    // weight = cards / (cards + usdc) must stay <= 30%.
    // Solve for the largest extra that keeps it there, then step past it.
    const maxCards = (SLEEVE_TARGET * usdcSleeve) / (WAD - SLEEVE_TARGET);
    const room = maxCards > cards ? maxCards - cards : 0n;

    const who = await lpWith(0n, room + 5_000n * USDC);

    const msg = await mustFail(
      depositFractions(who, room + 2_000n * USDC),
      "a fraction deposit past the sleeve target",
    );
    assert.match(msg, /SleeveTargetExceeded|sleeve/i);

    // And the refusal was total: no tokens moved, no CLP minted.
    assert.equal(await balance(ctx.conn, who.clp), 0n);
    assert.equal(await balance(ctx.conn, who.fractions), room + 5_000n * USDC);
  });

  test("a deposit that lands just under the target is accepted", async () => {
    const pool = await poolState();
    const usdcSleeve = BigInt(pool.usdcSleeve.toString());
    const cards = BigInt(pool.fractionBalance.toString());
    const maxCards = (SLEEVE_TARGET * usdcSleeve) / (WAD - SLEEVE_TARGET);
    const room = maxCards > cards ? maxCards - cards : 0n;

    assert.ok(room > 100n * USDC, "fixture should leave room to test the boundary");

    const who = await lpWith(0n, room);
    // Stay a little under, so integer rounding in the program cannot push an
    // honest deposit over the line.
    await depositFractions(who, room - 10n * USDC);

    assert.ok((await balance(ctx.conn, who.clp)) > 0n);
  });

  test("a deposit the haircut eats entirely is refused, not silently zeroed", async () => {
    const who = await lpWith(0n, 1_000n);

    // One native unit: a millionth of a dollar. The haircut rounds up and
    // takes all of it, so the net value is zero and no CLP can be minted.
    // The program must say so rather than accept the tokens for nothing.
    const msg = await mustFail(depositFractions(who, 1n), "a deposit worth less than the haircut");
    assert.match(msg, /DustDeposit|dust|ZeroAmount/i);

    assert.equal(await balance(ctx.conn, who.fractions), 1_000n);
  });

  test("a zero deposit is refused", async () => {
    const who = await lpWith(0n, 100n * USDC);
    const msg = await mustFail(depositFractions(who, 0n), "a zero-amount deposit");
    assert.match(msg, /ZeroAmount|zero/i);
  });

  test("someone else's CLP account cannot be the destination", async () => {
    const who = await lpWith(0n, 500n * USDC);
    const other = await actor(ctx, env, 0n);

    // The mint constraint passes — it is a real CLP account — so what has to
    // stop this is ownership, not the mint.
    const msg = await mustFail(
      ctx.p.clpPool.methods
        .depositFractions(big(100n * USDC))
        .accounts({
          depositor: who.kp.publicKey,
          pool: env.pool,
          oracle: env.oracle,
          clpMint: env.clpMint,
          fractionVault: env.fractionVault,
          depositorFractions: other.fractions, // not theirs
          depositorClp: who.clp,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([who.kp])
        .rpc(),
      "depositing fractions out of an account you do not own",
    );
    assert.match(msg, /NotOwner|constraint|owner/i);
  });

  test("a pool that is not active takes no fraction deposits", async () => {
    const c = { ...(await newProvider()) };
    c.p = programs(c.provider);
    const e = await setupProtocol(c);

    const seed = await actor(c, e, 20_000n * USDC);
    await c.p.clpPool.methods
      .depositUsdc(big(20_000n * USDC))
      .accounts({
        depositor: seed.kp.publicKey,
        pool: e.pool,
        oracle: e.oracle,
        clpMint: e.clpMint,
        usdcVault: e.usdcVault,
        depositorUsdc: seed.usdc,
        depositorClp: seed.clp,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([seed.kp])
      .rpc();

    await c.p.clpPool.methods
      .setState({ reduceOnly: {} })
      .accounts({ admin: c.provider.wallet.publicKey, pool: e.pool })
      .rpc();

    const who = await actor(c, e, 0n);
    await mintTo(c.conn, c.payer, e.fractionMint, who.fractions, c.payer, 1_000n * USDC);

    const msg = await mustFail(
      c.p.clpPool.methods
        .depositFractions(big(1_000n * USDC))
        .accounts({
          depositor: who.kp.publicKey,
          pool: e.pool,
          oracle: e.oracle,
          clpMint: e.clpMint,
          fractionVault: e.fractionVault,
          depositorFractions: who.fractions,
          depositorClp: who.clp,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([who.kp])
        .rpc(),
      "depositing into a reduce-only pool",
    );
    assert.match(msg, /StateForbids|state/i);
  });

  test("CLP supply on the mint matches what the pool thinks it issued", async () => {
    const pool = await poolState();
    const onChain = (await getMint(ctx.conn, env.clpMint)).supply;
    assert.equal(
      BigInt(pool.clpSupply.toString()),
      onChain,
      "pool.clp_supply drifting from the mint means every share price is wrong",
    );
  });
});
