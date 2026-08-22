import type { Metadata } from "next";
import Link from "next/link";

import { SiteShell } from "@/components/muon/SiteShell";
import { PageHero, NumberedList, SectionHead } from "@/components/muon/PageHero";
import { CrewStack } from "@/components/muon/CrewStack";
import { MissionRun } from "@/components/muon/MissionRun";

const TITLE = "Product — one control layer for your AI engineering crew | MUON";
const DESCRIPTION =
  "MUON sits between your mission and the AI coding tools doing the work: clear jobs, shared memory, approvals, handoffs, and people deciding what ships.";

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


const CAPABILITIES = [
  {
    title: "Command center",
    description: "See the mission, who is working, what is blocked, and what needs your call.",
  },
  {
    title: "Shared memory",
    description:
      "Agents remember their own work and see what the rest of the crew already learned.",
  },
  {
    title: "Approvals",
    description: "Review the exact change and the evidence before anything important goes through.",
  },
  {
    title: "Handoffs",
    description:
      "Pass goals, results, and open questions to the next specialist without retelling the story.",
  },
  {
    title: "Your AI tools",
    description:
      "Put Claude Code, Codex, Cursor, and OpenCode on clear jobs instead of competing windows.",
  },
  {
    title: "Human control",
    description: "Pause, redirect, take over, or decide what ships. People keep the final say.",
  },
];

function ProductPage() {
  return (
    <SiteShell>
      <PageHero
        eyebrow="Product"
        title="One control layer for your AI engineering crew"
        intro="MUON sits between your mission and the AI coding tools doing the work. It assigns clear jobs, keeps context moving, tracks progress, and brings real decisions back to your team."
        cta={{ label: "See how the loop works", to: "/how-it-works" }}
      />

      <section className="border-b border-border py-20 lg:py-28">
        <SectionHead
          eyebrow="What you get"
          title="MUON runs the crew. Your team decides what ships."
        />
        <NumberedList items={CAPABILITIES} />
      </section>

      <section className="border-b border-border py-20 lg:py-28">
        <SectionHead
          eyebrow="See it run"
          title="Watch one mission run, and decide the merge yourself."
          note="An example mission on a checkout service: each lane gets a role, the crew coordinates through shared memory, and the work stops at a merge only a person can approve."
        />
        <MissionRun variant="full" />
      </section>

      <CrewStack />


      <section className="py-20 lg:py-28">
        <div className="panel flex flex-col items-start justify-between gap-6 p-8 lg:flex-row lg:items-center">
          <h2 className="max-w-[30ch] font-sans text-[1.75rem] font-semibold tracking-[-0.02em]">
            Shared memory is what keeps the crew from starting over.
          </h2>
          <Link href="/product/shared-memory" className="btn-primary">
            Explore shared memory
          </Link>
        </div>
      </section>
    </SiteShell>
  );
}

export default ProductPage;
