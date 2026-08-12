import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { PageIntro } from "@/components/marketing/page-intro";
import { workflowSteps } from "@/lib/marketing-content";

export const metadata: Metadata = {
  title: "How it works, MUON",
  description:
    "See how MUON turns one engineering mission into assigned agent work, coordinated progress, and a human-reviewed result.",
};

export default function HowItWorksPage() {
  return (
    <MarketingShell>
      <PageIntro
        action={{ label: "Explore the product", href: "/product" }}
        eyebrow="How it works"
        intro="Your team gives MUON the outcome. MUON proposes the crew, runs the work, keeps everyone aligned, and brings the final result back with the evidence you need to decide."
        title="One mission in. One reviewed result out."
      />
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-28">
        <ol className="grid gap-10">
          {workflowSteps.map((step) => (
            <li
              className="grid gap-6 border-t-2 border-[var(--bauhaus-ink)] py-10 lg:grid-cols-[8rem_0.55fr_1fr] lg:gap-12"
              key={step.number}
            >
              <span className="text-5xl font-black text-[var(--bauhaus-red)]">
                {step.number}
              </span>
              <div>
                <p className="bauhaus-eyebrow">{step.label}</p>
                <h2 className="mt-4 text-3xl font-black uppercase leading-tight tracking-[-0.04em]">
                  {step.title}
                </h2>
              </div>
              <div className="max-w-2xl">
                <pre className="overflow-x-auto border-2 border-[var(--bauhaus-ink)] bg-white px-4 py-3 font-mono text-sm leading-6 text-[var(--bauhaus-ink)]">
                  <code>{step.command}</code>
                </pre>
                <p className="mt-4 text-lg leading-8 text-black/60">
                  {step.description}
                </p>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-10 grid gap-8 bg-[var(--bauhaus-ink)] p-8 text-white sm:p-12 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.2em] text-white/50">
              The division of responsibility
            </p>
            <h2 className="mt-4 max-w-3xl text-3xl font-black uppercase leading-tight tracking-[-0.04em] sm:text-4xl">
              MUON handles coordination. People set direction, approve
              consequential actions, and decide what ships.
            </h2>
          </div>
          <Link
            className="border-2 border-white bg-[var(--bauhaus-yellow)] px-5 py-4 text-center text-sm font-black uppercase tracking-[0.1em] text-[var(--bauhaus-ink)]"
            href="/product/human-control"
          >
            Human control
          </Link>
        </div>

        <div className="mt-16 grid border-2 border-[var(--bauhaus-ink)] lg:grid-cols-[0.42fr_1fr]">
          <div className="bg-[var(--bauhaus-yellow)] p-8 sm:p-10">
            <p className="bauhaus-eyebrow">One connected record</p>
            <p className="mt-6 text-3xl font-black uppercase leading-tight tracking-[-0.04em]">
              The mission stays understandable from start to finish.
            </p>
          </div>
          <div className="grid gap-5 bg-white p-8 sm:grid-cols-2 sm:p-10">
            {[
              "The goal, the jobs, and who owns each one",
              "Which AI tools are ready to work",
              "Shared memory the crew can actually use",
              "Checks, handoffs, decisions, and the final change",
            ].map((item, index) => (
              <div
                className="border-t-2 border-[var(--bauhaus-ink)] pt-4"
                key={item}
              >
                <span className="text-xs font-black text-[var(--bauhaus-red)]">
                  0{index + 1}
                </span>
                <p className="mt-3 font-bold leading-6">{item}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
