/**
 * The card page's vault flow, through @kadex/sdk, against the real Metaplex
 * Core program: what `vaultAction` offers at each step, and that the
 * instructions the SDK builds are the ones the program accepts. Where the
 * SDK says a button is disabled, the program is shown to refuse the same
 * transaction.
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccount, createTransferInstruction, getMint } from "@solana/spl-token";
import { IDLS, USDC, newProvider, funded, mustFail, sendIxs, ensureVaultRegistry } from "./_harness.mjs";
import {
  CORE_PROGRAM_ID,
  coreAssetOwner,
  createAtaIdempotentIx,
  decodeRegistry,
  decodeVaultedCard,
  decodeWhitelistedCard,
  findAta,
  fractionalizeCoreIx,
  readCoreCard,
  redeemCoreIx,
  vaultAction,
} from "../../packages/sdk/dist/index.js";
import { findCard, findFractionMint, findRegistry, findVaultedCard } from "../../packages/types/dist/index.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const str = (x) => {
  const b = Buffer.from(x, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
};

describe("vault this card, through the SDK", () => {
  let ctx, vault, collection;

  /** A Core asset in the registry's collection, owned by `owner`. Same layout as vault.test.mjs. */
  async function createCoreCard(owner) {
    const asset = Keypair.generate();
    const me = ctx.provider.wallet.publicKey;
    const ix = new TransactionInstruction({
      programId: CORE_PROGRAM_ID,
      keys: [
        { pubkey: asset.publicKey, isSigner: true, isWritable: true },
        { pubkey: collection, isSigner: false, isWritable: true },
        { pubkey: me, isSigner: true, isWritable: false },
        { pubkey: me, isSigner: true, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: CORE_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([0, 0]), str("1999 Charizard PSA 9"), str("https://example.test/a"), Buffer.from([0])]),
    });
    await ctx.provider.sendAndConfirm(new Transaction().add(ix), [asset]);
    return asset.publicKey;
  }

  async function whitelistCore(asset, valueUsdc) {
    await vault.methods
      .whitelistCoreCard(new anchor.BN((valueUsdc * USDC).toString()), 2_500)
      .accounts({
        admin: ctx.payer.publicKey,
        registry: findRegistry(),
        asset,
        fractionMint: findFractionMint(asset),
        vault: findVaultedCard(asset),
        card: findCard(asset),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }

  before(async () => {
    ctx = await newProvider();
    vault = new anchor.Program(IDLS.cardVault, ctx.provider);
    // One registry per program, shared with vault.test.mjs.
    collection = await ensureVaultRegistry(ctx, vault, async () => {
      const c = Keypair.generate();
      const me = ctx.provider.wallet.publicKey;
      await ctx.provider.sendAndConfirm(
        new Transaction().add(
          new TransactionInstruction({
            programId: CORE_PROGRAM_ID,
            keys: [
              { pubkey: c.publicKey, isSigner: true, isWritable: true },
              { pubkey: CORE_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: me, isSigner: true, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: Buffer.concat([Buffer.from([1]), str("Test Graded Cards"), str("https://example.test/c"), Buffer.from([0])]),
          }),
        ),
        [c],
      );
      return c.publicKey;
    });
  });

  test("the account decoders agree with the Anchor coder", async () => {
    const owner = await funded(ctx.conn, 2);
    const asset = await createCoreCard(owner.publicKey);
    await whitelistCore(asset, 70n);
    const raw = async (k) => (await ctx.conn.getAccountInfo(k)).data;

    const reg = decodeRegistry(await raw(findRegistry()));
    const theirsReg = await vault.account.registry.fetch(findRegistry());
    assert.ok(reg.collection.equals(theirsReg.collection) && reg.admin.equals(theirsReg.admin));
    assert.equal(reg.cardCount, theirsReg.cardCount);

    const card = decodeWhitelistedCard(await raw(findCard(asset)));
    const theirs = await vault.account.whitelistedCard.fetch(findCard(asset));
    assert.ok(card.nftMint.equals(asset) && card.fractionMint.equals(theirs.fractionMint));
    assert.equal(card.fractionsPerCard, BigInt(theirs.fractionsPerCard.toString()));
    assert.deepEqual([card.weightBps, card.enabled, card.core], [theirs.weightBps, theirs.enabled, theirs.core]);

    const v = decodeVaultedCard(await raw(findVaultedCard(asset)));
    assert.equal(v.locked, false);
    assert.equal(v.fractionsMinted, 0n);
    assert.ok(coreAssetOwner(CORE_PROGRAM_ID, await raw(asset)).equals(owner.publicKey));
  });

  test("the whole flow: offer, vault, redeem-short refused, redeem, card back", async () => {
    const owner = await funded(ctx.conn, 2);
    const stranger = await funded(ctx.conn, 2);
    const asset = await createCoreCard(owner.publicKey);
    const accounts = { asset, collection };
    const fractionMint = findFractionMint(asset);
    const state = (who) => readCoreCard(ctx.conn, asset, who.publicKey);

    // Not whitelisted: nothing to offer.
    assert.equal(vaultAction(await state(owner), owner.publicKey).kind, "notWhitelisted");

    await whitelistCore(asset, 1_420n);
    assert.deepEqual(vaultAction(await state(owner), owner.publicKey), { kind: "vault", fractions: 1_420n * USDC });
    assert.equal(vaultAction(await state(stranger), stranger.publicKey).kind, "notOwner");

    // The stranger's transaction is the one the button refuses to build; the program refuses it too.
    await mustFail(
      sendIxs(ctx.conn, [stranger], createAtaIdempotentIx(stranger.publicKey, stranger.publicKey, fractionMint), fractionalizeCoreIx(accounts, stranger.publicKey)),
      "a stranger vaulting someone else's card",
    );

    // Vault it, exactly as the card page sends it.
    await sendIxs(ctx.conn, [owner], createAtaIdempotentIx(owner.publicKey, owner.publicKey, fractionMint), fractionalizeCoreIx(accounts, owner.publicKey));
    let s = await state(owner);
    assert.ok(s.assetOwner.equals(findVaultedCard(asset)), "the vault PDA owns the card");
    assert.equal(s.walletFractions, 1_420n * USDC);
    assert.deepEqual(vaultAction(s, owner.publicKey), { kind: "redeem", fractions: 1_420n * USDC });

    // Sell one fraction: the button says short, and the program refuses the redeem.
    const strangerAta = await createAssociatedTokenAccount(ctx.conn, ctx.payer, fractionMint, stranger.publicKey);
    await sendIxs(ctx.conn, [owner], createTransferInstruction(findAta(owner.publicKey, fractionMint), strangerAta, owner.publicKey, 1n));
    s = await state(owner);
    assert.deepEqual(vaultAction(s, owner.publicKey), { kind: "redeemShort", fractions: 1_420n * USDC, held: 1_420n * USDC - 1n });
    await mustFail(sendIxs(ctx.conn, [owner], redeemCoreIx(accounts, owner.publicKey)), "redeem one fraction short");

    // Buy it back, redeem the whole supply, the card returns.
    await sendIxs(ctx.conn, [stranger], createTransferInstruction(strangerAta, findAta(owner.publicKey, fractionMint), stranger.publicKey, 1n));
    await sendIxs(ctx.conn, [owner], redeemCoreIx(accounts, owner.publicKey));
    s = await state(owner);
    assert.ok(s.assetOwner.equals(owner.publicKey), "the card came back");
    assert.equal(s.walletFractions, 0n);
    assert.equal((await getMint(ctx.conn, fractionMint)).supply, 0n, "the whole supply was burned");
    assert.equal(vaultAction(s, owner.publicKey).kind, "vault", "and it can be vaulted again");
  });

  test("a disabled card offers no deposit, and the program refuses one", async () => {
    const owner = await funded(ctx.conn, 2);
    const asset = await createCoreCard(owner.publicKey);
    await whitelistCore(asset, 50n);
    await vault.methods.setCardEnabled(false).accounts({ admin: ctx.payer.publicKey, registry: findRegistry(), card: findCard(asset) }).rpc();
    assert.equal(vaultAction(await readCoreCard(ctx.conn, asset, owner.publicKey), owner.publicKey).kind, "disabled");
    await mustFail(
      sendIxs(ctx.conn, [owner], createAtaIdempotentIx(owner.publicKey, owner.publicKey, findFractionMint(asset)), fractionalizeCoreIx({ asset, collection }, owner.publicKey)),
      "vaulting a disabled card",
    );
  });

  test("an asset that is not on the cluster is reported, not thrown", async () => {
    const nowhere = Keypair.generate().publicKey;
    const s = await readCoreCard(ctx.conn, nowhere, null);
    assert.equal(s.assetOwner, null);
    assert.equal(vaultAction(s, null).kind, "missing");
  });
});
