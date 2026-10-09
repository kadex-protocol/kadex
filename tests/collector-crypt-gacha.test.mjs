/**
 * Collector Crypt gacha client, against real responses saved on 9 Oct 2026.
 * The live check is tests/cc/gacha.live.mjs (npm run test:cc:live).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GACHA_API,
  fetchGachaMachines,
  fetchGachaStock,
  parseMachine,
  parseTierCount,
  usdcFromDollars,
} from "../packages/collector-crypt/dist/gacha.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const MACHINES = fixture("cc_gacha_machines.json");
const STOCK = fixture("cc_gacha_stock.json");

function fakeFetch(routes, status = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const path = url.replace(GACHA_API, "");
    if (status[path]) return { ok: false, status: status[path], json: async () => ({}) };
    if (!(path in routes)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => routes[path] };
  };
  return { fetch, calls };
}

test("dollar numbers become native USDC, rounded once", () => {
  assert.equal(usdcFromDollars(50, "price"), 50_000_000n);
  assert.equal(usdcFromDollars(54.86571367572274, "ev"), 54_865_714n);
  assert.equal(usdcFromDollars(0, "price"), 0n);
});

test("NEGATIVE: a negative, missing or string amount is refused", () => {
  for (const bad of [-1, undefined, "50", Number.NaN, Infinity]) assert.throws(() => usdcFromDollars(bad, "price"), /not a dollar amount/);
});

test("every machine in the real response parses", async () => {
  const { fetch } = fakeFetch({ "/api/machines": MACHINES });
  const out = await fetchGachaMachines({ fetch, scope: "house" });
  assert.equal(out.scope, "house");
  assert.deepEqual(out.rejected, []);
  assert.equal(out.machines.length, MACHINES.machines.length);
  const elite = out.machines.find((m) => m.code === "pokemon_50");
  assert.equal(elite.priceUsdc, 50_000_000n);
  assert.equal(elite.evUsdc, 54_865_714n);
  assert.deepEqual(elite.tierRanges.epic, { startUsdc: 250_000_000n, endUsdc: 5_001_000_000n });
  assert.deepEqual(elite.stock.epic, { remaining: 200, low: null });
  assert.equal(elite.odds.common, 0.8);
  assert.equal(elite.owner, null);
  assert.equal(elite.enabled, null, "the public endpoint does not report live status");
});

test("a partner machine keeps its owner wallet", () => {
  const partner = parseMachine(MACHINES.machines.find((m) => m.owner));
  assert.match(partner.owner, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
});

test("without a key, the public house endpoints are called with no key header", async () => {
  const { fetch, calls } = fakeFetch({ "/api/machines": MACHINES, "/api/stock": STOCK });
  await fetchGachaMachines({ fetch, apiKey: "" });
  await fetchGachaStock({ fetch, apiKey: "" });
  assert.deepEqual(calls.map((c) => c.url), [`${GACHA_API}/api/machines`, `${GACHA_API}/api/stock`]);
  for (const c of calls) assert.equal(c.headers["x-api-key"], undefined);
});

test("with a key, the v1 endpoints are called and the key goes out as x-api-key", async () => {
  const { fetch, calls } = fakeFetch({ "/api/v1/machines": MACHINES, "/api/v1/stock": STOCK });
  const machines = await fetchGachaMachines({ fetch, apiKey: "k_test" });
  const stock = await fetchGachaStock({ fetch, apiKey: "k_test" });
  assert.equal(machines.scope, "mine");
  assert.equal(stock.scope, "mine");
  assert.deepEqual(calls.map((c) => c.url), [`${GACHA_API}/api/v1/machines`, `${GACHA_API}/api/v1/stock`]);
  for (const c of calls) {
    assert.equal(c.headers["x-api-key"], "k_test");
    assert.equal(c.headers.authorization, undefined, "not the marketplace's bearer token");
  }
});

test("the key is read from COLLECTOR_CRYPT_GACHA_API_KEY", async () => {
  const before = process.env.COLLECTOR_CRYPT_GACHA_API_KEY;
  process.env.COLLECTOR_CRYPT_GACHA_API_KEY = "  from_env  ";
  try {
    const { fetch, calls } = fakeFetch({ "/api/v1/machines": MACHINES });
    await fetchGachaMachines({ fetch });
    assert.equal(calls[0].headers["x-api-key"], "from_env");
  } finally {
    if (before === undefined) delete process.env.COLLECTOR_CRYPT_GACHA_API_KEY;
    else process.env.COLLECTOR_CRYPT_GACHA_API_KEY = before;
  }
});

test("NEGATIVE: asking for your own machines without a key fails before any request", async () => {
  const { fetch, calls } = fakeFetch({});
  await assert.rejects(fetchGachaMachines({ fetch, apiKey: "", scope: "mine" }), /COLLECTOR_CRYPT_GACHA_API_KEY/);
  assert.equal(calls.length, 0);
});

test("NEGATIVE: a rejected key says so, instead of a bare status", async () => {
  const { fetch } = fakeFetch({}, { "/api/v1/machines": 401 });
  await assert.rejects(fetchGachaMachines({ fetch, apiKey: "wrong" }), /refused the API key \(401\)/);
});

test("NEGATIVE: a response without machines fails loudly", async () => {
  const { fetch } = fakeFetch({ "/api/machines": { data: [] } });
  await assert.rejects(fetchGachaMachines({ fetch, scope: "house" }), /changed shape/);
});

test("one malformed machine is reported, not fatal", async () => {
  const broken = { ...MACHINES.machines[0], code: "broken", price: "fifty" };
  const { fetch } = fakeFetch({ "/api/machines": { machines: [...MACHINES.machines, broken] } });
  const out = await fetchGachaMachines({ fetch, scope: "house" });
  assert.equal(out.machines.length, MACHINES.machines.length);
  assert.deepEqual(out.rejected.map((r) => r.code), ["broken"]);
  assert.match(out.rejected[0].reason, /price/);
});

test("stock parses per machine and tier, an empty machine included", async () => {
  const { fetch } = fakeFetch({ "/api/stock": STOCK });
  const out = await fetchGachaStock({ fetch, scope: "house" });
  assert.deepEqual(out.rejected, []);
  assert.deepEqual(out.byMachine.pokemon_50.common, { remaining: 324, low: null });
  assert.deepEqual(out.byMachine.charizard_50.epic, { remaining: 0, low: null });
});

test("a tier count with a low-stock flag, as the keyed endpoint describes, is read", () => {
  assert.deepEqual(parseTierCount({ remaining: 3, low: true }, "x"), { remaining: 3, low: true });
  assert.deepEqual(parseTierCount({ stock: 40, isLow: false }, "x"), { remaining: 40, low: false });
  assert.deepEqual(parseTierCount({ count: 7 }, "x"), { remaining: 7, low: null });
});

test("NEGATIVE: a tier count that is not a whole, non-negative number is refused", () => {
  for (const bad of [-1, 1.5, "3", null, { low: true }]) assert.throws(() => parseTierCount(bad, "x"), /not a count/);
});
