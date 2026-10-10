/**
 * What every service and script shares (`@kadex/sdk/node`): loading a
 * signing key without ever echoing it, refusing bad numeric config, and
 * keeping RPC credentials out of logs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { intFromEnv, KeypairError, loadKeypair, redactUrl } from "../packages/sdk/dist/node.js";

const dir = mkdtempSync(join(tmpdir(), "kadex-keys-"));
const file = (name, text, mode = 0o600) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  chmodSync(p, mode);
  return p;
};
const real = Keypair.generate();
const secretText = JSON.stringify(Array.from(real.secretKey));
/** Any run of the secret's bytes, as it would appear in a quoted snippet. */
const leaks = (msg) => msg.includes(secretText.slice(1, 13)) || msg.includes(secretText.slice(-13, -1));

test("a valid keypair loads, quietly when only its owner can read it", () => {
  const warnings = [];
  const k = loadKeypair(file("ok.json", secretText), "TEST_KEYPAIR", (w) => warnings.push(w));
  assert.ok(k.publicKey.equals(real.publicKey));
  assert.deepEqual(warnings, []);
});

test("a keypair readable by others loads with a warning", () => {
  const warnings = [];
  loadKeypair(file("open.json", secretText, 0o644), "TEST_KEYPAIR", (w) => warnings.push(w));
  assert.match(warnings[0], /readable by other users; chmod 600/);
});

test("a missing setting or file names the variable to fix", () => {
  assert.throws(() => loadKeypair(undefined, "FEED_KEYPAIR"), /missing env FEED_KEYPAIR/);
  assert.throws(() => loadKeypair(join(dir, "nope.json"), "FEED_KEYPAIR"), /FEED_KEYPAIR: cannot read .*\(ENOENT\)/);
});

test("a corrupted keypair file never echoes its contents", () => {
  const corrupt = [
    secretText.replace(",", ",x"), // a stray token, which V8 quotes along with the bytes around it
    secretText.slice(0, -10), // truncated
    secretText.replace("[", "{"),
    JSON.stringify(Array.from(real.secretKey).slice(0, 32)), // half a key
    JSON.stringify([...Array.from(real.secretKey).slice(0, 63), 300]), // a byte out of range
  ];
  corrupt.forEach((text, i) => {
    let message = "";
    try {
      loadKeypair(file(`bad${i}.json`, text), "FEED_KEYPAIR");
    } catch (e) {
      assert.ok(e instanceof KeypairError, `case ${i} threw ${e?.name}`);
      message = e.message;
    }
    assert.ok(message, `case ${i} loaded`);
    assert.ok(!leaks(message), `case ${i} leaked: ${message}`);
  });
  // And raw JSON.parse would have, which is the point.
  try {
    JSON.parse(corrupt[0]);
  } catch (e) {
    assert.ok(/is not valid JSON/.test(e.message));
  }
});

test("64 bytes whose public half does not match the secret are refused", () => {
  const other = Keypair.generate();
  const mixed = [...Array.from(real.secretKey).slice(0, 32), ...Array.from(other.publicKey.toBytes())];
  assert.throws(() => loadKeypair(file("mixed.json", JSON.stringify(mixed)), "FEED_KEYPAIR"), /not a valid ed25519 keypair/);
});

test("numeric config is an integer at or above its floor, or refused", () => {
  assert.equal(intFromEnv("INTERVAL_MS", 5_000, 500, {}), 5_000);
  assert.equal(intFromEnv("INTERVAL_MS", 5_000, 500, { INTERVAL_MS: "" }), 5_000);
  assert.equal(intFromEnv("INTERVAL_MS", 5_000, 500, { INTERVAL_MS: "2000" }), 2_000);
  for (const bad of ["5s", "abc", "1.5", "-1", "100", "NaN", "Infinity"]) {
    assert.throws(() => intFromEnv("INTERVAL_MS", 5_000, 500, { INTERVAL_MS: bad }), /INTERVAL_MS must be an integer of at least 500/, bad);
  }
});

test("RPC URLs are logged without their credentials", () => {
  assert.equal(redactUrl("http://127.0.0.1:8899"), "http://127.0.0.1:8899");
  assert.equal(redactUrl("https://api.devnet.solana.com"), "https://api.devnet.solana.com");
  assert.equal(redactUrl("https://mainnet.helius-rpc.com/?api-key=SECRET"), "https://mainnet.helius-rpc.com/…");
  assert.equal(redactUrl("https://solana-mainnet.g.alchemy.com/v2/SECRET"), "https://solana-mainnet.g.alchemy.com/…");
  assert.equal(redactUrl("https://user:SECRET@rpc.example.com"), "https://rpc.example.com/…");
  assert.equal(redactUrl("not a url SECRET"), "<unparseable url>");
});
