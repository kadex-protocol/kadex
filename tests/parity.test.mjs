/**
 * Parity between `packages/slab-math` (Rust) and `packages/sdk/src/math.ts`.
 *
 * The vectors below are EXACTLY the ones asserted in the Rust tests. If the
 * two implementations drift apart, this file fails — before the frontend can
 * show a liquidation price different from the one the program will use.
 *
 *     node --test tests/parity.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as m from "../packages/sdk/src/math.ts";
import { gates } from "../packages/types/src/index.ts";
import { readFile } from "node:fs/promises";

const USDC = 1_000_000n;
const WAD = m.WAD;

test("mul_div rounds in the declared direction", () => {
  assert.equal(m.mulDivFloor(10n, 1n, 3n), 3n);
  assert.equal(m.mulDivCeil(10n, 1n, 3n), 4n);
  assert.equal(m.mulDivFloor(9n, 1n, 3n), 3n);
  assert.equal(m.mulDivCeil(9n, 1n, 3n), 3n);
});

test("isqrt matches the Rust", () => {
  assert.equal(m.isqrt(0n), 0n);
  assert.equal(m.isqrt(3n), 1n);
  assert.equal(m.isqrt(4n), 2n);
  assert.equal(m.isqrt(8n), 2n);
  assert.equal(m.isqrt(1_000_000n), 1_000n);
  for (let n = 1n; n < 2_000n; n++) {
    const r = m.isqrt(n);
    assert.ok(r * r <= n && (r + 1n) * (r + 1n) > n, `isqrt(${n})`);
  }
});

test("sqrt_wad identity", () => {
  assert.equal(m.sqrtWad(WAD), WAD);
  assert.equal(m.sqrtWad(4n * WAD), 2n * WAD);
  const r = m.sqrtWad(WAD + 187_500n);
  assert.ok(r >= 1_089_000n && r <= 1_090_000n, `got ${r}`);
});

test("solvency ceiling matches the Rust", () => {
  const cap = m.oiCapSolvency(140_000n * USDC, WAD / 2n, 300_000n);
  assert.equal(cap / USDC, 233_333n);
});

test("depth ceiling matches the Rust", () => {
  const cap = m.oiCapDepth(60_000n * USDC, 187_500n, 300_000n);
  assert.equal(cap / USDC, 17_944n);
});

test("the lower ceiling always wins", () => {
  const solv = m.oiCapSolvency(140_000n * USDC, WAD / 2n, 300_000n);
  const depth = m.oiCapDepth(60_000n * USDC, 187_500n, 300_000n);
  assert.equal(m.oiAllowed(solv, depth), depth);
  const deep = m.oiCapDepth(5_000_000n * USDC, 187_500n, 300_000n);
  assert.equal(m.oiAllowed(solv, deep), solv);
});

test("utilization saturates and handles zero capacity", () => {
  assert.equal(m.utilization(0n, 0n), 0n);
  assert.equal(m.utilization(1n, 0n), WAD);
  assert.equal(m.utilization(50n, 100n), WAD / 2n);
  assert.equal(m.utilization(200n, 100n), WAD);
});

test("borrow is quadratic in utilization", () => {
  assert.equal(m.borrowRateHourly(0n, WAD, WAD / 2n), WAD / 4n);
  assert.equal(m.borrowRateHourly(0n, WAD, WAD / 4n), WAD / 16n);
  assert.equal(m.borrowRateHourly(50n, 500n, 0n), 50n);
  assert.equal(m.borrowRateHourly(50n, 500n, WAD), 550n);
});

test("the crowded side pays more, the thin side pays no premium", () => {
  const psi = WAD / 2n;
  assert.equal(m.sideMultiplier(100n, 100n, psi), WAD);
  assert.equal(m.sideMultiplier(10n, 90n, psi), WAD);
  assert.equal(m.sideMultiplier(0n, 0n, psi), WAD);
  assert.equal(m.sideMultiplier(90n, 10n, psi), WAD + 400_000n);
  assert.equal(m.sideMultiplier(100n, 0n, psi), WAD + 500_000n);
});

test("pnl is symmetric between sides", () => {
  const entry = WAD;
  const up = WAD + WAD / 5n;
  const n = 1_000n * USDC;
  const long = m.pnl("long", entry, up, n);
  const short = m.pnl("short", entry, up, n);
  assert.equal(long, 200n * USDC);
  assert.equal(short, -(200n * USDC));
  assert.equal(long + short, 0n);
});

test("liquidation price matches the Rust to the last unit", () => {
  const entry = WAD;
  const notional = 1_000n * USDC;
  const margin = notional / 5n;
  const maint = 62_500n;
  assert.equal(m.liquidationPrice("long", entry, margin, notional, 0n, maint), entry - 137_500n);
  assert.equal(m.liquidationPrice("short", entry, margin, notional, 0n, maint), entry + 137_500n);
});

test("minimum margin rounds up", () => {
  assert.equal(m.minMargin(1_000n, 5n * WAD), 200n);
  assert.equal(m.minMargin(1_000n, 3n * WAD), 334n);
});

test("borrow owed rejects an index moving backwards", () => {
  assert.throws(() => m.borrowOwed(1_000n, m.RAY, m.RAY - 1n));
  assert.throws(() => m.borrowOwed(1_000n, 0n, m.RAY));
  assert.equal(m.borrowOwed(1_000n, m.RAY, m.RAY), 0n);
  assert.equal(m.borrowOwed(1_000n, m.RAY, m.RAY + m.RAY / 100n), 10n);
});

test("nav deducts trader profit one for one", () => {
  const base = m.nav(140_000n * USDC, 60_000n * USDC, 0n, 0n);
  assert.equal(base, 200_000n * USDC);
  assert.equal(base - m.nav(140_000n * USDC, 60_000n * USDC, 640n * USDC, 0n), 640n * USDC);
  assert.equal(m.nav(1_000n, 0n, 0n, 400n), 600n);
  assert.equal(m.nav(1_000n, 0n, 0n, 5_000n), 0n);
});

test("withdrawal is proportional across both sleeves", () => {
  const usdc = 140_000n * USDC;
  const cards = 60_000n * USDC;
  const supply = 200_000n * USDC;
  const shares = supply / 10n;
  assert.equal(m.proportionalShare(usdc, shares, supply), 14_000n * USDC);
  assert.equal(m.proportionalShare(cards, shares, supply), 6_000n * USDC);
  assert.throws(() => m.proportionalShare(100n, 11n, 10n));
});

test("deposit then withdraw never creates value", () => {
  const nav0 = 200_000n * USDC;
  const supply0 = 200_000n * USDC;
  const dep = 5_000n * USDC;
  const shares = m.sharesForDeposit(dep, nav0, supply0);
  const back = m.assetsForShares(shares, nav0 + dep, supply0 + shares);
  assert.ok(back <= dep);
  assert.ok(dep - back <= 1n);
});

test("the pro-rata haircut is equal for everyone", () => {
  assert.equal(m.prorataHaircut(600n, 1_000n, 700n), 420n);
  assert.equal(m.prorataHaircut(400n, 1_000n, 700n), 280n);
  assert.equal(m.prorataHaircut(600n, 1_000n, 1_000n), 600n);
});

test("attacking costs more than the cascade pays, at the ceiling", () => {
  const depth = 60_000n * USDC;
  const mu = 300_000n;
  const deltaLiq = 187_500n;
  const cap = m.oiCapDepth(depth, deltaLiq, mu);
  const cost = m.costToMovePrice(depth, deltaLiq);
  assert.ok(cost >= m.mulWadFloor(cap, mu), `cost ${cost} < gain`);
});

test("the full hedge scenario from the spec", () => {
  const entry = WAD;
  const notional = 3_200n * USDC;
  const after = (WAD * 80n) / 100n;
  const cardLoss = -m.mulWadFloor(notional, (WAD * 20n) / 100n);
  const shortGain = m.pnl("short", entry, after, notional);
  assert.equal(shortGain, 640n * USDC);
  assert.equal(cardLoss + shortGain, 0n);
});

/**
 * The TypeScript `gates` mirror must agree with `MarketState::allows_*`.
 *
 * This drifted once already: close and liquidate became unconditional in Rust
 * so a settled market could unwind, and the TS copy still said reduceOnly was
 * the last state that allowed them. The screen would have greyed out Close for
 * exactly the people whose margin was stuck.
 */
test("the gates mirror matches the Rust", async () => {
  const src = await readFile(
    new URL("../packages/slab-interface/src/lib.rs", import.meta.url),
    "utf8",
  );

  const rustAllows = (fn) => {
    const body = src.match(new RegExp(`pub fn ${fn}\\(&self\\) -> bool \\{([^}]*)\\}`))?.[1];
    assert.ok(body, `could not find ${fn} in the Rust`);
    if (body.trim() === "true") return () => true;
    const states = [...body.matchAll(/MarketState::(\w+)/g)].map((m) =>
      m[1][0].toLowerCase() + m[1].slice(1),
    );
    return (s) => states.includes(s);
  };

  const pairs = [
    ["allows_open", "canOpen"],
    ["allows_close", "canClose"],
    ["allows_liquidate", "canLiquidate"],
    ["allows_deposit", "canDeposit"],
    ["allows_withdraw", "canWithdraw"],
  ];

  for (const state of ["active", "reduceOnly", "settled"]) {
    const ts = gates(state);
    for (const [rustFn, tsKey] of pairs) {
      assert.equal(
        ts[tsKey],
        rustAllows(rustFn)(state),
        `${tsKey} disagrees with ${rustFn} in state "${state}"`,
      );
    }
  }
});
