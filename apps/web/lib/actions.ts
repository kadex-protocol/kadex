import { Keypair, PublicKey } from "@solana/web3.js";
import { derivePosition } from "@kadex/sdk";
import { RAY } from "@kadex/types";
import { CLUSTER } from "./cluster";
import type { VaultCard } from "./collectorCrypt";
import { loadMarket, quote, quoteDeposit, quoteWithdraw } from "./market";
import { sendPoolAction, type PoolAction } from "./poolTx";
import { isVaulted, LEDGER_EVENT, readLedger, updateLedger } from "./sim";
import { sendClosePosition, sendOpenPosition, type OpenOrder } from "./tradeTx";
import type { Sign } from "./tx";
import { sendVaultAction } from "./vaultTx";

export type { PoolAction, OpenOrder };

export interface Signer {
  publicKey: PublicKey;
  sign: Sign;
}

const SETTLE_MS = 700;

const receipt = () => Keypair.generate().publicKey.toBase58();
const settle = () => new Promise((done) => setTimeout(done, SETTLE_MS));
const confirmed = async (transaction: Promise<string>) => {
  const signature = await transaction;
  window.dispatchEvent(new Event(LEDGER_EVENT));
  return signature;
};
const refuse = (reason: string): never => {
  throw new Error(reason);
};

export async function openPosition({ publicKey, sign }: Signer, order: OpenOrder): Promise<string> {
  if (CLUSTER) return confirmed(sendOpenPosition(CLUSTER, publicKey, sign, order));
  await settle();
  const snapshot = await loadMarket();
  const q = quote(snapshot, order.side, order.notional);
  if (q.problem) refuse(q.problem);
  updateLedger(publicKey.toBase58(), (ledger, wallet) => {
    if (wallet.usdc < q.margin + q.fee) refuse("Not enough USDC to cover the margin and the fee.");
    wallet.usdc -= q.margin + q.fee;
    ledger.usdcSleeve += q.fee;
    if (order.side === "long") ledger.oiLong += order.notional;
    else ledger.oiShort += order.notional;
    wallet.positions.push({
      address: receipt(),
      side: order.side,
      notional: order.notional,
      margin: q.margin,
      entryPrice: q.entryPrice,
      openedTs: BigInt(Math.floor(Date.now() / 1000)),
    });
  });
  return receipt();
}

export async function closePosition({ publicKey, sign }: Signer, position: PublicKey): Promise<string> {
  if (CLUSTER) return confirmed(sendClosePosition(CLUSTER, publicKey, sign, position));
  await settle();
  const snapshot = await loadMarket();
  const address = position.toBase58();
  updateLedger(publicKey.toBase58(), (ledger, wallet) => {
    const held = wallet.positions.find((p) => p.address === address) ?? refuse("That position is already closed.");
    const { equity } = derivePosition({ ...held, borrowIdxEntry: RAY }, snapshot.market, snapshot.oracle.price, snapshot.pool.params);
    const fee = (held.notional * BigInt(snapshot.pool.params.openCloseFeeBps) + 9_999n) / 10_000n;
    const payout = equity > fee ? equity - fee : 0n;
    wallet.usdc += payout;
    ledger.usdcSleeve += held.margin - payout;
    if (held.side === "long") ledger.oiLong -= held.notional;
    else ledger.oiShort -= held.notional;
    wallet.positions = wallet.positions.filter((p) => p.address !== address);
  });
  return receipt();
}

export async function poolAction({ publicKey, sign }: Signer, action: PoolAction): Promise<string> {
  if (CLUSTER) return confirmed(sendPoolAction(CLUSTER, publicKey, sign, action));
  await settle();
  const snapshot = await loadMarket();
  updateLedger(publicKey.toBase58(), (ledger, wallet) => {
    if (action.kind === "withdraw") {
      const q = quoteWithdraw(snapshot, action.amount);
      if (q.problem) refuse(q.problem);
      if (wallet.clp < action.amount) refuse("Not enough CLP in this wallet.");
      wallet.clp -= action.amount;
      wallet.usdc += q.usdc;
      wallet.fractions += q.fractions;
      ledger.clpSupply -= action.amount;
      ledger.usdcSleeve -= q.usdc;
      ledger.fractionBalance -= q.fractions;
      return;
    }
    const usdc = action.kind === "depositUsdc";
    const q = quoteDeposit(snapshot, usdc ? "usdc" : "fractions", action.amount);
    if (q.problem) refuse(q.problem);
    if ((usdc ? wallet.usdc : wallet.fractions) < action.amount) refuse(`Not enough ${usdc ? "USDC" : "fractions"} in this wallet.`);
    if (usdc) {
      wallet.usdc -= action.amount;
      ledger.usdcSleeve += action.amount;
    } else {
      wallet.fractions -= action.amount;
      ledger.fractionBalance += action.amount;
    }
    wallet.clp += q.shares;
    ledger.clpSupply += q.shares;
  });
  return receipt();
}

export async function vaultCard({ publicKey, sign }: Signer, card: VaultCard): Promise<string> {
  if (CLUSTER) return confirmed(sendVaultAction(CLUSTER, publicKey, sign, new PublicKey(card.nftAddress), "vault"));
  await settle();
  if (!card.vaultable || card.insuredValueUsdc <= 0n) refuse("This card has no appraisal to mint fractions against.");
  updateLedger(publicKey.toBase58(), (ledger, wallet) => {
    if (isVaulted(ledger, card.nftAddress)) refuse("This card is already in the vault.");
    wallet.fractions += card.insuredValueUsdc;
    wallet.cards.push({
      nftAddress: card.nftAddress,
      name: card.name,
      grade: `${card.gradingCompany} ${card.grade}`.trim(),
      image: card.frontImage,
      minted: card.insuredValueUsdc,
    });
  });
  return receipt();
}

export async function redeemCard({ publicKey, sign }: Signer, nftAddress: string): Promise<string> {
  if (CLUSTER) return confirmed(sendVaultAction(CLUSTER, publicKey, sign, new PublicKey(nftAddress), "redeem"));
  await settle();
  updateLedger(publicKey.toBase58(), (_, wallet) => {
    const held = wallet.cards.find((c) => c.nftAddress === nftAddress) ?? refuse("This wallet did not vault that card.");
    if (wallet.fractions < held.minted) refuse("Redeeming burns every fraction minted for the card, and this wallet holds fewer.");
    wallet.fractions -= held.minted;
    wallet.cards = wallet.cards.filter((c) => c.nftAddress !== nftAddress);
  });
  return receipt();
}

export function vaultedBy(nftAddress: string): string | null {
  if (CLUSTER) return null;
  const owners = Object.entries(readLedger().wallets);
  return owners.find(([, w]) => w.cards.some((c) => c.nftAddress === nftAddress))?.[0] ?? null;
}
