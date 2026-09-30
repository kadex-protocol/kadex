/**
 * Paridade entre `packages/slab-math` (Rust) e `packages/sdk/src/math.ts`.
 *
 * Os vetores abaixo sao EXATAMENTE os mesmos assertados nos testes Rust. Se
 * as duas implementacoes divergirem, este arquivo falha — antes de o frontend
 * mostrar um preco de liquidacao diferente do que o programa vai usar.
 *
 *     node --test tests/parity.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as m from "../packages/sdk/src/math.ts";

const USDC = 1_000_000n;
const WAD = m.WAD;

test("mul_div arredonda na direcao declarada", () => {
  assert.equal(m.mulDivFloor(10n, 1n, 3n), 3n);
  assert.equal(m.mulDivCeil(10n, 1n, 3n), 4n);
  assert.equal(m.mulDivFloor(9n, 1n, 3n), 3n);
  assert.equal(m.mulDivCeil(9n, 1n, 3n), 3n);
});

test("isqrt bate com o Rust", () => {
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

test("sqrt_wad identidade", () => {
  assert.equal(m.sqrtWad(WAD), WAD);
  assert.equal(m.sqrtWad(4n * WAD), 2n * WAD);
  const r = m.sqrtWad(WAD + 187_500n);
  assert.ok(r >= 1_089_000n && r <= 1_090_000n, `got ${r}`);
});

test("teto de solvencia bate com o Rust", () => {
  const cap = m.oiCapSolvency(140_000n * USDC, WAD / 2n, 300_000n);
  assert.equal(cap / USDC, 233_333n);
});

test("teto de profundidade bate com o Rust", () => {
  const cap = m.oiCapDepth(60_000n * USDC, 187_500n, 300_000n);
  assert.equal(cap / USDC, 17_944n);
});

test("o menor teto sempre manda", () => {
  const solv = m.oiCapSolvency(140_000n * USDC, WAD / 2n, 300_000n);
  const depth = m.oiCapDepth(60_000n * USDC, 187_500n, 300_000n);
  assert.equal(m.oiAllowed(solv, depth), depth);
  const deep = m.oiCapDepth(5_000_000n * USDC, 187_500n, 300_000n);
  assert.equal(m.oiAllowed(solv, deep), solv);
});

test("utilizacao satura e trata capacidade zero", () => {
  assert.equal(m.utilization(0n, 0n), 0n);
  assert.equal(m.utilization(1n, 0n), WAD);
  assert.equal(m.utilization(50n, 100n), WAD / 2n);
  assert.equal(m.utilization(200n, 100n), WAD);
});

test("borrow e quadratico na utilizacao", () => {
  assert.equal(m.borrowRateHourly(0n, WAD, WAD / 2n), WAD / 4n);
  assert.equal(m.borrowRateHourly(0n, WAD, WAD / 4n), WAD / 16n);
  assert.equal(m.borrowRateHourly(50n, 500n, 0n), 50n);
  assert.equal(m.borrowRateHourly(50n, 500n, WAD), 550n);
});

test("lado lotado paga mais, lado fino nao paga premio", () => {
  const psi = WAD / 2n;
  assert.equal(m.sideMultiplier(100n, 100n, psi), WAD);
  assert.equal(m.sideMultiplier(10n, 90n, psi), WAD);
  assert.equal(m.sideMultiplier(0n, 0n, psi), WAD);
  assert.equal(m.sideMultiplier(90n, 10n, psi), WAD + 400_000n);
  assert.equal(m.sideMultiplier(100n, 0n, psi), WAD + 500_000n);
});

test("pnl e simetrico entre os lados", () => {
  const entry = WAD;
  const up = WAD + WAD / 5n;
  const n = 1_000n * USDC;
  const long = m.pnl("long", entry, up, n);
  const short = m.pnl("short", entry, up, n);
  assert.equal(long, 200n * USDC);
  assert.equal(short, -(200n * USDC));
  assert.equal(long + short, 0n);
});

test("preco de liquidacao bate com o Rust ate a ultima unidade", () => {
  const entry = WAD;
  const notional = 1_000n * USDC;
  const margin = notional / 5n;
  const maint = 62_500n;
  assert.equal(m.liquidationPrice("long", entry, margin, notional, 0n, maint), entry - 137_500n);
  assert.equal(m.liquidationPrice("short", entry, margin, notional, 0n, maint), entry + 137_500n);
});

test("margem minima arredonda para cima", () => {
  assert.equal(m.minMargin(1_000n, 5n * WAD), 200n);
  assert.equal(m.minMargin(1_000n, 3n * WAD), 334n);
});

test("borrow devido rejeita indice que anda para tras", () => {
  assert.throws(() => m.borrowOwed(1_000n, m.RAY, m.RAY - 1n));
  assert.throws(() => m.borrowOwed(1_000n, 0n, m.RAY));
  assert.equal(m.borrowOwed(1_000n, m.RAY, m.RAY), 0n);
  assert.equal(m.borrowOwed(1_000n, m.RAY, m.RAY + m.RAY / 100n), 10n);
});

test("nav desconta lucro do trader um por um", () => {
  const base = m.nav(140_000n * USDC, 60_000n * USDC, 0n, 0n);
  assert.equal(base, 200_000n * USDC);
  assert.equal(base - m.nav(140_000n * USDC, 60_000n * USDC, 640n * USDC, 0n), 640n * USDC);
  assert.equal(m.nav(1_000n, 0n, 0n, 400n), 600n);
  assert.equal(m.nav(1_000n, 0n, 0n, 5_000n), 0n);
});

test("saque e proporcional nas duas mangas", () => {
  const usdc = 140_000n * USDC;
  const cards = 60_000n * USDC;
  const supply = 200_000n * USDC;
  const shares = supply / 10n;
  assert.equal(m.proportionalShare(usdc, shares, supply), 14_000n * USDC);
  assert.equal(m.proportionalShare(cards, shares, supply), 6_000n * USDC);
  assert.throws(() => m.proportionalShare(100n, 11n, 10n));
});

test("deposito seguido de saque nunca cria valor", () => {
  const nav0 = 200_000n * USDC;
  const supply0 = 200_000n * USDC;
  const dep = 5_000n * USDC;
  const shares = m.sharesForDeposit(dep, nav0, supply0);
  const back = m.assetsForShares(shares, nav0 + dep, supply0 + shares);
  assert.ok(back <= dep);
  assert.ok(dep - back <= 1n);
});

test("haircut pro-rata e igual para todos", () => {
  assert.equal(m.prorataHaircut(600n, 1_000n, 700n), 420n);
  assert.equal(m.prorataHaircut(400n, 1_000n, 700n), 280n);
  assert.equal(m.prorataHaircut(600n, 1_000n, 1_000n), 600n);
});

test("atacar custa mais do que a cascata paga, no teto", () => {
  const depth = 60_000n * USDC;
  const mu = 300_000n;
  const deltaLiq = 187_500n;
  const cap = m.oiCapDepth(depth, deltaLiq, mu);
  const cost = m.costToMovePrice(depth, deltaLiq);
  assert.ok(cost >= m.mulWadFloor(cap, mu), `custo ${cost} < lucro`);
});

test("cenario de hedge completo do spec", () => {
  const entry = WAD;
  const notional = 3_200n * USDC;
  const after = (WAD * 80n) / 100n;
  const cardLoss = -m.mulWadFloor(notional, (WAD * 20n) / 100n);
  const shortGain = m.pnl("short", entry, after, notional);
  assert.equal(shortGain, 640n * USDC);
  assert.equal(cardLoss + shortGain, 0n);
});
