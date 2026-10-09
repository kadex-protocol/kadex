/**
 * LP return and utilisation series — the pure parts. The on-chain round trip
 * is tests/integration/activity.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { lpReturn, utilisationSeries } from "../packages/sdk/dist/activity.js";

const U = 1_000_000n;
const exact = (price) => () => ({ price, exact: true });

test("USDC in, nothing out: return is value now minus what went in", () => {
  const r = lpReturn([{ kind: "deposit", ts: 10, usdc: 1_000n * U, fractions: 0n, shares: 1_000n * U }], 1_012n * U, exact(U));
  assert.deepEqual([r.contributed, r.withdrawn, r.return, r.firstDepositTs, r.approximate], [1_000n * U, 0n, 12n * U, 10, false]);
});

test("fractions are valued at the price of their time, and exits at the mark they used", () => {
  const r = lpReturn(
    [
      { kind: "deposit", ts: 5, usdc: 0n, fractions: 100n * U, shares: 97n * U },
      { kind: "withdraw", ts: 9, usdc: 10n * U, fractions: 20n * U, price: 1_500_000n, shares: 40n * U },
    ],
    60n * U,
    exact(1_200_000n),
  );
  assert.equal(r.contributed, 120n * U, "100 fractions at 1.20");
  assert.equal(r.withdrawn, 40n * U, "10 USDC + 20 fractions at 1.50");
  assert.equal(r.return, -20n * U);
});

test("a fraction deposit priced from a nearby price is flagged approximate", () => {
  const r = lpReturn([{ kind: "deposit", ts: 1, usdc: 0n, fractions: U, shares: U }], U, () => ({ price: U, exact: false }));
  assert.equal(r.approximate, true);
});

test("no events: nothing contributed, return is the value", () => {
  assert.deepEqual(lpReturn([], 0n, exact(U)), { contributed: 0n, withdrawn: 0n, valueNow: 0n, return: 0n, firstDepositTs: null, approximate: false });
});

test("utilisation follows opens exactly and closes by the closed position's notional", () => {
  const a = Keypair.generate().publicKey;
  const b = Keypair.generate().publicKey;
  const s = utilisationSeries([
    { kind: "close", ts: 30, position: a },
    { kind: "open", ts: 10, position: a, notional: 1_000n * U, oiAfter: 1_000n * U, cap: 8_000n * U },
    { kind: "open", ts: 20, position: b, notional: 3_000n * U, oiAfter: 4_000n * U, cap: 8_000n * U },
  ]);
  assert.deepEqual(s.map((p) => [p.ts, p.oi, p.utilization]), [
    [10, 1_000n * U, 125_000n],
    [20, 4_000n * U, 500_000n],
    [30, 3_000n * U, 375_000n],
  ]);
});

test("NEGATIVE: a close whose open is outside the window is skipped, not guessed", () => {
  const s = utilisationSeries([{ kind: "liquidate", ts: 5, position: Keypair.generate().publicKey }]);
  assert.deepEqual(s, []);
});
