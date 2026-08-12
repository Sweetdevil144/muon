import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const deploymentHost =
  process.env.VERCEL_PROJECT_PRODUCTION_URL ??
  process.env.VERCEL_URL ??
  "localhost:3050";
const deploymentProtocol = deploymentHost.startsWith("localhost")
  ? "http"
  : "https";

export const metadata: Metadata = {
  metadataBase: new URL(`${deploymentProtocol}://${deploymentHost}`),
  title: "MUON LABS",
  description:
    "MUON turns the AI coding tools you already use into one crew, with shared context and human approval before anything ships.",
  openGraph: {
    type: "website",
    siteName: "MUON LABS",
    title: "Turn your coding agents into one engineering team.",
    description:
      "Give MUON one mission. It plans the work, keeps the crew aligned, and brings you back when a real decision is needed.",
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
    title: "Turn your coding agents into one engineering team.",
    description:
      "Give MUON one mission. It plans the work, keeps the crew aligned, and brings you back when a real decision is needed.",
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
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full scroll-smooth antialiased`}
    >
      <body className="min-h-full overflow-x-hidden bg-white text-zinc-900">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
