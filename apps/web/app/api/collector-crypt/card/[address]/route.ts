import { NextResponse } from "next/server";
import { collectorCryptLimits, fetchCard } from "@kadex/collector-crypt";
import { SOLANA_ADDRESS, toWire } from "@/lib/collectorCrypt";

const cached: typeof fetch = (input, init) => fetch(input, { ...init, next: { revalidate: 60 } });

export async function GET(_req: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!SOLANA_ADDRESS.test(address)) {
    return NextResponse.json({ error: "That is not a Solana address." }, { status: 400 });
  }
  try {
    return NextResponse.json({ card: toWire(await fetchCard(address, { fetch: cached, limits: collectorCryptLimits() })) });
  } catch (e) {
    console.error("Collector Crypt card request failed:", e);
    const missing = e instanceof Error && /answered 404/.test(e.message);
    return NextResponse.json(
      { error: missing ? "Collector Crypt has no card at that address." : "Collector Crypt is unreachable." },
      { status: missing ? 404 : 502 },
    );
  }
}
