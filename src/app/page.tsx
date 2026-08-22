import type { Metadata } from "next";
import Link from "next/link";

import { SiteShell } from "@/components/muon/SiteShell";
import { Hero } from "@/components/muon/Hero";
import { NotAnAgent } from "@/components/muon/NotAnAgent";
import { OperatingLoop } from "@/components/muon/OperatingLoop";
import { SharedMemory } from "@/components/muon/SharedMemory";
import { CrewStack } from "@/components/muon/CrewStack";
import { TwoWays } from "@/components/muon/TwoWays";
import { TrustClose } from "@/components/muon/TrustClose";

const TITLE = "MUON — run your AI coding agents as one crew";
const DESCRIPTION =
  "Give MUON one mission. It plans the work, puts Claude Code, Codex, Cursor and OpenCode on clear jobs, keeps them aligned through shared memory, and brings you back to approve what ships.";

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


function Index() {
  return (
    <SiteShell>
      <Hero />
      <NotAnAgent />
      <OperatingLoop />
      <SharedMemory />
      <CrewStack />
      {/* The commercial seam sits after the product story, before the close
          (appendix §4): Individual and Teams with the same visual weight. */}
      <TwoWays />
      <TrustClose />

      <section className="border-t border-border py-10">
        <div className="flex flex-wrap items-center gap-4">
          <span className="panel-label">Go deeper</span>
          <Link href="/how-it-works" className="btn-ghost text-sm">
            How it works
          </Link>
          <Link href="/product/shared-memory" className="btn-ghost text-sm">
            Shared memory
          </Link>
          <Link href="/security" className="btn-ghost text-sm">
            Security
          </Link>
        </div>
      </section>
    </SiteShell>
  );
}

export default Index;
