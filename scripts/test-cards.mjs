/**
 * Test copies of real Collector Crypt cards, for clusters where the real ones
 * do not exist. Each copy is a Metaplex Core asset in a collection this script
 * creates, whitelisted in the card vault at the real card's appraisal, so
 * vault and redeem run against the deployed program. Re-runnable: it reuses
 * the registry and every copy already in the record.
 */
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { fetchCard, fetchMarketplacePage, isVaultable } from "@kadex/collector-crypt";
import { findCard, findRegistry } from "@kadex/types";
import { whitelistCoreCard } from "./whitelist-core.mjs";

const CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const COLLECTION = { name: "Kadex Test Cards", uri: "https://github.com/kadex-protocol/kadex/blob/main/docs/deploying.md" };
const MAX_WEIGHT_BPS = 1_500;
const MARKETPLACE_PAGES = 5;

const str = (text) => {
  const bytes = Buffer.from(text, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
};

// mpl-core 0.12 layouts, as in tests/integration/vault.test.mjs: CreateCollectionV1 = 1, CreateV1 = 0.
const collectionIx = (collection, payer) =>
  new TransactionInstruction({
    programId: CORE,
    keys: [
      { pubkey: collection, isSigner: true, isWritable: true },
      { pubkey: CORE, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([1]), str(COLLECTION.name), str(COLLECTION.uri), Buffer.from([0])]),
  });

const assetIx = (asset, collection, payer, owner, { name, uri }) =>
  new TransactionInstruction({
    programId: CORE,
    keys: [
      { pubkey: asset, isSigner: true, isWritable: true },
      { pubkey: collection, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: CORE, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: CORE, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([0, 0]), str(name), str(uri), Buffer.from([0])]),
  });

export function equalWeightBps(count) {
  if (!Number.isInteger(count) || count <= 0) throw new Error("no cards to weigh");
  return Math.min(MAX_WEIGHT_BPS, Math.floor(10_000 / count));
}

export async function chooseCards(count, listed = process.env.KADEX_CARDS) {
  const addresses = (listed ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (addresses.length > 0) return Promise.all(addresses.map((address) => fetchCard(address)));
  const chosen = [];
  let cursor = null;
  for (let page = 0; page < MARKETPLACE_PAGES && chosen.length < count; page += 1) {
    const result = await fetchMarketplacePage(cursor);
    chosen.push(...result.cards.filter(isVaultable));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return chosen.slice(0, count);
}

export async function mirrorCards({ conn, payer, vault, programData, owner, record, save, count = 7, log = console.log }) {
  const confirm = { commitment: "confirmed" };
  const registry = findRegistry();
  let collection = (await conn.getAccountInfo(registry)) ? (await vault.account.registry.fetch(registry)).collection : null;
  if (!collection) {
    const fresh = Keypair.generate();
    await sendAndConfirmTransaction(conn, new Transaction().add(collectionIx(fresh.publicKey, payer.publicKey)), [payer, fresh], confirm);
    await vault.methods.initializeRegistry(fresh.publicKey).accounts({ admin: payer.publicKey, programData, registry }).rpc();
    collection = fresh.publicKey;
  }
  record.cardVault = { registry: registry.toBase58(), collection: collection.toBase58() };
  record.cards ??= [];
  save();
  log(`  registry ${registry.toBase58()}  collection ${collection.toBase58()}`);

  const cards = await chooseCards(count);
  if (cards.length === 0) throw new Error("Collector Crypt returned no vaultable Core card to copy");
  const weightBps = equalWeightBps(cards.length);
  for (const card of cards) {
    let entry = record.cards.find((c) => c.mainnet === card.nftAddress);
    if (!entry || !(await conn.getAccountInfo(new PublicKey(entry.asset)))) {
      const asset = Keypair.generate();
      const uri = `https://collectorcrypt.com/assets/solana/${card.nftAddress}`;
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(assetIx(asset.publicKey, collection, payer.publicKey, owner, { name: card.name, uri })),
        [payer, asset],
        confirm,
      );
      entry = {
        mainnet: card.nftAddress,
        asset: asset.publicKey.toBase58(),
        name: card.name,
        valueUsd: Number(card.insuredValueUsdc) / 1e6,
        owner: owner.toBase58(),
      };
      record.cards = [...record.cards.filter((c) => c.mainnet !== card.nftAddress), entry];
      save();
    }
    if (!(await conn.getAccountInfo(findCard(new PublicKey(entry.asset))))) {
      await whitelistCoreCard(vault, { ...card, nftAddress: entry.asset }, weightBps);
    }
    log(`  ${entry.asset}  $${entry.valueUsd}  ${card.name}`);
  }
  return record.cards;
}
