import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { PageIntro } from "@/components/marketing/page-intro";
import {
  crewStack,
  integrationStatus,
  productMenu,
  surfaceProof,
} from "@/lib/marketing-content";

export const metadata: Metadata = {
  title: "Product, MUON",
  description:
    "See how MUON plans work, keeps AI coding agents aligned, and brings people back for the decisions that matter.",
};

export default function ProductPage() {
  const items = [...productMenu[0].items, ...productMenu[1].items];

  return (
    <MarketingShell>
      <PageIntro
        action={{ label: "See how the loop works", href: "/how-it-works" }}
        eyebrow="Product"
        intro="MUON sits between your mission and the AI coding tools doing the work. It assigns clear jobs, keeps context moving, tracks progress, and brings real decisions back to your team."
        title="One control layer for your AI engineering crew"
      />
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-28">
        <div className="mb-16 grid gap-8 border-l-[0.8rem] border-[var(--bauhaus-red)] bg-white p-8 lg:grid-cols-[0.5fr_1fr] lg:items-center sm:p-12">
          <p className="bauhaus-eyebrow">The platform contract</p>
          <p className="text-2xl font-black uppercase leading-tight tracking-[-0.035em] sm:text-3xl">
            MUON runs the crew. Your team sets the mission, approves sensitive
            actions, and decides what ships.
          </p>
        </div>

        <div className="grid border-2 border-[var(--bauhaus-ink)] md:grid-cols-2 lg:grid-cols-3">
          {items.map((item, index) => (
            <Link
              className={`group min-h-72 p-7 transition hover:bg-white sm:p-9 ${
                index < items.length - 1 ? "border-b-2 border-[var(--bauhaus-ink)]" : ""
              } ${
                index % 3 !== 2 ? "lg:border-r-2 lg:border-[var(--bauhaus-ink)]" : ""
              } ${index >= 3 ? "lg:border-b-0" : ""} ${
                index % 2 === 0 ? "md:border-r-2 md:border-[var(--bauhaus-ink)] lg:border-r-2" : ""
              }`}
              href={item.href}
              key={item.href}
            >
              <span className="text-sm font-black text-[var(--bauhaus-red)]">
                0{index + 1}
              </span>
              <h2 className="mt-14 text-2xl font-black uppercase tracking-[-0.035em] group-hover:underline group-hover:decoration-4 group-hover:underline-offset-8">
                {item.title}
              </h2>
              <p className="mt-4 leading-7 text-black/60">{item.description}</p>
            </Link>
          ))}
        </div>

        <div className="mt-24">
          <p className="bauhaus-eyebrow">Working surfaces</p>
          <h2 className="mt-6 max-w-4xl text-balance text-4xl font-black uppercase leading-[0.98] tracking-[-0.05em] sm:text-5xl">
            One mission record, however your team works.
          </h2>
          <div className="mt-12 grid border-2 border-[var(--bauhaus-ink)] lg:grid-cols-3">
            {surfaceProof.map((surface, index) => (
              <article
                className={`p-7 sm:p-9 ${
                  index < surfaceProof.length - 1
                    ? "border-b-2 border-[var(--bauhaus-ink)] lg:border-b-0 lg:border-r-2"
                    : ""
                }`}
                key={surface.name}
              >
                <p className="text-xs font-black uppercase tracking-[0.14em] text-[var(--bauhaus-blue)]">
                  {surface.status}
                </p>
                <h3 className="mt-5 text-3xl font-black uppercase tracking-[-0.04em]">
                  {surface.name}
                </h3>
                <p className="mt-5 leading-7 text-black/60">
                  {surface.description}
                </p>
              </article>
            ))}
          </div>
        </div>

        <div className="mt-24 border-2 border-[var(--bauhaus-ink)] bg-[var(--bauhaus-ink)] p-8 text-white sm:p-12">
          <div className="grid gap-10 lg:grid-cols-[0.55fr_1fr]">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.2em] text-white/45">
                Your AI tools
              </p>
              <h2 className="mt-5 text-3xl font-black uppercase leading-tight tracking-[-0.04em] sm:text-4xl">
                Clear roles. Honest limits.
              </h2>
              <div className="mt-6 flex flex-wrap gap-2">
                {crewStack.map((agent) => (
                  <span
                    className="border border-white/35 px-3 py-2 text-[0.62rem] font-black uppercase tracking-[0.1em] text-white/80"
                    key={agent}
                  >
                    {agent}
                  </span>
                ))}
              </div>
            </div>
            <div className="grid gap-4">
              {integrationStatus.map((integration) => (
                <div
                  className="grid gap-2 border-t border-white/20 pt-4 sm:grid-cols-[0.35fr_0.65fr_1fr]"
                  key={integration.name}
                >
                  <strong>{integration.name}</strong>
                  <span className="text-sm font-bold text-[var(--bauhaus-yellow)]">
                    {integration.status}
                  </span>
                  <p className="text-sm leading-6 text-white/55">
                    {integration.detail}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
