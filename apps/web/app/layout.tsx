import { BRAND } from "@/lib/brand";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import { WalletProvider } from "@/lib/wallet";
import { Frame } from "@/components/Frame";
import { SITE_DESCRIPTION, SITE_TAGLINE, SITE_URL } from "@/lib/site";

const TITLE = `${BRAND} · ${SITE_TAGLINE}`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: TITLE, template: `%s · ${BRAND}` },
  description: SITE_DESCRIPTION,
  applicationName: BRAND,
  category: "finance",
  keywords: [
    "Kadex",
    "graded cards",
    "trading cards",
    "card index",
    "perpetual futures",
    "perps",
    "Solana",
    "DeFi",
    "tokenized collectibles",
    "Collector Crypt",
    "hedge card inventory",
    "PSA 10",
  ],
  alternates: { canonical: "/" },
  openGraph: { type: "website", siteName: BRAND, locale: "en_US", title: TITLE, description: SITE_DESCRIPTION, url: "/" },
  twitter: { card: "summary_large_image", title: TITLE, description: SITE_DESCRIPTION },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large" } },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#0c0c0e",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `var u="ember";try{u=localStorage.getItem("kadex.skin.v2")||u}catch(e){}document.documentElement.dataset.ui=u`,
          }}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>
        <WalletProvider>
          <Frame>{children}</Frame>
        </WalletProvider>
      </body>
    </html>
  );
}
