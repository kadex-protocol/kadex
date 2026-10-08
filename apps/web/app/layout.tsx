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
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `var u="ember";try{u=localStorage.getItem("slab.skin.v2")||u}catch(e){}document.documentElement.dataset.ui=u`,
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
