import type { Metadata } from "next";
import { BRAND } from "@/lib/brand";

const fromEnv = process.env.NEXT_PUBLIC_SITE_URL ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);

export const SITE_URL = (fromEnv ?? "https://kadex.kc1t.com").replace(/\/+$/, "");
export const SITE_TAGLINE = "Trade the graded card market";
export const SITE_DESCRIPTION =
  "Go long or short on an index of tokenized graded trading cards with perpetuals on Solana. Earn fees as the pool, or vault a graded card for fractions.";

const COVER = {
  url: "/opengraph-image.png",
  width: 1200,
  height: 630,
  alt: `${BRAND}: Trading cards. Traded. Go long or short on the graded card market with perpetuals on Solana.`,
};

export function pageMetadata(title: string, description: string, path: string): Metadata {
  const fullTitle = `${title} · ${BRAND}`;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { type: "website", siteName: BRAND, locale: "en_US", title: fullTitle, description, url: path, images: [COVER] },
    twitter: { card: "summary_large_image", title: fullTitle, description, images: [COVER] },
  };
}
