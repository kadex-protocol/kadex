import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAtaIdempotentIx, decodeTokenAmount, findAta } from "@kadex/sdk";
import { CLUSTER } from "@/lib/cluster";
import { SOLANA_ADDRESS } from "@/lib/collectorCrypt";

export const runtime = "nodejs";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const USDC_GRANT = BigInt(process.env.KADEX_FAUCET_USDC ?? 1_000) * 1_000_000n;
const SOL_GRANT = Math.round(Number(process.env.KADEX_FAUCET_SOL ?? 0.05) * 1e9);
const SOL_FLOOR = 10_000_000;
const WALLET_COOLDOWN_MS = 60_000;
const WINDOW_MS = 10 * 60_000;
const GRANTS_PER_WINDOW = 40;

const lastGrant = new Map<string, number>();
const pending = new Set<string>();
let recent: { at: number; wallet: string }[] = [];
let genesis: string | null = null;

function faucetKeypair(): Keypair | null {
  const raw = process.env.KADEX_FAUCET_KEYPAIR?.trim();
  if (!raw) return null;
  const json = raw.startsWith("[") ? raw : readFileSync(raw, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(json) as number[]));
}

const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

function tokenIx(tag: 3 | 7, from: PublicKey, to: PublicKey, signer: PublicKey, amount: bigint) {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: from, isSigner: false, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([tag]), u64(amount)]),
  });
}

const mintAuthority = (data: Uint8Array) =>
  data.length >= 36 && data[0] === 1 ? new PublicKey(data.subarray(4, 36)) : null;

const refuse = (status: number, error: string) => NextResponse.json({ funded: false, error }, { status });

export async function POST(req: Request) {
  if (!CLUSTER || CLUSTER.network === "mainnet") return refuse(404, "There is no faucet on this cluster.");
  const faucet = faucetKeypair();
  if (!faucet) return refuse(503, "The faucet is not configured.");

  const body = (await req.json().catch(() => null)) as { wallet?: unknown } | null;
  if (typeof body?.wallet !== "string" || !SOLANA_ADDRESS.test(body.wallet)) return refuse(400, "That is not a Solana address.");
  const wallet = new PublicKey(body.wallet);
  const { connection, usdcMint } = CLUSTER;

  const now = Date.now();
  recent = recent.filter((slot) => now - slot.at < WINDOW_MS);
  for (const [address, at] of lastGrant) {
    if (now - at >= WALLET_COOLDOWN_MS) lastGrant.delete(address);
  }
  if (pending.has(body.wallet) || lastGrant.has(body.wallet)) return NextResponse.json({ funded: false });
  if (recent.length >= GRANTS_PER_WINDOW) return refuse(429, "The faucet is busy. Try again in a few minutes.");
  const slot = { at: now, wallet: body.wallet };
  pending.add(body.wallet);
  recent.push(slot);
  let granted = false;

  try {
    genesis ??= await connection.getGenesisHash();
    if (genesis === MAINNET_GENESIS) return refuse(404, "There is no faucet on mainnet.");

    const account = findAta(wallet, usdcMint);
    const [lamports, held, mint] = await Promise.all([
      connection.getBalance(wallet),
      connection.getAccountInfo(account),
      connection.getAccountInfo(usdcMint),
    ]);
    if (!mint) return refuse(502, "The test USDC mint does not exist on this cluster.");
    const needsSol = lamports < SOL_FLOOR;
    const needsUsdc = (held ? decodeTokenAmount(held.data) : 0n) < USDC_GRANT / 10n;
    if (!needsSol && !needsUsdc) return NextResponse.json({ funded: false });

    const tx = new Transaction();
    if (needsSol) tx.add(SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: wallet, lamports: SOL_GRANT }));
    if (needsUsdc) {
      tx.add(createAtaIdempotentIx(faucet.publicKey, wallet, usdcMint));
      tx.add(
        mintAuthority(mint.data)?.equals(faucet.publicKey)
          ? tokenIx(7, usdcMint, account, faucet.publicKey, USDC_GRANT)
          : tokenIx(3, findAta(faucet.publicKey, usdcMint), account, faucet.publicKey, USDC_GRANT),
      );
    }
    const signature = await sendAndConfirmTransaction(connection, tx, [faucet], { commitment: "confirmed" });
    lastGrant.set(body.wallet, Date.now());
    granted = true;
    return NextResponse.json({ funded: true, signature });
  } catch (e) {
    console.error("Faucet request failed:", e);
    return refuse(502, "The faucet transaction failed.");
  } finally {
    pending.delete(body.wallet);
    if (!granted) recent = recent.filter((entry) => entry !== slot);
  }
}
