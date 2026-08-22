"use client";

import { GithubMark as Github } from "./BrandIcon";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { useState } from "react";

import { MuonMark } from "./MuonMark";

const NAV = [
  { label: "Product", to: "/product" },
  { label: "Memory", to: "/product/shared-memory" },
  { label: "How it works", to: "/how-it-works" },
  { label: "Pricing", to: "/pricing" },
  // Nav says Teams; the URL stays /enterprise (inbound links + the contact
  // route are load-bearing). "Enterprise" promised a Company product we have
  // not built (2026-08-23 marketing appendix §3).
  { label: "Teams", to: "/enterprise" },
  { label: "Security", to: "/security" },
  { label: "FAQ", to: "/faq" },
] as const;

/**
 * Active-nav test. The router used to do this via `activeProps`; Next has no
 * equivalent, so it is explicit. `/product` must not light up on
 * `/product/shared-memory`'s behalf only when that item is itself in the nav —
 * so a child path marks its own entry, and the parent matches exactly.
 */
function isActive(pathname: string | null, to: string): boolean {
  if (!pathname) return false;
  const here = pathname.replace(/\/$/, "") || "/";
  return here === to;
}

export function TopRail() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  return (
    <nav className="sticky top-0 z-50 border-b border-border bg-background/90 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between gap-6 px-4">
        <Link href="/" className="flex items-center gap-3">
          <MuonMark className="size-6" />
          <span className="font-sans text-lg font-semibold tracking-[-0.02em]">MUON</span>
        </Link>

        <div className="flex items-center gap-6">
          <div className="hidden items-center gap-6 lg:flex">
            {NAV.map((item) => (
              <Link
                key={item.label}
                href={item.to}
                aria-current={isActive(pathname, item.to) ? "page" : undefined}
                className={`nav-link border-b-2 py-1 ${
                  isActive(pathname, item.to)
                    ? "border-muon-blue text-foreground"
                    : "border-transparent"
                }`}
              >
                {item.label}
              </Link>
            ))}
            <Link href="/docs"
              className="nav-link border-b-2 border-transparent py-1">
              Docs
            </Link>
            <a
              href="https://github.com/Sweetdevil144/muon"
              aria-label="MUON on GitHub"
              className="nav-link border-b-2 border-transparent py-1"
            >
              <Github className="size-[18px]" />
            </a>
          </div>

          <Link href="/download" className="btn-primary px-5 py-2.5 text-sm">
            Install app
          </Link>

          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="-mr-1 p-2 text-muted-foreground transition-colors hover:text-foreground lg:hidden"
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </div>

      {open ? (
        <div className="border-t border-border bg-background lg:hidden">
          <div className="mx-auto flex max-w-[1440px] flex-col px-4 py-2">
            {NAV.map((item) => (
              <Link
                key={item.label}
                href={item.to}
                onClick={() => setOpen(false)}
                className="nav-link border-b border-border py-3 last:border-b-0"
              >
                {item.label}
              </Link>
            ))}
            <Link href="/docs" className="nav-link border-b border-border py-3">
              Docs
            </Link>
            <a
              href="https://github.com/Sweetdevil144/muon"
              className="nav-link flex items-center gap-2 py-3"
            >
              <Github className="size-4" /> GitHub
            </a>
          </div>
        </div>
      ) : null}
    </nav>
  );
}
