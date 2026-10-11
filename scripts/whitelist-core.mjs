#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { findCard, findFractionMint, findRegistry, findVaultedCard } from "@kadex/types";
import { fetchCard, isVaultable } from "@kadex/collector-crypt";
import { loadKeypair } from "@kadex/sdk/node";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function planWhitelist(card, weightBps) {
  if (!Number.isInteger(weightBps) || weightBps <= 0 || weightBps > 10_000) {
    throw new Error("--weight-bps must be an integer from 1 to 10000");
  }
  if (!isVaultable(card)) {
    throw new Error(
      card.nftStandard === "core"
        ? `${card.nftAddress} has no appraisal`
        : `${card.nftAddress} is a ${card.nftStandard} asset; only Metaplex Core cards can be whitelisted`,
    );
  }
  const asset = new PublicKey(card.nftAddress);
  return {
    asset,
    fractionsPerCard: card.insuredValueUsdc,
    weightBps,
    accounts: {
      registry: findRegistry(),
      asset,
      fractionMint: findFractionMint(asset),
      vault: findVaultedCard(asset),
      card: findCard(asset),
      tokenProgram: TOKEN_PROGRAM_ID,
    },
  };
}

export async function whitelistCoreCard(program, card, weightBps) {
  const plan = planWhitelist(card, weightBps);
  const signature = await program.methods
    .whitelistCoreCard(new anchor.BN(plan.fractionsPerCard.toString()), plan.weightBps)
    .accounts({ admin: program.provider.wallet.publicKey, ...plan.accounts })
    .rpc();
  return { ...plan, signature };
}

/**
 * Every card of a basket file (scripts/select-basket.mjs), each at its weight.
 * Refuses the whole basket if any card's live appraisal moved since the file
 * was written: the weights are shares of those appraisals, so they would no
 * longer match the sleeve. Re-run select-basket.mjs then.
 */
export function planBasket(basket, liveCards) {
  const total = basket.cards.reduce((t, c) => t + c.weightBps, 0);
  if (total !== 10_000) throw new Error(`basket weights sum to ${total} bps, not 10000`);
  return basket.cards.map((entry) => {
    const card = liveCards.get(entry.asset);
    if (!card) throw new Error(`${entry.asset} (${entry.name}) is not on Collector Crypt any more`);
    const filed = BigInt(Math.round(Number(entry.appraisalUsd) * 1e6));
    if (card.insuredValueUsdc !== filed) {
      throw new Error(`${entry.name}: appraisal is now ${card.insuredValueUsdc} native USDC, the basket has ${filed}; re-run scripts/select-basket.mjs`);
    }
    return { entry, card, plan: planWhitelist(card, entry.weightBps) };
  });
}

function parseArgs(argv) {
  const b = argv.indexOf("--basket");
  if (b !== -1) {
    if (!argv[b + 1]) throw new Error("usage: node scripts/whitelist-core.mjs --basket <deployments/basket.json>");
    return { basket: argv[b + 1] };
  }
  const [address, ...rest] = argv;
  const flag = rest.indexOf("--weight-bps");
  if (!address || flag === -1 || rest[flag + 1] === undefined) {
    throw new Error("usage: node scripts/whitelist-core.mjs <nftAddress> --weight-bps <1-10000>");
  }
  return { address, weightBps: Number(rest[flag + 1]) };
}

function loadProgram() {
  const admin = loadKeypair(process.env.ADMIN_KEYPAIR, "ADMIN_KEYPAIR (or set DRY_RUN=1)");
  const conn = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: "confirmed" });
  const idl = JSON.parse(
    readFileSync(join(process.env.IDL_DIR ?? join(ROOT, "target", "idl"), "card_vault.json"), "utf8"),
  );
  return new anchor.Program(idl, provider);
}

async function mainBasket(path) {
  const basket = JSON.parse(readFileSync(path, "utf8"));
  const live = new Map();
  for (const { asset } of basket.cards) live.set(asset, await fetchCard(asset));
  const plans = planBasket(basket, live);
  for (const { entry, plan } of plans) {
    console.log(`${String(plan.weightBps).padStart(5)} bps  ${String(plan.fractionsPerCard).padStart(13)} fractions  ${entry.name}`);
  }
  if (process.env.DRY_RUN === "1") return console.log("dry run: nothing sent");
  const program = loadProgram();
  for (const { entry, card } of plans) {
    const { signature } = await whitelistCoreCard(program, card, entry.weightBps);
    console.log(`whitelisted  ${entry.asset}  sig=${signature}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.basket) return mainBasket(args.basket);
  const { address, weightBps } = args;
  const card = await fetchCard(address);
  const plan = planWhitelist(card, weightBps);

  console.log(`card             ${card.name}`);
  console.log(`grade            ${card.gradingCompany} ${card.grade}`);
  console.log(`asset            ${plan.asset.toBase58()}`);
  console.log(`appraisal        ${card.insuredValueUsdc} native USDC`);
  console.log(`fractions        ${plan.fractionsPerCard}`);
  console.log(`weight           ${plan.weightBps} bps`);
  console.log(`card record      ${plan.accounts.card.toBase58()}`);
  console.log(`fraction mint    ${plan.accounts.fractionMint.toBase58()}`);

  if (process.env.DRY_RUN === "1") {
    console.log("dry run: nothing sent");
    return;
  }

  const { signature } = await whitelistCoreCard(loadProgram(), card, weightBps);
  console.log(`whitelisted      sig=${signature}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
