import { NextResponse } from "next/server";
import { fetchCard } from "@kadex/collector-crypt";
import { SOLANA_ADDRESS, toWire } from "@/lib/collectorCrypt";

const cached: typeof fetch = (input, init) => fetch(input, { ...init, next: { revalidate: 60 } });

export async function GET(_req: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!SOLANA_ADDRESS.test(address)) {
    return NextResponse.json({ error: "That is not a Solana address." }, { status: 400 });
  }
  try {
    return NextResponse.json({ card: toWire(await fetchCard(address, { fetch: cached })) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Collector Crypt is unreachable.";
    const missing = /answered 404/.test(message);
    return NextResponse.json(
      { error: missing ? "Collector Crypt has no card at that address." : message },
      { status: missing ? 404 : 502 },
    );
  }
}
