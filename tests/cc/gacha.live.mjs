/**
 * Live check: does Collector Crypt's gacha API answer, and does every machine
 * parse? Hits the network. Run with `npm run test:cc:live`, which loads
 * apps/web/.env.local so COLLECTOR_CRYPT_GACHA_API_KEY is picked up.
 *
 * The public house endpoints are always checked. The keyed ones are checked
 * when the key is set, and reported as skipped when it is not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchGachaMachines, fetchGachaStock, gachaApiKeyFromEnv } from "../../packages/collector-crypt/dist/gacha.js";

const key = gachaApiKeyFromEnv();

test("live: the public house machines answer and every one parses", async () => {
  const out = await fetchGachaMachines({ scope: "house", apiKey: "" });
  assert.ok(out.machines.length > 0, "at least one house machine");
  assert.deepEqual(out.rejected, [], "every machine parses");
  console.log(`# house machines: ${out.machines.length}`);
});

test("live: the public stock answers and every machine parses", async () => {
  const out = await fetchGachaStock({ scope: "house", apiKey: "" });
  assert.ok(Object.keys(out.byMachine).length > 0);
  assert.deepEqual(out.rejected, []);
});

test("live: your machines, with COLLECTOR_CRYPT_GACHA_API_KEY", { skip: key ? false : "COLLECTOR_CRYPT_GACHA_API_KEY is not set" }, async () => {
  const out = await fetchGachaMachines({ scope: "mine", apiKey: key });
  assert.equal(out.scope, "mine");
  assert.deepEqual(out.rejected, [], "every one of your machines parses");
  console.log(`# your machines: ${out.machines.length}, enabled: ${out.machines.filter((m) => m.enabled).length}`);
  for (const m of out.machines) {
    console.log(`#   ${m.code}  enabled=${m.enabled}  ev=${Number(m.evUsdc) / 1e6}  flags=${JSON.stringify(m.flags)}`);
  }
});

test("live: your stock, with COLLECTOR_CRYPT_GACHA_API_KEY", { skip: key ? false : "COLLECTOR_CRYPT_GACHA_API_KEY is not set" }, async () => {
  const out = await fetchGachaStock({ scope: "mine", apiKey: key });
  assert.equal(out.scope, "mine");
  assert.deepEqual(out.rejected, [], "every tier count parses");
  for (const [code, tiers] of Object.entries(out.byMachine)) {
    console.log(`#   ${code}  ${Object.entries(tiers).map(([t, c]) => `${t}=${c.remaining}${c.low ? " (low)" : ""}`).join(" ")}`);
  }
});
