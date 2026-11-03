import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { CLUSTER } from "@/lib/cluster";
import { SOLANA_ADDRESS } from "@/lib/collectorCrypt";
import { holdingsOf, readCopyStates, readDeployment } from "@/lib/testCardsServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!CLUSTER || CLUSTER.network === "mainnet") return NextResponse.json({ cards: [], owned: [], vaulted: [], recorded: false });
  const deployment = await readDeployment();
  if (!deployment) return NextResponse.json({ cards: [], owned: [], vaulted: [], recorded: false });

  const wallet = new URL(req.url).searchParams.get("wallet");
  if (wallet === null || deployment.cards.length === 0) return NextResponse.json({ cards: deployment.cards, owned: [], vaulted: [], recorded: true });
  try {
    new PublicKey(wallet);
  } catch {
    return NextResponse.json({ error: "That is not a Solana address." }, { status: 400 });
  }
  if (!SOLANA_ADDRESS.test(wallet)) return NextResponse.json({ error: "That is not a Solana address." }, { status: 400 });

  try {
    const states = await readCopyStates(deployment.cards);
    return NextResponse.json({ cards: deployment.cards, ...holdingsOf(wallet, deployment.cards, states), recorded: true });
  } catch (e) {
    console.error("Reading test card ownership failed:", e);
    return NextResponse.json({ error: "Could not read test cards." }, { status: 502 });
  }
}
