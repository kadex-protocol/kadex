import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import anchor from "@coral-xyz/anchor";
import { PublicKey, Transaction } from "@solana/web3.js";
import { IDLS, newProvider, programs, setupOracle, refresh, stateName, mustFail } from "../integration/_harness.mjs";
import { COLLECTOR_CRYPT_COLLECTION, fetchCard } from "../../packages/collector-crypt/dist/index.js";
import {
  readAppraisalIndex,
  readExternalMedian,
  readOraclePrice,
  setExternalMedianIx,
  whitelistedCoreCards,
} from "../../packages/collector-crypt/dist/chain.js";
import { findCard, findRegistry } from "../../packages/types/dist/index.js";
import { planWhitelist, whitelistCoreCard } from "../../scripts/whitelist-core.mjs";

const WARTORTLE = "CvsHTsAjWdaxViomzmfzqkVFsNkps6Jzs8d24jjMzP43";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

function collectorCrypt(askUsd, insuredUsd = "70") {
  const market = fixture("cc_card_market.json");
  const routes = {
    [`/cards/publicNft/${WARTORTLE}`]: { ...fixture("cc_card.json"), insuredValue: insuredUsd },
    [`/cards/publicNft/${WARTORTLE}/market`]: { ...market, listing: { ...market.listing, price: askUsd } },
    // What the feed reads: one marketplace search by mint, appraisal and listing together.
    [`/marketplace?search=${WARTORTLE}`]: {
      filterNFtCard: [{ ...fixture("cc_card.json"), listing: { ...market.listing, price: Number(askUsd) } }],
      total: 1,
    },
  };
  return async (url) => {
    const path = url.replace("https://api.collectorcrypt.com", "");
    return { ok: path in routes, status: path in routes ? 200 : 404, json: async () => routes[path] };
  };
}

describe("collector crypt, end to end", () => {
  let ctx, vault, oracleEnv;

  before(async () => {
    ctx = await newProvider();
    ctx.p = programs(ctx.provider);
    vault = new anchor.Program(IDLS.cardVault, ctx.provider);
    await vault.methods
      .initializeRegistry(new PublicKey(COLLECTOR_CRYPT_COLLECTION))
      .accounts({ admin: ctx.payer.publicKey, programData: null, registry: findRegistry() })
      .rpc();
    oracleEnv = await setupOracle(ctx);
    await refresh(ctx, oracleEnv);
  });

  test("a real card is whitelisted at its Collector Crypt appraisal", async () => {
    const card = await fetchCard(WARTORTLE, { fetch: collectorCrypt("2550") });
    await whitelistCoreCard(vault, card, 2_500);

    const record = await vault.account.whitelistedCard.fetch(findCard(new PublicKey(WARTORTLE)));
    assert.equal(record.fractionsPerCard.toString(), "70000000");
    assert.equal(record.weightBps, 2_500);
    assert.equal(record.core, true);
    assert.equal(record.enabled, true);
    assert.ok(record.nftMint.equals(new PublicKey(WARTORTLE)));
  });

  test("the same card cannot be whitelisted twice", async () => {
    const card = await fetchCard(WARTORTLE, { fetch: collectorCrypt("2550") });
    await mustFail(whitelistCoreCard(vault, card, 2_500), "whitelisted the same card twice");
  });

  test("a pnft card is refused before any transaction", async () => {
    const card = await fetchCard(WARTORTLE, { fetch: collectorCrypt("2550") });
    assert.throws(() => planWhitelist({ ...card, nftStandard: "pnft" }, 2_500), /only Metaplex Core/);
    assert.throws(() => planWhitelist(card, 0), /weight-bps/);
  });

  test("the feed finds the whitelisted card on chain", async () => {
    const cards = await whitelistedCoreCards(ctx.conn);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].asset.toBase58(), WARTORTLE);
    assert.equal(cards[0].fractionsPerCard, 70_000_000n);
    assert.equal(cards[0].weightBps, 2_500);
    assert.equal(cards[0].enabled, true);
  });

  test("too few priced cards publish nothing", async () => {
    const reading = await readExternalMedian(ctx.conn, 3, { fetch: collectorCrypt("77") });
    assert.equal(reading.median, null);
    assert.equal(reading.index, null);
    assert.equal(reading.samples.length, 1);
    assert.equal(reading.samples[0].weightBps, 2_500, "each sample carries its on-chain weight");
  });

  test("the hand-decoded oracle price matches the account", async () => {
    const account = await ctx.p.oracle.account.oracleAccount.fetch(oracleEnv.oracle);
    assert.equal(await readOraclePrice(ctx.conn, oracleEnv.oracle), BigInt(account.price.toString()));
  });

  test("a median near the AMM price is published and leaves the oracle tradeable", async () => {
    const { median, index } = await readExternalMedian(ctx.conn, 1, { fetch: collectorCrypt("77") });
    assert.equal(median, 1_100_000n);
    assert.equal(index, median, "one card: weighted and plain agree");

    const ix = setExternalMedianIx(ctx.payer.publicKey, oracleEnv.oracle, median);
    await ctx.provider.sendAndConfirm(new Transaction().add(ix));

    const account = await ctx.p.oracle.account.oracleAccount.fetch(oracleEnv.oracle);
    assert.equal(account.externalMedian.toString(), "1100000");
    assert.notEqual(stateName(account.state), "diverged");
  });

  test("the appraisal index is 1.00 at launch and follows a re-appraisal", async () => {
    const flat = await readAppraisalIndex(ctx.conn, 1, { fetch: collectorCrypt("2550") });
    assert.equal(flat.index, 1_000_000n, "appraised where it was whitelisted, whatever the ask");
    const up = await readAppraisalIndex(ctx.conn, 1, { fetch: collectorCrypt("2550", "77") });
    assert.equal(up.index, 1_100_000n);
    const none = await readAppraisalIndex(ctx.conn, 2, { fetch: collectorCrypt("2550") });
    assert.equal(none.index, null, "one card, two required");

    await ctx.provider.sendAndConfirm(new Transaction().add(setExternalMedianIx(ctx.payer.publicKey, oracleEnv.oracle, flat.index)));
    const account = await ctx.p.oracle.account.oracleAccount.fetch(oracleEnv.oracle);
    assert.notEqual(stateName(account.state), "diverged", "a basket appraised at launch value keeps a 1.00 market tradeable");
  });

  test("the real asking price, 36x the appraisal, trips the divergence bound", async () => {
    const { median } = await readExternalMedian(ctx.conn, 1, { fetch: collectorCrypt("2550") });
    assert.equal(median, 36_428_571n);

    const ix = setExternalMedianIx(ctx.payer.publicKey, oracleEnv.oracle, median);
    await ctx.provider.sendAndConfirm(new Transaction().add(ix));

    const account = await ctx.p.oracle.account.oracleAccount.fetch(oracleEnv.oracle);
    assert.equal(stateName(account.state), "diverged");
  });
});
