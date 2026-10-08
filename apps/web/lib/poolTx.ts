import { Transaction, type PublicKey } from "@solana/web3.js";
import {
  createAtaIdempotentIx, depositFractionsIx, depositUsdcIx, oracleIsFresh, refreshPriceIx, withdrawIx,
} from "@slab/sdk";
import { readChain, tokenAccountsOf } from "./chain";
import type { Cluster } from "./cluster";

export interface PoolAction {
  kind: "depositUsdc" | "depositFractions" | "withdraw";
  amount: bigint;
}

type Sign = (tx: Transaction) => Promise<Transaction>;

export async function sendPoolAction(cluster: Cluster, owner: PublicKey, sign: Sign, action: PoolAction): Promise<string> {
  const { connection } = cluster;
  const { poolAddress, pool, oracle, now } = await readChain(cluster);
  const accounts = tokenAccountsOf(owner, pool);
  const target = { address: poolAddress, pool };
  const tx = new Transaction();

  const halfLife = { lastUpdateTs: oracle.lastUpdateTs, maxStalenessSecs: Math.floor(oracle.maxStalenessSecs / 2) };
  if (!oracleIsFresh(halfLife, now)) tx.add(refreshPriceIx(owner, pool.oracle, oracle.ammPool));

  if (action.kind === "withdraw") {
    tx.add(
      createAtaIdempotentIx(owner, owner, pool.usdcMint),
      createAtaIdempotentIx(owner, owner, pool.fractionMint),
      withdrawIx(target, owner, accounts, action.amount),
    );
  } else {
    tx.add(createAtaIdempotentIx(owner, owner, pool.clpMint));
    tx.add(
      action.kind === "depositUsdc"
        ? depositUsdcIx(target, owner, accounts, action.amount)
        : depositFractionsIx(target, owner, accounts, action.amount),
    );
  }

  const latest = await connection.getLatestBlockhash("confirmed");
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
  const anchor = /Error Message: (.+?)\.?$/m.exec(text);
  if (anchor?.[1]) return `${anchor[1]}.`;
  if (/reject/i.test(text)) return "The signature was rejected in the wallet.";
  if (/insufficient (funds|lamports)/i.test(text)) return "Not enough balance to cover this.";
  if (/Attempt to debit an account but found no record/i.test(text)) return "This wallet has no SOL on this cluster to pay the fee.";
  return (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "The transaction failed.";
}
