/**
 * Parameter A/B, by simulation.
 *
 * There is no deployment and there are no users, so there is no product A/B to
 * run. What can be tested is the thing that actually decides whether the
 * design survives: do the risk parameters do what they are supposed to?
 *
 * WHAT IS REAL HERE. Every protocol calculation uses the shipped maths from
 * `@slab/sdk` — the same functions the program calls. Utilization, borrow
 * rate, the side multiplier, both ceilings, PnL. None of it is re-implemented
 * for the simulation.
 *
 * WHAT IS A MODEL. Trader behaviour. Nobody knows how collectors will act, so
 * this assumes:
 *
 *   - a standing appetite to go LONG, because collecting is a buy-and-hold
 *     culture and betting a card falls is not a native instinct
 *   - that appetite is price-elastic: traders have a reservation cost and
 *     leave when borrow exceeds it
 *   - shorts are not collectors. They are arbitrageurs, who appear only when
 *     the long/short borrow spread is wide enough to pay them, plus a thin
 *     constant trickle of dealers hedging inventory
 *
 * Those assumptions are arguable, and the result is only as good as they are.
 * Change them at the top and re-run; that is the point of having the file.
 *
 *     node scripts/ab-test.mjs
 */

import * as m from "../packages/sdk/dist/math.js";

const USDC = 1_000_000n;
const WAD = 1_000_000n;
const HOURS = 24 * 90; // one quarter

// ── the model's assumptions, in one place ─────────────────────────────────

const MODEL = {
  /** Notional that wants to be long when borrowing is free. */
  longAppetite: 12_000n * USDC,
  /** Monthly borrow cost at which long demand reaches zero, WAD. */
  longReservationMonthly: 400_000n, // 40%/month
  /** Dealers hedging inventory, regardless of price. */
  hedgerFloor: 400n * USDC,
  /** Arbitrageurs need this much monthly spread before shorting, WAD. */
  arbThresholdMonthly: 40_000n, // 4%/month
  /** How much arb capital responds, per unit of spread above threshold. */
  arbResponse: 30_000n * USDC,
  /** Fraction of the gap to target closed each hour. */
  adjust: 0.08,
  /**
   * Momentum. A rising market pulls more buyers in, which is the whole danger
   * the pool faces: appetite is highest exactly when being short the market
   * hurts most. Measured against the price a week ago.
   *
   * Without this the simulation is far too kind - demand responds only to
   * borrow cost, so a bull run attracts nobody and the pool never gets run
   * over. That is not how collectors behave.
   */
  momentum: 1.8,
};

const BASE = {
  phi: 500_000n,
  deltaMax: 300_000n,
  deltaLiq: 187_500n,
  mu: 300_000n,
  attackSafety: 2_000_000n,
  r0: 50n,
  r1: 500n,
  psi: 500_000n,
  openCloseFeeBps: 10n,
  lpFeeShareBps: 7_500n,
};

// ── price scenarios ───────────────────────────────────────────────────────

const monthly = (hourlyWad) => Number(hourlyWad) / 1e6 * 24 * 30;

/** Deterministic paths, so A and B see exactly the same world. */
const SCENARIOS = {
  "steady climb +40%": (h) => 1 + 0.4 * (h / HOURS),
  "slow bleed -30%": (h) => 1 - 0.3 * (h / HOURS),
  "flat, choppy": (h) => 1 + 0.06 * Math.sin(h / 90),
  "spike then crash": (h) =>
    h < HOURS / 2 ? 1 + 0.5 * (h / (HOURS / 2)) : 1.5 - 0.8 * ((h - HOURS / 2) / (HOURS / 2)),
};

// ── one run ───────────────────────────────────────────────────────────────

