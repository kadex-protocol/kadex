import { NextResponse } from "next/server";
import { IS_SAMPLE, borrowSpread, loadMarket } from "@/lib/market";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snapshot = await loadMarket();
    const spread = borrowSpread(snapshot);

    return NextResponse.json({
      oraclePrice: snapshot.oracle.price.toString(),
      longBorrowMonthlyPercent: spread.longMonthly,
      shortBorrowMonthlyPercent: spread.shortMonthly,
      spreadMonthlyPercent: spread.spread,
      crowdedSide: spread.crowded,
      paidSide: spread.paidSide,
      remainingCapacity: {
        long: snapshot.capacity.free.toString(),
        short: snapshot.capacity.free.toString(),
      },
      poolNav: snapshot.poolStats.nav.toString(),
      oracleUpdatedAt: snapshot.oracle.lastUpdateTs > 0n ? new Date(Number(snapshot.oracle.lastUpdateTs) * 1000).toISOString() : null,
      timestamp: new Date().toISOString(),
      sample: IS_SAMPLE,
    });
  } catch (error) {
    console.error("Market request failed:", error);
    return NextResponse.json(
      { error: "Could not load the market." },
      { status: 502 },
    );
  }
}
