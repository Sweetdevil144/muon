import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const deploymentHost =
  process.env.VERCEL_PROJECT_PRODUCTION_URL ??
  process.env.VERCEL_URL ??
  "localhost:3050";
const deploymentProtocol = deploymentHost.startsWith("localhost")
  ? "http"
  : "https";

export const metadata: Metadata = {
  metadataBase: new URL(`${deploymentProtocol}://${deploymentHost}`),
  title: "MUON — run your AI coding agents as one crew",
  description:
    "MUON turns the AI coding tools you already use into one crew, with shared memory and human approval before anything ships.",
  openGraph: {
    type: "website",
    siteName: "MUON",
    title: "Make your coding agents work as one.",
    description:
      "Give MUON one mission. It plans the work, keeps the crew aligned through shared memory, and brings you back to approve what ships.",
    images: [
      {
        url: "/og-orchestration.png",
        width: 1732,
        height: 908,
        alt: "MUON coordinating Claude Code, Codex, Cursor, and OpenCode with human approval",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Make your coding agents work as one.",
    description:
      "Give MUON one mission. It plans the work, keeps the crew aligned through shared memory, and brings you back to approve what ships.",
    images: ["/og-orchestration.png"],
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-16x16.png", type: "image/png", sizes: "16x16" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // `dark` is pinned rather than left to the OS: this is a terminal-native
    // design with one intended appearance, and the trust palette (blue human,
    // green crew, amber stale, red unconfirmed) is calibrated against the dark
    // panel. Letting it render on white would change what the colours mean.
    <html lang="en" className="dark h-full scroll-smooth antialiased">
      <head>
        {/*
          Two families, loaded as links rather than @import so they are
          discovered in the initial HTML instead of after the stylesheet parses.
          globals.css names these families literally, so they are requested by
          the same names it declares.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Work+Sans:ital,wght@0,300..700;1,300..700&family=JetBrains+Mono:ital,wght@0,300..700;1,300..700&display=swap"
        />
      </head>
      <body className="min-h-full overflow-x-hidden bg-background font-sans text-foreground">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
