"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { SiteShell } from "@/components/muon/SiteShell";

export const DOCS_NAV = [
  { to: "/docs", label: "Overview", blurb: "What MUON is, and what it is not." },
  { to: "/docs/install", label: "Install", blurb: "macOS app, Gatekeeper, CLI and TUI." },
  { to: "/docs/quickstart", label: "Quickstart", blurb: "Connect an agent, run your first mission." },
  { to: "/docs/cli", label: "CLI reference", blurb: "chat, dispatch, fleet, memory, mcp, doctor." },
  { to: "/docs/mcp", label: "MCP server", blurb: "Your own session, MUON's shared brain." },
  { to: "/docs/governance", label: "Governance", blurb: "Gates, memory tiers, full-auto." },
  { to: "/docs/troubleshooting", label: "Troubleshooting", blurb: "Doctor, stale index, logs, reset." },
] as const;

export function DocsLayout({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const index = DOCS_NAV.findIndex((item) => item.to === pathname.replace(/\/$/, ""));
  const prev = index > 0 ? DOCS_NAV[index - 1] : undefined;
  const next = index >= 0 && index < DOCS_NAV.length - 1 ? DOCS_NAV[index + 1] : undefined;

  return (
    <SiteShell>
      <div className="grid grid-cols-1 gap-10 py-12 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-14 lg:py-16">
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <p className="panel-label mb-4">Documentation</p>
          <nav className="flex flex-col border-l border-border">
            {DOCS_NAV.map((item) => {
              const active = item.to === pathname.replace(/\/$/, "");
              return (
                <Link
                  key={item.to}
                  href={item.to}
                  className={`-ml-px border-l py-2 pl-4 font-sans text-sm transition-colors ${
                    active
                      ? "border-muon-blue font-semibold text-foreground"
                      : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </aside>

        <article className="min-w-0 max-w-[74ch]">
          <p className="panel-label mb-3">{eyebrow}</p>
          <h1 className="mb-5 font-sans text-4xl font-semibold leading-[1.1] tracking-[-0.03em] lg:text-[2.75rem]">
            {title}
          </h1>
          <p className="mb-12 text-base leading-relaxed text-muted-foreground lg:text-lg">{intro}</p>

          <div className="space-y-12">{children}</div>

          <div className="mt-16 grid grid-cols-1 gap-3 border-t border-border pt-8 sm:grid-cols-2">
            {prev ? (
              <Link href={prev.to} className="panel p-4 transition-colors hover:border-muon-blue/60">
                <span className="panel-label">Previous</span>
                <span className="mt-1 block font-sans text-base font-semibold">← {prev.label}</span>
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link
                href={next.to}
                className="panel p-4 text-right transition-colors hover:border-muon-blue/60"
              >
                <span className="panel-label">Next</span>
                <span className="mt-1 block font-sans text-base font-semibold">{next.label} →</span>
              </Link>
            ) : null}
          </div>
        </article>
      </div>
    </SiteShell>
  );
}

export function DocSection({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="mb-5 font-sans text-2xl font-semibold tracking-[-0.02em]">{title}</h2>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

export function P({ children }: { children: ReactNode }) {
  return <p className="text-[0.9375rem] leading-[1.75] text-muted-foreground">{children}</p>;
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="border border-border bg-panel/60 px-1.5 py-0.5 font-mono text-[0.8125rem] text-foreground">
      {children}
    </code>
  );
}

export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="panel overflow-x-auto p-4 font-mono text-[0.8125rem] leading-relaxed text-foreground">
      {children}
    </pre>
  );
}

export function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-3">
      {items.map((item, i) => (
        <li
          key={i}
          className="flex gap-3 text-[0.9375rem] leading-[1.75] text-muted-foreground"
        >
          <span className="mt-[0.7em] size-1.5 shrink-0 bg-trust-human" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export function Steps({ items }: { items: { title: string; body: ReactNode }[] }) {
  return (
    <ol className="space-y-4">
      {items.map((item, i) => (
        <li key={item.title} className="panel p-5">
          <div className="mb-2 flex items-center gap-3">
            <span className="font-mono text-[11px] tracking-[0.14em] text-muon-blue">
              {String(i + 1).padStart(2, "0")}
            </span>
            <h3 className="font-sans text-base font-semibold">{item.title}</h3>
          </div>
          <div className="space-y-3">{item.body}</div>
        </li>
      ))}
    </ol>
  );
}

export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warn";
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`border-l-2 bg-panel/40 p-5 ${
        tone === "warn" ? "border-trust-stale" : "border-muon-blue"
      }`}
    >
      <p className="mb-2 font-sans text-sm font-semibold">{title}</p>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

export function DocTable({
  head,
  rows,
}: {
  head: string[];
  rows: ReactNode[][];
}) {
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full border-collapse text-left text-[0.875rem]">
        <thead>
          <tr className="border-b border-border">
            {head.map((h) => (
              <th key={h} className="panel-label p-3 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              {row.map((cell, j) => (
                <td key={j} className="p-3 align-top text-muted-foreground">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
