import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "./providers";
import { APP_FAVICON_URL, APP_NAME } from "@/lib/site-config";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: APP_NAME,
  description: "Background coding agent for your team",
  icons: { icon: APP_FAVICON_URL },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Polyfill for esbuild __name helper used in Next.js SSR inline scripts.
            OpenNext/CF Worker bundles sometimes reference __name without defining it. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `var __name=(t,v)=>Object.defineProperty(t,"name",{value:v,configurable:true});`,
          }}
        />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
