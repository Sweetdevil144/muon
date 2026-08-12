import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { PageIntro } from "@/components/marketing/page-intro";
import { faqItems } from "@/lib/marketing-content";

export const metadata: Metadata = {
  title: "FAQ, MUON",
  description:
    "Plain answers about what MUON is, which AI tools it works with, how control stays with people, and how to install it.",
};

export default function FaqPage() {
  return (
    <MarketingShell>
      <PageIntro
        action={{ label: "Explore the product", href: "/product" }}
        eyebrow="FAQ"
        intro="Straight answers about what MUON is, which tools it works with, how people stay in control, and what to expect from the free download."
        title="Answers before you evaluate"
      />
      <section className="mx-auto max-w-5xl px-4 py-20 sm:px-6 sm:py-28">
        <div className="border-t-2 border-[var(--bauhaus-ink)]">
          {faqItems.map((item, index) => (
            <details
              className="group border-b-2 border-[var(--bauhaus-ink)]"
              key={item.question}
            >
              <summary className="flex cursor-pointer list-none items-start gap-5 py-7 marker:hidden sm:gap-8 sm:py-9">
                <span className="mt-1 text-sm font-black text-[var(--bauhaus-red)]">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="flex-1 text-xl font-black uppercase leading-tight tracking-[-0.03em] sm:text-2xl">
                  {item.question}
                </span>
                <span
                  aria-hidden="true"
                  className="grid size-8 shrink-0 place-items-center border-2 border-[var(--bauhaus-ink)] text-xl font-black transition-transform group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="max-w-3xl pb-8 pl-10 text-lg leading-8 text-black/60 sm:pl-16">
                {item.answer}
              </p>
            </details>
          ))}
        </div>
        <div className="mt-14 flex flex-col gap-6 bg-[var(--bauhaus-yellow)] p-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-2xl font-black uppercase tracking-[-0.03em]">
            Still deciding if MUON fits your workflow?
          </p>
          <Link
            className="shrink-0 border-2 border-[var(--bauhaus-ink)] bg-[var(--bauhaus-red)] px-5 py-4 text-center text-sm font-black uppercase tracking-[0.1em] text-white"
            href="/download"
          >
            Install the app
          </Link>
        </div>
      </section>
    </MarketingShell>
  );
}
