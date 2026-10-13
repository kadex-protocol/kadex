import { Transaction, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { oracleIsFresh, refreshPriceIx } from "@kadex/sdk";
import type { ChainState } from "./chain";
import type { Cluster } from "./cluster";

export type Sign = (tx: Transaction) => Promise<Transaction>;

export function refreshIfAging(chain: ChainState, caller: PublicKey): TransactionInstruction[] {
  const { oracle, pool, now, refreshAccounts } = chain;
  const halfLife = { lastUpdateTs: oracle.lastUpdateTs, maxStalenessSecs: Math.floor(oracle.maxStalenessSecs / 2) };
  return oracleIsFresh(halfLife, now) ? [] : [refreshPriceIx(caller, pool.oracle, oracle.ammPool, refreshAccounts)];
}

export async function sendInstructions(
  { connection }: Cluster,
  owner: PublicKey,
  sign: Sign,
  instructions: TransactionInstruction[],
): Promise<string> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction().add(...instructions);
  tx.feePayer = owner;
  tx.recentBlockhash = latest.blockhash;

  const signed = await sign(tx);
  const signature = await connection.sendRawTransaction(signed.serialize());
  const result = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (result.value.err) throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
  return signature;
}

export function explainTxError(error: unknown): string {
  const logs = (error as { logs?: string[] } | null)?.logs?.join("\n") ?? "";
  const text = `${error instanceof Error ? error.message : String(error)}\n${logs}`;
  const anchor = /Error Message: ([^"\n]+?)\.?(?:"|$)/m.exec(text);
  if (anchor?.[1]) return `${anchor[1]}.`;
  if (/\b429\b|rate limit/i.test(text)) return "The network is rate limiting requests. Wait a few seconds and try again.";
  const custom = /"Custom":\s*(\d+)/.exec(text);
  if (custom) return `The program refused this transaction (error ${custom[1]}).`;
  if (/reject/i.test(text)) return "The signature was rejected in the wallet.";
  if (/insufficient (funds|lamports)/i.test(text)) return "Not enough balance to cover this.";
  if (/Attempt to debit an account but found no record/i.test(text)) return "This wallet has no SOL on this cluster to pay the fee.";
  return (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "The transaction failed.";
}

export const shortSignature = (signature: string) => `${signature.slice(0, 8)}…${signature.slice(-8)}`;
