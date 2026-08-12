import type { Metadata } from "next";
import { Check } from "lucide-react";
import Link from "next/link";
import { EarlyAccessForm } from "@/components/marketing/early-access-form";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { PageIntro } from "@/components/marketing/page-intro";
import { pricingPlans } from "@/lib/marketing-content";

export const metadata: Metadata = {
  title: "Pricing, MUON",
  description:
    "The MUON Desktop app is free for individual use. Contact us for team pricing. Your AI tool subscriptions stay separate.",
};

export default function PricingPage() {
  return (
    <MarketingShell>
      <PageIntro
        action={{ label: "Contact for team pricing", href: "/enterprise" }}
        eyebrow="Pricing"
        intro="The MUON Desktop app is free for individual use. Teams can contact us for pricing. Your AI tool subscriptions and usage stay separate."
        title="Free for individuals. Team pricing on request."
      />
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-28">
        <div className="grid gap-0 border-2 border-[var(--bauhaus-ink)] lg:grid-cols-2">
          {pricingPlans.map((plan, index) => (
            <article
              className={`p-7 sm:p-10 ${
                index === 0
                  ? "border-b-2 border-[var(--bauhaus-ink)] bg-white lg:border-b-0 lg:border-r-2"
                  : "bg-[var(--bauhaus-ink)] text-white"
              }`}
              key={plan.name}
            >
              <div className="flex flex-wrap items-center justify-between gap-4">
                <h2 className="text-3xl font-black uppercase tracking-[-0.04em]">
                  {plan.name}
                </h2>
                <span
                  className={`px-3 py-1 text-xs font-black uppercase tracking-[0.12em] ${
                    index === 0
                      ? "bg-[var(--bauhaus-yellow)] text-[var(--bauhaus-ink)]"
                      : "bg-[var(--bauhaus-yellow)] text-[var(--bauhaus-ink)]"
                  }`}
                >
                  {plan.status}
                </span>
              </div>
              <p className="mt-10 text-2xl font-black">{plan.price}</p>
              <p
                className={`mt-4 max-w-xl leading-7 ${
                  index === 0 ? "text-black/60" : "text-white/60"
                }`}
              >
                {plan.description}
              </p>
              <ul className="mt-8 grid gap-4">
                {plan.features.map((feature) => (
                  <li className="flex items-start gap-3" key={feature}>
                    <span
                      className={`mt-0.5 grid size-6 shrink-0 place-items-center text-white ${
                        index === 0
                          ? "bg-[var(--bauhaus-blue)]"
                          : "bg-[var(--bauhaus-red)]"
                      }`}
                    >
                      <Check className="size-4" />
                    </span>
                    <span className="text-sm font-bold">{feature}</span>
                  </li>
                ))}
              </ul>
              <Link
                className={`mt-10 inline-flex border-2 px-5 py-4 text-sm font-black uppercase tracking-[0.1em] ${
                  index === 0
                    ? "border-[var(--bauhaus-ink)] bg-[var(--bauhaus-red)] text-white shadow-[6px_6px_0_var(--bauhaus-ink)]"
                    : "border-white bg-[var(--bauhaus-yellow)] text-[var(--bauhaus-ink)]"
                }`}
                href={plan.cta.href}
              >
                {plan.cta.label}
              </Link>
            </article>
          ))}
        </div>

        <div className="mt-16 border-2 border-[var(--bauhaus-ink)] bg-[var(--bauhaus-paper)] p-7 sm:p-10">
          <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-center">
            <div>
              <p className="bauhaus-eyebrow">Release updates</p>
              <h2 className="mt-4 text-3xl font-black uppercase tracking-[-0.04em]">
                Get release updates
              </h2>
              <p className="mt-4 max-w-md leading-7 text-black/60">
                Join the list for release announcements. For team pricing
                and evaluation, use the enterprise form instead.
              </p>
            </div>
            <EarlyAccessForm compact />
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
