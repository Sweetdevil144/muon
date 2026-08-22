import type { Metadata } from "next";
import Link from "next/link";

import { SiteShell } from "@/components/muon/SiteShell";
import { PageHero, SectionHead } from "@/components/muon/PageHero";
import { CoordinationDiagram } from "@/components/muon/CoordinationDiagram";
import { TerminalReplay } from "@/components/muon/TerminalReplay";


const TITLE = "How it works — one mission in, one reviewed result out | MUON";
const DESCRIPTION =
  "Connect your tools, give MUON one mission, launch the crew, keep everyone in sync through shared memory, and review the change before it lands.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
  },
};


const STEPS = [
  {
    label: "Connect",
    title: "Make sure your tools are ready",
    command: "muon doctor",
    body: "MUON checks that your AI coding tools are installed and signed in, then tells you exactly what is missing.",
  },
  {
    label: "Plan",
    title: "Give MUON one mission",
    command: "muon chat --workspace .",
    body: "Start from Desktop, the terminal, or a connected Claude or Codex chat. MUON turns the goal into jobs, owners, and review points.",
  },
  {
    label: "Assign",
    title: "Launch the crew",
    command: "muon dispatch start",
    body: "Agents work in safe copies of your project with budgets and ownership, while MUON tracks progress against the mission.",
  },
  {
    label: "Coordinate",
    title: "Keep the crew in sync",
    command: "muon dispatch status",
    body: "Memory, updates, checks, and handoffs move with the work, so you are not the relay between windows.",
  },
  {
    label: "Review",
    title: "Decide what can land",
    command: "muon approve resolve --status approved",
    body: "You see the change, the checks, and the history before anything merges into your main project.",
  },
];

function HowItWorksPage() {
  return (
    <SiteShell>
      <PageHero
        eyebrow="How it works"
        title="One mission in. One reviewed result out."
        intro="Your team gives MUON the outcome. MUON proposes the crew, runs the work, keeps everyone aligned, and brings the final result back with the evidence you need to decide."
        cta={{ label: "Explore the product", to: "/product" }}
      />

      <section className="border-b border-border py-20 lg:py-28">
        <SectionHead eyebrow="The loop" title="Five steps, from goal to merged change." />
        <ol className="panel divide-y divide-border">
          {STEPS.map((step, i) => (
            <li key={step.label} className="grid grid-cols-12 gap-4 p-6">
              <div className="col-span-12 flex items-center gap-3 lg:col-span-3">
                <span className="font-sans text-[1.75rem] font-semibold tracking-[-0.02em] text-muted-foreground">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="font-mono text-[11px] uppercase tracking-[0.18em]">
                  {step.label}
                </span>
              </div>
              <div className="col-span-12 lg:col-span-9">
                <h3 className="mb-2 font-sans text-lg font-semibold tracking-[-0.01em]">
                  {step.title}
                </h3>
                <p className="mb-3 max-w-[70ch] text-[0.9375rem] leading-relaxed text-muted-foreground">
                  {step.body}
                </p>
                <code className="inline-block border border-border px-3 py-1.5 font-mono text-xs text-trust-crew">
                  {step.command}
                </code>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="border-b border-border py-20 lg:py-28">
        <SectionHead
          eyebrow="In your terminal"
          title="What it looks like from a Claude Code session."
          note="Same mission, driven from a chat session over MCP: MUON checks memory before the edit, splits the work, stops double-writes, and holds the merge for you."
        />
        <TerminalReplay />
      </section>

      <section className="border-b border-border py-20 lg:py-28">
        <SectionHead
          eyebrow="The picture"
          title="How a mission moves through the crew."
          note="One goal in, split into owned jobs, coordinated through shared memory, and held for your approval before it merges."
        />
        <CoordinationDiagram />
      </section>


      <section className="py-20 lg:py-28">
        <div className="panel flex flex-col items-start justify-between gap-6 p-8 lg:flex-row lg:items-center">
          <h2 className="max-w-[30ch] font-sans text-[1.75rem] font-semibold tracking-[-0.02em]">
            MUON handles coordination. People decide what ships.
          </h2>
          <Link href="/download" className="btn-primary">
            Install the app
          </Link>
        </div>
      </section>
    </SiteShell>
  );
}

export default HowItWorksPage;
