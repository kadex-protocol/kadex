import type { Metadata } from "next";
import "./globals.css";
import { WalletProvider } from "@/lib/wallet";
import { Frame } from "@/components/Frame";

export const metadata: Metadata = {
  title: "SLAB — The collector's market",
  description: "Perpetual exposure to a curated index of tokenized collectibles.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Newsreader:opsz,wght@6..72,300;6..72,400;6..72,500&display=swap"
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
