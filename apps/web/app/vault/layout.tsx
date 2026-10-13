import type { Metadata } from "next";
import { pageMetadata } from "@/lib/site";

export const metadata: Metadata = pageMetadata(
  "Vault",
  "Browse tokenized graded cards from Collector Crypt, vault a slab for fractions worth its appraisal, and redeem it when you hold them all.",
  "/vault",
);

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
