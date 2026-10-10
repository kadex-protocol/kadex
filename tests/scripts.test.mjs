import assert from "node:assert/strict";
import { test } from "node:test";
import { serviceEnv } from "../scripts/service.mjs";
import { equalWeightBps } from "../scripts/test-cards.mjs";

const record = {
  raydium: { pool: "PoolAddress" },
  protocol: { oracle: "OracleAddress", market: "MarketAddress" },
};

test("test cards share the index equally, capped at 15% each", () => {
  assert.equal(equalWeightBps(7), 1_428);
  assert.equal(equalWeightBps(10), 1_000);
  assert.equal(equalWeightBps(5), 1_500);
  assert.equal(equalWeightBps(1), 1_500);
  assert.throws(() => equalWeightBps(0));
});

test("the keeper reads its oracle and pool from the deployment record", () => {
  const env = serviceEnv("keeper", record);
  assert.equal(env.ORACLE, "OracleAddress");
  assert.equal(env.AMM_POOL, "PoolAddress");
  assert.match(env.RPC_URL, /^https?:\/\//);
  assert.ok(env.KEEPER_KEYPAIR);
});

test("the liquidator reads its market from the deployment record", () => {
  const env = serviceEnv("liquidator", record);
  assert.equal(env.MARKET, "MarketAddress");
  assert.ok(env.LIQUIDATOR_KEYPAIR);
  assert.match(env.IDL_DIR, /target/);
});

test("a value already in the environment wins over the record", () => {
  const env = serviceEnv("keeper", record, { ORACLE: "Override", RPC_URL: "http://127.0.0.1:8899" });
  assert.equal(env.ORACLE, "Override");
  assert.equal(env.RPC_URL, "http://127.0.0.1:8899");
});

test("a record without the protocol step is refused, as is an unknown service", () => {
  assert.throws(() => serviceEnv("keeper", {}), /ORACLE, AMM_POOL/);
  assert.throws(() => serviceEnv("liquidator", { raydium: record.raydium }), /MARKET/);
  assert.throws(() => serviceEnv("feed", record), /unknown service/);
});