function run(params, priceAt, { depth = 60_000n * USDC, sleeve = 140_000n * USDC } = {}) {
  let usdcSleeve = sleeve;
  let cardValue = 60_000n * USDC;
  const startNav = usdcSleeve + cardValue;

  let oiLong = 0n;
  let oiShort = 0n;
  let entryLong = WAD;
  let entryShort = WAD;
  let feesEarned = 0n;
  let borrowEarned = 0n;
  let minNav = startNav;
  let skewSum = 0;
  let skewN = 0;
  let hoursCapped = 0;
  const WARMUP = 24 * 7; // a week for OI to find its level

  for (let h = 0; h < HOURS; h++) {
    const price = BigInt(Math.round(priceAt(h) * Number(WAD)));

    // Capacity, from the real functions.
    const capSolvency = m.oiCapSolvency(usdcSleeve, params.phi, params.deltaMax);
    const muEff = m.mulWadCeil(params.mu, params.attackSafety);
    const capDepth = m.oiCapDepth(depth, params.deltaLiq, muEff);
    const cap = m.oiAllowed(capSolvency, capDepth);

    const u = m.utilization(oiLong + oiShort, cap);
    const base = m.borrowRateHourly(params.r0, params.r1, u);
    const rateLong = m.mulWadCeil(base, m.sideMultiplier(oiLong, oiShort, params.psi));
    const rateShort = m.mulWadCeil(base, m.sideMultiplier(oiShort, oiLong, params.psi));

    // Borrow accrues from traders to the pool. This is income regardless of
    // which way the price went.
    const owed =
      (oiLong * rateLong) / WAD + (oiShort * rateShort) / WAD;
    borrowEarned += owed;
    usdcSleeve += (owed * params.lpFeeShareBps) / 10_000n;

    // ── the model ──
    const costLong = monthly(rateLong);
    const resv = Number(MODEL.longReservationMonthly) / 1e6;
    const appetite = Math.max(0, 1 - costLong / resv);
    // Trailing week's price change, as a multiplier on appetite.
    const ref = priceAt(Math.max(0, h - 24 * 7));
    const drift = (priceAt(h) - ref) / ref;
    const chase = Math.max(0.2, 1 + MODEL.momentum * drift);
    let targetLong = BigInt(Math.round(Number(MODEL.longAppetite) * appetite * chase));

    const spread = monthly(rateLong) - monthly(rateShort);
    const thresh = Number(MODEL.arbThresholdMonthly) / 1e6;
    const arb = spread > thresh ? BigInt(Math.round(Number(MODEL.arbResponse) * (spread - thresh))) : 0n;
    let targetShort = MODEL.hedgerFloor + arb;

    // The ceiling is a hard limit, not a suggestion.
    if (targetLong + targetShort > cap) {
      hoursCapped++;
      const scale = Number(cap) / Number(targetLong + targetShort);
      targetLong = BigInt(Math.round(Number(targetLong) * scale));
      targetShort = BigInt(Math.round(Number(targetShort) * scale));
    }

    // Move toward target, charging the open/close fee on the change.
    const step = (now, target) => {
      const delta = target - now;
      return now + BigInt(Math.round(Number(delta) * MODEL.adjust));
    };
    const nextLong = step(oiLong, targetLong);
    const nextShort = step(oiShort, targetShort);
    const traded = abs(nextLong - oiLong) + abs(nextShort - oiShort);
    const fee = (traded * params.openCloseFeeBps) / 10_000n;
    feesEarned += fee;
    usdcSleeve += (fee * params.lpFeeShareBps) / 10_000n;

    // New notional enters at today's price; blended entry.
    if (nextLong > oiLong) entryLong = blend(entryLong, oiLong, price, nextLong - oiLong);
    if (nextShort > oiShort) entryShort = blend(entryShort, oiShort, price, nextShort - oiShort);
    oiLong = nextLong;
    oiShort = nextShort;

    // What traders are up, the pool is down. Real pnl function.
    const pnlLong = m.pnl("long", entryLong, price, oiLong);
    const pnlShort = m.pnl("short", entryShort, price, oiShort);
    const traderPnl = pnlLong + pnlShort;

    cardValue = (60_000n * USDC * price) / WAD;
    const nav = usdcSleeve + cardValue - (traderPnl > 0n ? traderPnl : 0n);
    if (nav < minNav) minNav = nav;

    const total = Number(oiLong + oiShort);
    if (h >= WARMUP && total > 0) {
      skewSum += Math.abs(Number(oiLong - oiShort)) / total;
      skewN++;
    }
  }

  const price = BigInt(Math.round(priceAt(HOURS - 1) * Number(WAD)));
  const traderPnl = m.pnl("long", entryLong, price, oiLong) + m.pnl("short", entryShort, price, oiShort);
  cardValue = (60_000n * USDC * price) / WAD;
  const endNav = usdcSleeve + cardValue - (traderPnl > 0n ? traderPnl : 0n);

  // The pool's card sleeve rises and falls with the market whatever the
  // parameters do. Mixing that in would drown the signal, so the A/B reports
  // the BOOK result — what the pool earned from traders minus what it paid
  // them — separately from the sleeve it happens to hold.
  const paidOut = traderPnl > 0n ? traderPnl : 0n;
  const income = feesEarned + borrowEarned;
  const bookPnl = income - paidOut;

  return {
    startNav,
    endNav,
    returnPct: (Number(endNav - startNav) / Number(startNav)) * 100,
    bookPct: (Number(bookPnl) / Number(startNav)) * 100,
    drawdownPct: (Number(minNav - startNav) / Number(startNav)) * 100,
    income,
    paidOut,
    traderPnl,
    avgSkewPct: skewN ? (skewSum / skewN) * 100 : 0,
    hoursCapped,
    endLong: oiLong,
    endShort: oiShort,
  };
}

