import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { CORE_PROGRAM_ID, coreAssetOwner, decodeVaultedCard, findVaultedCard } from "@kadex/sdk";
import { CLUSTER } from "./cluster";
import type { TestCard } from "./testCards";

const OWNERSHIP_TTL_MS = 5_000;
const ACCOUNTS_PER_CALL = 100;
const CORE_TRANSFER_V1 = Buffer.from([14, 0]);

export interface Deployment {
  cards: TestCard[];
  collection: PublicKey | null;
}

export interface CopyState {
  owner: string | null;
  depositor: string | null;
}

export async function readDeployment(): Promise<Deployment | null> {
  if (!CLUSTER || CLUSTER.network === "mainnet") return null;
  const path = process.env.KADEX_DEPLOYMENT ?? join(process.cwd(), "..", "..", "deployments", `${CLUSTER.network}.json`);
  try {
    const record = JSON.parse(await readFile(path, "utf8")) as { cards?: TestCard[]; cardVault?: { collection?: string } };
    const collection = record.cardVault?.collection;
    return {
      cards: (record.cards ?? []).map(({ mainnet, asset, name, valueUsd }) => ({ mainnet, asset, name, valueUsd: valueUsd ?? 0 })),
      collection: collection ? new PublicKey(collection) : null,
    };
  } catch {
    return null;
  }
}

export function distributionKeypair(): Keypair | null {
  const raw = process.env.KADEX_FAUCET_KEYPAIR?.trim();
  if (!raw) return null;
  const json = raw.startsWith("[") ? raw : readFileSync(raw, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(json) as number[]));
}

async function readAccounts(addresses: PublicKey[]) {
  const connection = CLUSTER!.connection;
  const batches: PublicKey[][] = [];
  for (let at = 0; at < addresses.length; at += ACCOUNTS_PER_CALL) batches.push(addresses.slice(at, at + ACCOUNTS_PER_CALL));
  const results = await Promise.all(batches.map((batch) => connection.getMultipleAccountsInfo(batch)));
  return results.flat();
}

let cached: { at: number; key: string; states: Promise<Map<string, CopyState>> } | null = null;

export function forgetOwnership() {
  cached = null;
}

export function readCopyStates(cards: TestCard[]): Promise<Map<string, CopyState>> {
  const key = cards.map((card) => card.asset).join(",");
  if (cached && cached.key === key && Date.now() - cached.at < OWNERSHIP_TTL_MS) return cached.states;
  const assets = cards.map((card) => new PublicKey(card.asset));
  const states = Promise.all([readAccounts(assets), readAccounts(assets.map(findVaultedCard))]).then(([assetAccounts, vaultAccounts]) => {
    const map = new Map<string, CopyState>();
    assets.forEach((asset, i) => {
      const account = assetAccounts[i];
      const vault = vaultAccounts[i];
      const record = vault ? decodeVaultedCard(vault.data) : null;
      map.set(asset.toBase58(), {
        owner: account ? coreAssetOwner(account.owner, account.data).toBase58() : null,
        depositor: record?.locked ? record.depositor.toBase58() : null,
      });
    });
    return map;
  });
  const entry = { at: Date.now(), key, states };
  cached = entry;
  states.catch(() => {
    if (cached === entry) cached = null;
  });
  return states;
}

export function holdingsOf(wallet: string, cards: TestCard[], states: Map<string, CopyState>) {
  const owned = cards.filter((card) => states.get(card.asset)?.owner === wallet).map((card) => card.asset);
  const vaulted = cards.filter((card) => states.get(card.asset)?.depositor === wallet).map((card) => card.asset);
  return { owned, vaulted };
}

export function pickFreeCopy(cards: TestCard[], states: Map<string, CopyState>, distributor: string, reserved: ReadonlySet<string>, heldOriginals: ReadonlySet<string>): TestCard | null {
  const free = cards.filter((card) => {
    const state = states.get(card.asset);
    return state?.owner === distributor && state.depositor === null && !reserved.has(card.asset);
  });
  const perOriginal = new Map<string, number>();
  for (const card of free) perOriginal.set(card.mainnet, (perOriginal.get(card.mainnet) ?? 0) + 1);
  const rank = (card: TestCard) => (heldOriginals.has(card.mainnet) ? 1_000_000 : 0) - (perOriginal.get(card.mainnet) ?? 0);
  return free.reduce<TestCard | null>((best, card) => (best === null || rank(card) < rank(best) ? card : best), null);
}

export function transferCoreIx(asset: PublicKey, collection: PublicKey, authority: PublicKey, recipient: PublicKey) {
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: asset, isSigner: false, isWritable: true },
      { pubkey: collection, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: recipient, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: CORE_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: CORE_TRANSFER_V1,
  });
}

export function sendCoreTransfer(asset: PublicKey, collection: PublicKey, authority: Keypair, recipient: PublicKey) {
  const tx = new Transaction().add(transferCoreIx(asset, collection, authority.publicKey, recipient));
  return sendAndConfirmTransaction(CLUSTER!.connection, tx, [authority], { commitment: "confirmed" });
}
