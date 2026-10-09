import { Connection, PublicKey } from "@solana/web3.js";

const rpcUrl = process.env.NEXT_PUBLIC_KADEX_RPC_URL;
const usdcMint = process.env.NEXT_PUBLIC_KADEX_USDC_MINT;

export const CLUSTER =
  rpcUrl && usdcMint
    ? { rpcUrl, usdcMint: new PublicKey(usdcMint), connection: new Connection(rpcUrl, "confirmed") }
    : null;

export type Cluster = NonNullable<typeof CLUSTER>;
