/**
 * What the services and scripts share: loading a signing key and reading
 * numeric config. Node only: imported as `@kadex/sdk/node`, never from the
 * browser bundle.
 *
 * ## Keypairs
 *
 * Why not `JSON.parse(readFileSync(path))`: when the file is malformed, V8's
 * error quotes the text around the fault (`Unexpected token 'x',
 * ..."[12,34,56,x8,90"... is not valid JSON`), so a truncated or hand-edited
 * keypair prints part of the secret key into the service's logs. Every error
 * here names the file and the problem, never its contents.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { Keypair } from "@solana/web3.js";

export class KeypairError extends Error {
  override name = "KeypairError";
}

const expand = (path: string) => path.replace(/^~(?=$|\/)/, homedir());

/**
 * `env` names the variable the path came from, so the message says what to
 * fix. `warn` receives a notice when the file is readable by group or others.
 */
export function loadKeypair(path: string | undefined, env: string, warn: (msg: string) => void = console.warn): Keypair {
  if (!path) throw new KeypairError(`missing env ${env}: the path to a Solana keypair file`);
  const file = expand(path);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new KeypairError(`${env}: cannot read ${file}${code ? ` (${code})` : ""}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new KeypairError(`${env}: ${file} is not valid keypair JSON (expected an array of 64 numbers)`);
  }
  if (!Array.isArray(raw) || raw.length !== 64 || !raw.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new KeypairError(`${env}: ${file} is not a keypair (expected an array of 64 bytes)`);
  }
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
  } catch {
    throw new KeypairError(`${env}: ${file} holds 64 bytes that are not a valid ed25519 keypair`);
  }
  try {
    if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
      warn(`${env}: ${file} is readable by other users; chmod 600 it`);
    }
  } catch {
    // The read succeeded; a failed stat only costs the warning.
  }
  return keypair;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * An integer from the environment, or `fallback` when unset. Anything else is
 * refused: `Number("5s")` is NaN, and `setTimeout(fn, NaN)` fires at once,
 * so a typo in an interval turns a polling loop into a tight one.
 */
export function intFromEnv(name: string, fallback: number, min = 1, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min) throw new ConfigError(`${name} must be an integer of at least ${min}, got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * An RPC URL fit for a log line. Hosted RPCs put the API key in the query
 * (`?api-key=…`), the path (`/v2/<key>`) or the userinfo, so only the scheme
 * and host are kept.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const hidden = u.username || u.password || u.search || (u.pathname !== "/" && u.pathname !== "");
    return `${u.protocol}//${u.host}${hidden ? "/…" : ""}`;
  } catch {
    return "<unparseable url>";
  }
}
