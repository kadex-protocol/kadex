import { Connection, PublicKey } from "@solana/web3.js";

const rpcUrl = process.env.NEXT_PUBLIC_KADEX_RPC_URL;
const usdcMint = process.env.NEXT_PUBLIC_KADEX_USDC_MINT;
const named = process.env.NEXT_PUBLIC_KADEX_NETWORK;

export type Network = "local" | "devnet" | "mainnet";

// Anything not recognisably a test cluster is treated as mainnet: no demo wallet, no faucet.
function networkOf(url: string): Network {
  if (named === "local" || named === "devnet" || named === "mainnet") return named;
  if (/\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) return "local";
  return /devnet/i.test(url) ? "devnet" : "mainnet";
}

export const CLUSTER =
  rpcUrl && usdcMint
    ? { rpcUrl, usdcMint: new PublicKey(usdcMint), connection: new Connection(rpcUrl, "confirmed"), network: networkOf(rpcUrl) }
    : null;

export type Cluster = NonNullable<typeof CLUSTER>;

export const TEST_FUNDS = CLUSTER === null || CLUSTER.network !== "mainnet";
export const USD_LABEL: string = CLUSTER?.network === "devnet" || CLUSTER?.network === "local" ? "kdUSD" : "USDC";
