import type { Metadata } from "next";
import { pageMetadata } from "@/lib/site";

export const metadata: Metadata = pageMetadata(
  "Index methodology",
  "How the Kadex Index is priced from an on-chain pool of card fractions, and how pool solvency and depth cap the size of the market.",
  "/index-methodology",
);

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
