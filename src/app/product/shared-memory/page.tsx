import type { Metadata } from "next";
import Link from "next/link";

import { SiteShell } from "@/components/muon/SiteShell";
import { PageHero, NumberedList } from "@/components/muon/PageHero";
import { SharedMemory } from "@/components/muon/SharedMemory";
import { MemoryExplorer } from "@/components/muon/MissionRun";

const TITLE = "Shared memory — one view of what your crew knows | MUON";
const DESCRIPTION =
  "Each agent keeps notes for its own job. The crew shares what matters, scoped to your project, and you confirm what becomes lasting knowledge.";

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


const POINTS = [
  {
    title: "Personal and shared",
    description: "Agents remember their own thread and can see relevant progress from teammates.",
  },
  {
    title: "Nothing lasting by accident",
    description:
      "Proposed notes stay provisional until a person confirms them as durable knowledge.",
  },
  {
    title: "Local by default",
    description:
      "Memory stays on your machine. Optional local helpers improve search, and the product still works without them.",
  },
];

function SharedMemoryPage() {
  return (
    <SiteShell>
      <PageHero
        eyebrow="Shared memory"
        title="Give every agent memory, and the crew a shared view"
        intro="Each agent keeps notes for its own job. The crew also shares what matters, so specialists are not starting from zero every time."
        cta={{ label: "Explore the whole product", to: "/product" }}
      />

      <section className="border-b border-border py-20 lg:py-28">
        <div className="mb-8">
          <p className="panel-label mb-3">Try it</p>
          <h2 className="max-w-[30ch] font-sans text-[1.75rem] font-semibold tracking-[-0.02em] lg:text-4xl">
            Confirm a note, and watch what a later mission inherits.
          </h2>
        </div>
        <MemoryExplorer />
      </section>

      <SharedMemory />

      <section className="border-t border-border py-20 lg:py-28">
        <NumberedList items={POINTS} />
      </section>

      <section className="border-t border-border py-20 lg:py-28">
        <div className="panel flex flex-col items-start justify-between gap-6 p-8 lg:flex-row lg:items-center">
          <h2 className="max-w-[30ch] font-sans text-[1.75rem] font-semibold tracking-[-0.02em]">
            You stop being the person who copies context between tools.
          </h2>
          <Link href="/download" className="btn-primary">
            Install the app
          </Link>
        </div>
      </section>
    </SiteShell>
  );
}

export default SharedMemoryPage;
