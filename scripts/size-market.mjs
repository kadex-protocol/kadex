#!/usr/bin/env node
/**
 * Issue #1 — how big is the market, for a given first deposit?
 *
 *     node scripts/size-market.mjs
 *     node scripts/size-market.mjs 150000 40000   # AMM depth, CLP sleeve
 *
 * Nobody can answer "who provides the first liquidity" without knowing what it
 * buys. This prints that: the open-interest ceiling, which ceiling binds, and
 * what an attacker would have to spend to move the price far enough to
 * liquidate at that size.
 *
 * It is a calculator, not a decision. The numbers it prints come from the same
 * formulas the program enforces, so what you see here is what the chain will
 * do.
 */

const WAD = 1_000_000n;

// Defaults from PoolParams / docs/invariants.md
const PHI = 500_000n;        // 0.50  share of the USDC sleeve committable
const DELTA_MAX = 300_000n;  // 0.30  adverse move the sleeve must absorb
const MU = 300_000n;         // 0.30  share of OI an attacker captures
const ATTACK_SAFETY = 2_000_000n; // 2x  attack must cost twice what it pays
const DELTA_LIQ = 187_500n;  // 0.1875 move that liquidates a 5x position
const USDC = 1_000_000n;     // amounts are micro-USDC, as on chain
const MIN_DEPTH = 25_000n * USDC; // $25k  below this the oracle stops pricing

const isqrt = (x) => {
  if (x < 2n) return x;
  let r = 1n << (BigInt(x.toString(2).length + 1) / 2n);
  for (;;) {
    const next = (r + x / r) / 2n;
    if (next >= r) return r;
    r = next;
  }
};
const sqrtWad = (x) => isqrt(x * WAD);
const mulWadCeil = (x, f) => (x * f + WAD - 1n) / WAD;

/** `U * phi / delta_max` */
const capSolvency = (sleeve) => (((sleeve * PHI) / WAD) * WAD) / DELTA_MAX;

/**
 * `R * (sqrt(1 + delta_liq) - 1) / (mu * attack_safety)`
 *
 * The program folds the safety factor into mu (kadex-risk `capacity`), rounding
 * up, so this does the same.
 */
const MU_EFFECTIVE = mulWadCeil(MU, ATTACK_SAFETY);
const capDepth = (depth) => {
  const factor = sqrtWad(WAD + DELTA_LIQ) - WAD;
  return (((depth * factor) / WAD) * WAD) / MU_EFFECTIVE;
};

/** What it costs to push a constant-product price to the liquidation point. */
const costToAttack = (depth) => (depth * (sqrtWad(WAD + DELTA_LIQ) - WAD)) / WAD;

const usd = (n) => "$" + Number(n / USDC).toLocaleString("en-US");

function row(depth, sleeve) {
  const s = capSolvency(sleeve);
  const d = capDepth(depth);
  const cap = s < d ? s : d;
  const binding = s < d ? "solvency" : "depth";
  const attack = costToAttack(depth);
  const gain = (cap * MU) / WAD;
  return { depth, sleeve, s, d, cap, binding, attack, gain, safe: attack >= gain * (ATTACK_SAFETY / WAD) };
}

const [argDepth, argSleeve] = process.argv.slice(2).map(Number);

if (argDepth) {
  const r = row(BigInt(argDepth) * USDC, BigInt(argSleeve || argDepth * 2) * USDC);
  console.log(`AMM depth        ${usd(r.depth)}`);
  console.log(`CLP USDC sleeve  ${usd(r.sleeve)}`);
  console.log(`\nsolvency ceiling ${usd(r.s)}`);
  console.log(`depth ceiling    ${usd(r.d)}`);
  console.log(`open interest    ${usd(r.cap)}   <- limited by ${r.binding}`);
  console.log(`\ncost to attack   ${usd(r.attack)}`);
  console.log(`attacker's gain  ${usd(r.gain)}`);
  console.log(
    r.safe
      ? `\nattacking costs ${Number(ATTACK_SAFETY / WAD)}x what it pays`
      : "\nATTACKING PAYS - do not launch at this size",
  );
  if (r.depth < MIN_DEPTH) {
    console.log(`\nWARNING: below the ${usd(MIN_DEPTH)} depth floor, the oracle refuses to price at all`);
  }
  process.exit(0);
}

console.log("What the first deposit buys. Sleeve assumed at 2x the AMM depth.\n");
console.log("  AMM depth    CLP sleeve   max OI     binding    attack cost  attacker gain");
console.log("  " + "-".repeat(76));
for (const dollars of [10_000n, 25_000n, 50_000n, 100_000n, 250_000n, 500_000n, 1_000_000n]) {
  const depth = dollars * USDC;
  const r = row(depth, depth * 2n);
  const flag = r.depth < MIN_DEPTH ? "  (below floor)" : r.safe ? "" : "  UNSAFE";
  console.log(
    "  " +
      usd(r.depth).padEnd(13) +
      usd(r.sleeve).padEnd(13) +
      usd(r.cap).padEnd(11) +
      r.binding.padEnd(11) +
      usd(r.attack).padEnd(13) +
      usd(r.gain) +
      flag,
  );
}

console.log(`
Reading this:

- The depth ceiling binds at every size here. Adding USDC to the pool does
  almost nothing for market size; adding liquidity to the AMM does all of it.
- "attack cost" is what someone spends to push the price far enough to
  liquidate a 5x position. "attacker gain" is the most they take from the
  cascade at the maximum open interest. The program caps open interest so the
  first is at least ${Number(ATTACK_SAFETY / WAD)}x the second.
- Below ${usd(MIN_DEPTH)} the oracle reports ShallowDepth and will not price
  risk at all, so that is the floor, not a target.

A demo needs enough that the ceiling is not the first thing a judge notices.
$50k of AMM depth gives roughly $7.5k of open interest, which carries the
$3,200 hedge in the product mock with room to spare.
`);
