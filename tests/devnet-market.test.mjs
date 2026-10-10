import { test } from "node:test";
import assert from "node:assert/strict";
import { clampStep, isqrt, planSwap, toWad, wave } from "../scripts/devnet-market.mjs";

const WAD = 1_000_000n;
const UNIT = 1_000_000n;
const POOL = { usdc: 50_000n * UNIT, fraction: 50_000n * UNIT };

const price = (r) => (r.usdc * WAD) / r.fraction;
const trade = (r, plan) => {
  const k = r.usdc * r.fraction;
  if (plan.input === "usdc") return { usdc: r.usdc + plan.amountIn, fraction: k / (r.usdc + plan.amountIn) };
  return { usdc: k / (r.fraction + plan.amountIn), fraction: r.fraction + plan.amountIn };
};
const near = (a, b, tolerance = 2n) => (a > b ? a - b : b - a) <= tolerance;

test("raising the price pays USD in, and lands on the target", () => {
  const plan = planSwap(POOL, 1_030_000n);
  assert.equal(plan.input, "usdc");
  assert.ok(near(price(trade(POOL, plan)), 1_030_000n), `landed at ${price(trade(POOL, plan))}`);
});

test("the USD it takes is R * (sqrt(1 + d) - 1), the depth ceiling's own formula", () => {
  const plan = planSwap(POOL, 1_030_000n);
  const expected = BigInt(Math.round(50_000 * (Math.sqrt(1.03) - 1) * 1e6));
  assert.ok(near(plan.amountIn, expected, 1_000n), `${plan.amountIn} vs ${expected}`);
});

test("lowering the price pays index tokens in, and lands on the target", () => {
  const plan = planSwap(POOL, 970_000n);
  assert.equal(plan.input, "fraction");
  assert.ok(near(price(trade(POOL, plan)), 970_000n), `landed at ${price(trade(POOL, plan))}`);
});

test("a lopsided pool is steered from where it is, not from 1.00", () => {
  const lopsided = { usdc: 61_000n * UNIT, fraction: 49_500n * UNIT };
  const target = 1_100_000n;
  const plan = planSwap(lopsided, target);
  assert.equal(plan.input, "fraction");
  assert.ok(near(price(trade(lopsided, plan)), target), `landed at ${price(trade(lopsided, plan))}`);
});

test("NEGATIVE: a target already met trades nothing", () => {
  assert.equal(planSwap(POOL, WAD).amountIn, 0n);
});

test("NEGATIVE: one trade never moves the price further than the step", () => {
  assert.equal(clampStep(WAD, 1_500_000n, 20_000n), 1_020_000n);
  assert.equal(clampStep(WAD, 500_000n, 20_000n), 980_000n);
  assert.equal(clampStep(WAD, 1_010_000n, 20_000n), 1_010_000n);
});

test("isqrt floors exactly, past what a double can hold", () => {
  const big = 123_456_789_012_345_678_901n;
  assert.equal(isqrt(big * big), big);
  assert.equal(isqrt(big * big - 1n), big - 1n);
  assert.equal(isqrt(0n), 0n);
  assert.throws(() => isqrt(-1n));
});

test("the wave starts at the base and stays inside its amplitude", () => {
  assert.equal(wave(WAD, 0.03, 600, 0), WAD);
  for (let secs = 0; secs <= 1_200; secs += 7) {
    const p = wave(WAD, 0.03, 600, secs);
    assert.ok(p >= 970_000n && p <= 1_030_000n, `${p} at ${secs}s`);
  }
  assert.equal(wave(WAD, 0.03, 600, 150), 1_030_000n);
});

test("NEGATIVE: a price that is not a positive number is refused", () => {
  assert.equal(toWad("1.03"), 1_030_000n);
  for (const bad of ["0", "-1", "abc", ""]) assert.throws(() => toWad(bad), /not a positive number/);
});
