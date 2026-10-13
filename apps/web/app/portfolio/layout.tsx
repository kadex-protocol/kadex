import type { Metadata } from "next";
import { pageMetadata } from "@/lib/site";

export const metadata: Metadata = {
  ...pageMetadata(
    "Portfolio",
    "Your open positions, vaulted cards and pool shares on Kadex, read from the chain against your wallet.",
    "/portfolio",
  ),
  robots: { index: false, follow: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
