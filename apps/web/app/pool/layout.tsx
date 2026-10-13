import type { Metadata } from "next";
import { pageMetadata } from "@/lib/site";

export const metadata: Metadata = pageMetadata(
  "Earn",
  "Deposit into the Kadex pool and earn the trading and borrow fees as the counterparty to every trade on the card index.",
  "/pool",
);

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
