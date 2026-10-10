import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { CLUSTER } from "@/lib/cluster";
import type { TestCard } from "@/lib/testCards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!CLUSTER || CLUSTER.network === "mainnet") return NextResponse.json({ cards: [] });
  const path = process.env.KADEX_DEPLOYMENT ?? join(process.cwd(), "..", "..", "deployments", `${CLUSTER.network}.json`);
  try {
    const record = JSON.parse(await readFile(path, "utf8")) as { cards?: TestCard[] };
    return NextResponse.json({ cards: (record.cards ?? []).map(({ mainnet, asset, name }) => ({ mainnet, asset, name })) });
  } catch {
    return NextResponse.json({ cards: [] });
  }
}
