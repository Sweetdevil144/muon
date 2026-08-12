import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Sidebar from "../components/Sidebar";

// The same two families the marketing site loads, under the same CSS
// variables, so type renders identically across getmuon.com and the docs.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: {
    default: "MUON Docs",
    template: "%s · MUON Docs",
  },
  description:
    "User guide for MUON, the local-first governed control plane for your coding-agent CLIs.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-16x16.png", type: "image/png", sizes: "16x16" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <header className="topbar">
          <div className="topbar-inner">
            <Link className="brand" href="/">
              <img alt="MUON" src="/muon-mark.svg" width={36} height={36} />
              <span className="brand-name">MUON</span>
              <span className="brand-tag">Docs</span>
            </Link>
            <nav aria-label="Site">
              <a className="bauhaus-nav-link" href="https://getmuon.com">
                getmuon.com
              </a>
            </nav>
          </div>
        </header>
        <div className="shell">
          <Sidebar />
          <main className="content bauhaus-grid">
            <div className="page">{children}</div>
          </main>
        </div>
        <footer className="site-footer">
          <div className="site-footer-inner">
            <p>© 2026 MUON LABS</p>
            <a href="https://getmuon.com/privacy">Privacy</a>
          </div>
        </footer>
      </body>
    </html>
  );
}
