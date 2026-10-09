/**
 * Price history read back from `PriceRefreshed` logs — the pure parts.
 * The on-chain round trip is in tests/integration/sdk.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import {
  PRICE_REFRESHED_DISCRIMINATOR,
  PRICE_REFRESHED_SIZE,
  decodePriceRefreshed,
  priceEventsFromLogs,
  signaturesByBucket,
  toSeries,
} from "../packages/sdk/dist/history.js";
import { PROGRAM_IDS } from "../packages/types/dist/index.js";

const ORACLE_PROGRAM = PROGRAM_IDS.oracle.toBase58();
const oracle = Keypair.generate().publicKey;

function eventBytes({ key = oracle, spot = 1n, twap = 2n, price = 1_000_000n, depth = 4n, state = 0, ts = 1_700_000_000n } = {}) {
  const out = new Uint8Array(PRICE_REFRESHED_SIZE);
  const view = new DataView(out.buffer);
  out.set(PRICE_REFRESHED_DISCRIMINATOR, 0);
  out.set(key.toBytes(), 8);
  view.setBigUint64(40, spot, true);
  view.setBigUint64(48, twap, true);
  view.setBigUint64(56, price, true);
  view.setBigUint64(64, depth, true);
  out[72] = state;
  view.setBigInt64(73, ts, true);
  return out;
}

const dataLine = (bytes) => `Program data: ${Buffer.from(bytes).toString("base64")}`;
const run = (program, ...inner) => [`Program ${program} invoke [1]`, ...inner, `Program ${program} success`];

test("the event discriminator is the one Anchor derives", () => {
  const anchor = [...createHash("sha256").update("event:PriceRefreshed").digest().subarray(0, 8)];
  assert.deepEqual([...PRICE_REFRESHED_DISCRIMINATOR], anchor);
});

test("decodePriceRefreshed reads every field at its offset", () => {
  const e = decodePriceRefreshed(eventBytes({ spot: 11n, twap: 22n, price: 33n, depth: 44n, state: 5, ts: -7n }));
  assert.ok(e.oracle.equals(oracle));
  assert.deepEqual([e.spot, e.twap, e.price, e.depthUsdc, e.state, e.ts], [11n, 22n, 33n, 44n, "catchingUp", -7n]);
});

test("NEGATIVE: a wrong size or discriminator throws instead of decoding garbage", () => {
  assert.throws(() => decodePriceRefreshed(eventBytes().subarray(0, 80)), /layout changed/);
  const bad = eventBytes();
  bad[0] ^= 1;
  assert.throws(() => decodePriceRefreshed(bad), /not a PriceRefreshed/);
});

test("an event logged by the oracle program is read", () => {
  const events = priceEventsFromLogs(run(ORACLE_PROGRAM, dataLine(eventBytes({ price: 1_234_567n }))), oracle);
  assert.equal(events.length, 1);
  assert.equal(events[0].price, 1_234_567n);
});

test("NEGATIVE: the same bytes logged by another program are ignored", () => {
  const forger = Keypair.generate().publicKey.toBase58();
  const logs = run(forger, dataLine(eventBytes({ price: 9_999_999n })));
  assert.deepEqual(priceEventsFromLogs(logs, oracle), []);
});

test("NEGATIVE: a forger's CPI into the oracle does not lend its log lines to the caller", () => {
  const forger = Keypair.generate().publicKey.toBase58();
  const logs = [
    `Program ${forger} invoke [1]`,
    `Program ${ORACLE_PROGRAM} invoke [2]`,
    dataLine(eventBytes({ price: 1_000_000n })),
    `Program ${ORACLE_PROGRAM} success`,
    dataLine(eventBytes({ price: 9_999_999n })), // back in the forger's frame
    `Program ${forger} success`,
  ];
  assert.deepEqual(priceEventsFromLogs(logs, oracle).map((e) => e.price), [1_000_000n]);
});

test("NEGATIVE: an event for a different oracle is ignored", () => {
  const other = Keypair.generate().publicKey;
  assert.deepEqual(priceEventsFromLogs(run(ORACLE_PROGRAM, dataLine(eventBytes({ key: other }))), oracle), []);
});

test("other programs' data lines and junk do not throw", () => {
  const logs = [...run(ORACLE_PROGRAM, "Program data: AAAA", "Program data: not base64 at all!"), ...run(ORACLE_PROGRAM, dataLine(eventBytes()))];
  assert.equal(priceEventsFromLogs(logs, oracle).length, 1);
});

test("signatures are bucketed newest first, failed and old ones dropped", () => {
  const sigs = [
    { signature: "d", blockTime: 1_000_610, err: null },
    { signature: "c", blockTime: 1_000_605, err: null },
    { signature: "x", blockTime: 1_000_604, err: { InstructionError: [0, "Custom"] } },
    { signature: "b", blockTime: 1_000_301, err: null },
    { signature: "a", blockTime: 999_000, err: null },
  ];
  const buckets = signaturesByBucket(sigs, 300, 1_000_000);
  assert.deepEqual([...buckets.entries()], [[1_000_500, ["d", "c"]], [1_000_200, ["b"]]]);
});

test("a bucket keeps only a few candidates", () => {
  const sigs = Array.from({ length: 10 }, (_, i) => ({ signature: `s${i}`, blockTime: 1_000_000 + i, err: null }));
  assert.equal(signaturesByBucket(sigs, 300, 0, 3).get(999_900).length, 3);
});

test("the series takes the last price per bucket and carries it across quiet buckets", () => {
  const events = [
    { ts: 1_000n, price: 10n },
    { ts: 1_100n, price: 12n }, // same bucket as 1_000, later: wins
    { ts: 1_950n, price: 15n },
  ];
  assert.deepEqual(toSeries(events, 300, 900, 2_100), [
    { ts: 900, price: 12n },
    { ts: 1_200, price: 12n },
    { ts: 1_500, price: 12n },
    { ts: 1_800, price: 15n },
    { ts: 2_100, price: 15n },
  ]);
});

test("NEGATIVE: no price is invented before the first event", () => {
  assert.deepEqual(toSeries([{ ts: 1_500n, price: 7n }], 300, 600, 1_800), [
    { ts: 1_500, price: 7n },
    { ts: 1_800, price: 7n },
  ]);
  assert.deepEqual(toSeries([], 300, 600, 1_800), []);
});
