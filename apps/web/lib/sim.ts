import type { Side } from "@kadex/types";

const KEY = "kadex.sim.v1";
const UNIT = 1_000_000n;

export const LEDGER_EVENT = "kadex:ledger";

export interface SimPosition {
  address: string;
  side: Side;
  notional: bigint;
  margin: bigint;
  entryPrice: bigint;
  openedTs: bigint;
}

export interface SimCard {
  nftAddress: string;
  name: string;
  grade: string;
  image: string | null;
  minted: bigint;
}

export interface SimWallet {
  usdc: bigint;
  fractions: bigint;
  clp: bigint;
  positions: SimPosition[];
  cards: SimCard[];
}

export interface SimLedger {
  usdcSleeve: bigint;
  fractionBalance: bigint;
  clpSupply: bigint;
  oiLong: bigint;
  oiShort: bigint;
  wallets: Record<string, SimWallet>;
}

const freshLedger = (): SimLedger => ({
  usdcSleeve: 140_000n * UNIT,
  fractionBalance: 40_000n * UNIT,
  clpSupply: 180_000n * UNIT,
  oiLong: 4_200n * UNIT,
  oiShort: 1_800n * UNIT,
  wallets: {},
});

const freshWallet = (): SimWallet => ({ usdc: 10_000n * UNIT, fractions: 0n, clp: 0n, positions: [], cards: [] });

const encode = (_: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v);
const decode = (_: string, v: unknown) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);

let memory: SimLedger | null = null;

export function readLedger(): SimLedger {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw, decode) as SimLedger;
  } catch {}
  return (memory ??= freshLedger());
}

export const walletOf = (ledger: SimLedger, owner: string): SimWallet => ledger.wallets[owner] ?? freshWallet();

export function updateLedger(owner: string, change: (ledger: SimLedger, wallet: SimWallet) => void) {
  const ledger = readLedger();
  const wallet = (ledger.wallets[owner] ??= freshWallet());
  change(ledger, wallet);
  memory = ledger;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(ledger, encode));
    window.dispatchEvent(new Event(LEDGER_EVENT));
  } catch {}
}

export function isVaulted(ledger: SimLedger, nftAddress: string) {
  return Object.values(ledger.wallets).some((w) => w.cards.some((c) => c.nftAddress === nftAddress));
}

export const PRICE_STEP_SECS = 300;

function jitter(bucket: number) {
  let x = Math.imul(bucket ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296 - 0.5;
}

function drift(ts: number) {
  const slot = ts / 3;
  const base = Math.floor(slot);
  const ease = (slot - base) ** 2 * (3 - 2 * (slot - base));
  return jitter(base + 7919) * (1 - ease) + jitter(base + 7920) * ease;
}

export function simPrice(ts: number): bigint {
  const hours = ts / 3600;
  const wave = 0.028 * Math.sin(hours / 9.3) + 0.014 * Math.sin(hours / 2.1 + 1.7) + 0.006 * Math.sin(hours / 0.37 + 0.4);
  const ripple = 0.00035 * Math.sin(ts / 11.3) + 0.00022 * Math.sin(ts / 4.1 + 1.1) + drift(ts) * 0.0005;
  return BigInt(Math.round((1 + wave + ripple + jitter(Math.floor(ts / PRICE_STEP_SECS)) * 0.003) * 1e6));
}
