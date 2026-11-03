import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { CLUSTER } from "@/lib/cluster";
import { SOLANA_ADDRESS } from "@/lib/collectorCrypt";
import { distributionKeypair, forgetOwnership, holdingsOf, pickFreeCopy, readCopyStates, readDeployment, sendCoreTransfer } from "@/lib/testCardsServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const WALLET_COOLDOWN_MS = 60_000;
const WINDOW_MS = 10 * 60_000;
const CLAIMS_PER_WINDOW = 40;

const lastClaim = new Map<string, number>();
const pending = new Set<string>();
const reserved = new Set<string>();
let recent: { at: number; wallet: string }[] = [];
let genesis: string | null = null;

const refuse = (status: number, error: string) => NextResponse.json({ claimed: false, error }, { status });

export async function POST(req: Request) {
  if (!CLUSTER || CLUSTER.network !== "devnet") return refuse(404, "Test cards are only handed out on devnet.");
  const distributor = distributionKeypair();
  if (!distributor) return refuse(503, "Test cards are not configured.");

  const body = (await req.json().catch(() => null)) as { wallet?: unknown } | null;
  if (typeof body?.wallet !== "string" || !SOLANA_ADDRESS.test(body.wallet)) return refuse(400, "That is not a Solana address.");
  let recipient: PublicKey;
  try {
    recipient = new PublicKey(body.wallet);
  } catch {
    return refuse(400, "That is not a Solana address.");
  }
  const wallet = body.wallet;

  const deployment = await readDeployment();
  if (!deployment || deployment.cards.length === 0 || !deployment.collection) return refuse(503, "No test cards are recorded for this cluster.");
  const { cards, collection } = deployment;

  const now = Date.now();
  recent = recent.filter((slot) => now - slot.at < WINDOW_MS);
  for (const [address, at] of lastClaim) {
    if (now - at >= WALLET_COOLDOWN_MS) lastClaim.delete(address);
  }
  if (pending.has(wallet) || lastClaim.has(wallet)) return refuse(429, "You just asked for a test card. Give it a minute.");
  if (recent.length >= CLAIMS_PER_WINDOW) return refuse(429, "Test cards are in demand. Try again in a few minutes.");
  const slot = { at: now, wallet };
  pending.add(wallet);
  recent.push(slot);
  let claimed = false;
  let asset: string | null = null;

  try {
    genesis ??= await CLUSTER.connection.getGenesisHash();
    if (genesis === MAINNET_GENESIS) return refuse(404, "Test cards are only handed out on devnet.");

    const states = await readCopyStates(cards);
    const held = holdingsOf(wallet, cards, states);
    if (held.owned.length > 0 || held.vaulted.length > 0) return refuse(409, "This wallet already has a test card.");

    const heldAssets = new Set([...held.owned, ...held.vaulted]);
    const heldOriginals = new Set(cards.filter((card) => heldAssets.has(card.asset)).map((card) => card.mainnet));
    const copy = pickFreeCopy(cards, states, distributor.publicKey.toBase58(), reserved, heldOriginals);
    if (!copy) return refuse(409, "No test cards are left to hand out right now.");
    asset = copy.asset;
    reserved.add(asset);

    const signature = await sendCoreTransfer(new PublicKey(copy.asset), collection, distributor, recipient);
    lastClaim.set(wallet, Date.now());
    claimed = true;
    forgetOwnership();
    return NextResponse.json({ claimed: true, asset: copy.asset, mainnet: copy.mainnet, name: copy.name, signature });
  } catch (e) {
    console.error("Test card claim failed:", e);
    forgetOwnership();
    return refuse(502, "The test card transfer failed. Try again in a moment.");
  } finally {
    pending.delete(wallet);
    if (asset) reserved.delete(asset);
    if (!claimed) recent = recent.filter((entry) => entry !== slot);
  }
}