const abs = (x) => (x < 0n ? -x : x);
const blend = (entry, size, price, added) =>
  size + added === 0n ? price : (entry * size + price * added) / (size + added);

// ── reporting ─────────────────────────────────────────────────────────────

const usd = (x) => (Number(x) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 });
const pct = (x) => (x >= 0 ? "+" : "") + x.toFixed(2) + "%";

function compare(title, question, variantA, variantB, labelA, labelB) {
  console.log("\n" + "═".repeat(78));
  console.log(title);
  console.log(question);
  console.log("═".repeat(78));

  console.log(
    "  scenario".padEnd(22) + labelA.padStart(12) + labelB.padStart(12) +
    "diff".padStart(9) + "avg skew".padStart(14),
  );
  console.log("  " + "─".repeat(69));

  const rows = [];
  for (const [name, path] of Object.entries(SCENARIOS)) {
    const a = run(variantA, path);
    const b = run(variantB, path);
    rows.push({ name, a, b });
    const diff = b.bookPct - a.bookPct;
    console.log(
      "  " + name.padEnd(20) +
      pct(a.bookPct).padStart(12) +
      pct(b.bookPct).padStart(12) +
      ((diff >= 0 ? "+" : "") + diff.toFixed(2)).padStart(9) +
      (a.avgSkewPct.toFixed(0) + "% → " + b.avgSkewPct.toFixed(0) + "%").padStart(14),
    );
  }
  return rows;
}

console.log("\nSLAB — parameter A/B");
console.log("90 days, hourly. Protocol maths real; trader behaviour modelled.");
console.log("Reported figure is the BOOK result: income from traders minus paid to traders,");
console.log("as % of pool NAV. The card sleeve's own rise and fall is excluded - no parameter");
console.log("controls that, and including it drowns the signal.");
console.log("Both variants see an identical price path, so the only difference is the parameter.");

// ── A/B 1 ─────────────────────────────────────────────────────────────────
const rows1 = compare(
  "A/B 1 — the skew multiplier (psi)",
  "Does charging the crowded side more actually protect the pool?",
  { ...BASE, psi: 0n },
  { ...BASE, psi: 500_000n },
  "psi off",
  "psi 0.5",
);

// ── A/B 2 ─────────────────────────────────────────────────────────────────
compare(
  "A/B 2 — the attack-safety factor",
  "It halves capacity. Does the pool earn less because of it?",
  { ...BASE, attackSafety: 1_000_000n },
  { ...BASE, attackSafety: 2_000_000n },
  "1x",
  "2x",
);

// ── A/B 3 ─────────────────────────────────────────────────────────────────
compare(
  "A/B 3 — borrow curve steepness (r1)",
  "A steeper curve pushes traders out sooner. Is that worth the lost income?",
  { ...BASE, r1: 250n },
  { ...BASE, r1: 1_000n },
  "r1 250",
  "r1 1000",
);

// ── the detail that matters ───────────────────────────────────────────────
console.log("\n" + "═".repeat(78));
console.log("Where the money came from  (steady climb, the scenario that hurts the pool)");
console.log("═".repeat(78));
for (const label of ["psi off", "psi 0.5"]) {
  const r = run(
    { ...BASE, psi: label === "psi off" ? 0n : 500_000n },
    SCENARIOS["steady climb +40%"],
  );
  console.log("\n  " + label);
  console.log("    income from fees + borrow ... " + usd(r.income).padStart(10) + " USDC");
  console.log("    paid out to traders ......... " + usd(r.paidOut).padStart(10) + " USDC");
  console.log("    book result ................. " + usd(r.income - r.paidOut).padStart(10) + " USDC   " + pct(r.bookPct));
  console.log("    average skew ................ " + r.avgSkewPct.toFixed(0).padStart(10) + "%");
  console.log("    ended long / short .......... " + usd(r.endLong) + " / " + usd(r.endShort));
}
console.log("");
