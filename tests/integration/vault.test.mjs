/**
 * `card-vault`, against a real validator.
 *
 * This program had two unit tests, both about decimals, and nothing had ever
 * run it on-chain. It is also the program that takes custody of someone's
 * physical card, so it is the worst place in the repository to be guessing.
 *
 * The invariant under test, from the module header:
 *
 *     fractions_outstanding == fractions_per_card  while the NFT is locked
 *     fractions_outstanding == 0                   after redemption
 *
 * and the one people actually get caught by: redemption needs the WHOLE
 * supply. Half the fractions do not buy half a card.
 *
 *     node scripts/with-validator.mjs node --test tests/integration/vault.test.mjs
 */

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { IDLS, USDC, newProvider, funded, mustFail, balance } from "./_harness.mjs";

const VAULT_SEEDS = {
  registry: Buffer.from("registry"),
  card: Buffer.from("card"),
  vault: Buffer.from("vault"),
  fractionMint: Buffer.from("fraction_mint"),
  nftEscrow: Buffer.from("nft_escrow"),
};

const VAULT_ID = new PublicKey(IDLS.cardVault.address);

const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, VAULT_ID)[0];
const findRegistry = () => pda([VAULT_SEEDS.registry]);
const findCard = (nft) => pda([VAULT_SEEDS.card, nft.toBuffer()]);
const findVault = (nft) => pda([VAULT_SEEDS.vault, nft.toBuffer()]);
const findFractionMint = (nft) => pda([VAULT_SEEDS.fractionMint, nft.toBuffer()]);
const findNftEscrow = (nft) => pda([VAULT_SEEDS.nftEscrow, nft.toBuffer()]);

describe("card vault", () => {
  let ctx, vault, registry;

  before(async () => {
    ctx = await newProvider();
    vault = new anchor.Program(IDLS.cardVault, ctx.provider);
    registry = findRegistry();

    await vault.methods
      .initializeRegistry()
      .accounts({ admin: ctx.payer.publicKey, registry })
      .rpc();
  });

  /**
   * Mint a one-of-one NFT into a fresh owner's account, the way a tokenized
   * graded card arrives: supply 1, zero decimals.
   */
  async function mintNft(owner) {
    const { conn, payer } = ctx;
    const nftMint = await createMint(conn, payer, payer.publicKey, null, 0);
    const acct = await createAccount(conn, payer, nftMint, owner, Keypair.generate());
    await mintTo(conn, payer, nftMint, acct, payer, 1);
    return { nftMint, acct };
  }

  /** Whitelist a card at a dollar value. 1 fraction = $1, both 6 decimals. */
  async function whitelist(nftMint, valueUsdc, weightBps = 2_500) {
    await vault.methods
      .whitelistCard(new anchor.BN((valueUsdc * USDC).toString()), weightBps)
      .accounts({
        admin: ctx.payer.publicKey,
        registry,
        nftMint,
        fractionMint: findFractionMint(nftMint),
        vault: findVault(nftMint),
        card: findCard(nftMint),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }

  async function fractionalize(depositor, nftMint, depositorNft, depositorFractions) {
    await vault.methods
      .fractionalize()
      .accounts({
        depositor: depositor.publicKey,
        nftMint,
        card: findCard(nftMint),
        vault: findVault(nftMint),
        fractionMint: findFractionMint(nftMint),
        depositorNft,
        nftEscrow: findNftEscrow(nftMint),
        depositorFractions,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositor])
      .rpc();
  }

  // ───────────────────────────────────────────────────────────────────────

  test("a whitelisted card mints exactly its fractions, and the NFT leaves the owner", async () => {
    const { conn, payer } = ctx;
    const owner = await funded(conn, 20);
    const { nftMint, acct: ownerNft } = await mintNft(owner.publicKey);

    await whitelist(nftMint, 1_420n);

    const fractionMint = findFractionMint(nftMint);
    const ownerFractions = await createAccount(
      conn, payer, fractionMint, owner.publicKey, Keypair.generate(),
    );

    await fractionalize(owner, nftMint, ownerNft, ownerFractions);

    // The depositor holds exactly the whitelisted number, not a number chosen
    // at deposit time.
    assert.equal(await balance(conn, ownerFractions), 1_420n * USDC);

    // The card itself is gone from the owner and sitting in escrow.
    assert.equal(await balance(conn, ownerNft), 0n);
    assert.equal(await balance(conn, findNftEscrow(nftMint)), 1n);

    // Supply equals what is outstanding. Nothing was minted anywhere else.
    assert.equal((await getMint(conn, fractionMint)).supply, 1_420n * USDC);

    const v = await vault.account.vaultedCard.fetch(findVault(nftMint));
    assert.equal(v.locked, true);
    assert.equal(BigInt(v.fractionsMinted.toString()), 1_420n * USDC);
    assert.equal(v.depositor.toBase58(), owner.publicKey.toBase58());
  });

  test("the whole supply buys the card back, and the vault empties exactly", async () => {
    const { conn, payer } = ctx;
    const owner = await funded(conn, 20);
    const { nftMint, acct: ownerNft } = await mintNft(owner.publicKey);
    await whitelist(nftMint, 500n);

    const fractionMint = findFractionMint(nftMint);
    const ownerFractions = await createAccount(
      conn, payer, fractionMint, owner.publicKey, Keypair.generate(),
    );
    await fractionalize(owner, nftMint, ownerNft, ownerFractions);

    await vault.methods
      .redeemCard()
      .accounts({
        redeemer: owner.publicKey,
        nftMint,
        vault: findVault(nftMint),
        fractionMint,
        redeemerFractions: ownerFractions,
        nftEscrow: findNftEscrow(nftMint),
        redeemerNft: ownerNft,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([owner])
      .rpc();

    // The card is back, every fraction is burned, and the supply is zero —
    // not merely "low". A leftover fraction would be a claim on a card that
    // is no longer there.
    assert.equal(await balance(conn, ownerNft), 1n);
    assert.equal(await balance(conn, findNftEscrow(nftMint)), 0n);
    assert.equal(await balance(conn, ownerFractions), 0n);
    assert.equal((await getMint(conn, fractionMint)).supply, 0n);

    const v = await vault.account.vaultedCard.fetch(findVault(nftMint));
    assert.equal(v.locked, false);
    assert.equal(BigInt(v.fractionsMinted.toString()), 0n);
  });

  test("one fraction short is still short", async () => {
    const { conn, payer } = ctx;
    const owner = await funded(conn, 20);
    const stranger = await funded(conn, 20);
    const { nftMint, acct: ownerNft } = await mintNft(owner.publicKey);
    await whitelist(nftMint, 100n);

    const fractionMint = findFractionMint(nftMint);
    const ownerFractions = await createAccount(
      conn, payer, fractionMint, owner.publicKey, Keypair.generate(),
    );
    await fractionalize(owner, nftMint, ownerNft, ownerFractions);

    // Sell a single unit — a millionth of a dollar's worth.
    const strangerFractions = await createAccount(
      conn, payer, fractionMint, stranger.publicKey, Keypair.generate(),
    );
    const { createTransferInstruction } = await import("@solana/spl-token");
    const tx = new anchor.web3.Transaction().add(
      createTransferInstruction(ownerFractions, strangerFractions, owner.publicKey, 1n),
    );
    await ctx.provider.sendAndConfirm(tx, [owner]);

    const msg = await mustFail(
      vault.methods
        .redeemCard()
        .accounts({
          redeemer: owner.publicKey,
          nftMint,
          vault: findVault(nftMint),
          fractionMint,
          redeemerFractions: ownerFractions,
          nftEscrow: findNftEscrow(nftMint),
          redeemerNft: ownerNft,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc(),
      "redeeming without the entire supply",
    );
    assert.match(msg, /InsufficientFractions|insufficient/i);

    // And the card stayed put rather than half-escaping.
    assert.equal(await balance(conn, findNftEscrow(nftMint)), 1n);
  });

  test("someone else's fractions do not redeem your card", async () => {
    const { conn, payer } = ctx;
    const owner = await funded(conn, 20);
    const thief = await funded(conn, 20);

    const a = await mintNft(owner.publicKey);
    const b = await mintNft(thief.publicKey);
    await whitelist(a.nftMint, 300n);
    await whitelist(b.nftMint, 300n);

    const aFractions = await createAccount(
      conn, payer, findFractionMint(a.nftMint), owner.publicKey, Keypair.generate(),
    );
    const bFractions = await createAccount(
      conn, payer, findFractionMint(b.nftMint), thief.publicKey, Keypair.generate(),
    );
    await fractionalize(owner, a.nftMint, a.acct, aFractions);
    await fractionalize(thief, b.nftMint, b.acct, bFractions);

    // Card B's fractions, pointed at card A's vault. Same amount, wrong mint.
    const msg = await mustFail(
      vault.methods
        .redeemCard()
        .accounts({
          redeemer: thief.publicKey,
          nftMint: a.nftMint,
          vault: findVault(a.nftMint),
          fractionMint: findFractionMint(b.nftMint),
          redeemerFractions: bFractions,
          nftEscrow: findNftEscrow(a.nftMint),
          redeemerNft: b.acct,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([thief])
        .rpc(),
      "redeeming card A with card B's fractions",
    );
    assert.match(msg, /WrongFractionMint|has_one|constraint/i);

    assert.equal(await balance(conn, findNftEscrow(a.nftMint)), 1n);
  });

  test("only the admin whitelists, so nobody prices their own collateral", async () => {
    const outsider = await funded(ctx.conn, 20);
    const { nftMint } = await mintNft(outsider.publicKey);

    const msg = await mustFail(
      vault.methods
        .whitelistCard(new anchor.BN((999_999n * USDC).toString()), 9_000)
        .accounts({
          admin: outsider.publicKey,
          registry,
          nftMint,
          fractionMint: findFractionMint(nftMint),
          vault: findVault(nftMint),
          card: findCard(nftMint),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([outsider])
        .rpc(),
      "a non-admin whitelisting a card at their own valuation",
    );
    assert.match(msg, /NotAdmin|address|constraint/i);
  });

  test("a disabled card takes no new deposits but still lets holders out", async () => {
    const { conn, payer } = ctx;
    const owner = await funded(conn, 20);
    const { nftMint, acct: ownerNft } = await mintNft(owner.publicKey);
    await whitelist(nftMint, 250n);

    const fractionMint = findFractionMint(nftMint);
    const ownerFractions = await createAccount(
      conn, payer, fractionMint, owner.publicKey, Keypair.generate(),
    );
    await fractionalize(owner, nftMint, ownerNft, ownerFractions);

    await vault.methods
      .setCardEnabled(false)
      .accounts({ admin: ctx.payer.publicKey, registry, card: findCard(nftMint) })
      .rpc();

    // The holder is not trapped by an admin flag.
    await vault.methods
      .redeemCard()
      .accounts({
        redeemer: owner.publicKey,
        nftMint,
        vault: findVault(nftMint),
        fractionMint,
        redeemerFractions: ownerFractions,
        nftEscrow: findNftEscrow(nftMint),
        redeemerNft: ownerNft,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([owner])
      .rpc();

    assert.equal(await balance(conn, ownerNft), 1n);

    // But the card cannot be re-vaulted while disabled.
    const msg = await mustFail(
      fractionalize(owner, nftMint, ownerNft, ownerFractions),
      "fractionalizing a disabled card",
    );
    assert.match(msg, /CardDisabled|disabled/i);
  });

  test("the registry counts every card it has whitelisted", async () => {
    const before = (await vault.account.registry.fetch(registry)).cardCount;
    const { nftMint } = await mintNft(ctx.payer.publicKey);
    await whitelist(nftMint, 75n);
    const after = (await vault.account.registry.fetch(registry)).cardCount;
    assert.equal(after, before + 1);
  });
});
