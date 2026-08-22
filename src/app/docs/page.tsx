import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowUpRight,
  Download,
  MessageSquare,
  Rocket,
  ShieldCheck,
  TerminalSquare,
  Wrench,
} from "lucide-react";

import { Bullets, DocSection, DocsLayout, P } from "@/components/docs/DocsLayout";

const TITLE = "MUON docs — install, quickstart, CLI, MCP and governance";
const DESCRIPTION =
  "Start here: install MUON, run your first mission, drive it from the CLI, attach the MCP server to your own agent session, and understand the approval gates.";

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


const CARDS = [
  { icon: Download, title: "Install", body: "The macOS app, the unsigned first-launch step, and requirements.", to: "/docs/install" },
  { icon: Rocket, title: "Quickstart", body: "Open the app, connect an agent, run your first mission.", to: "/docs/quickstart" },
  { icon: TerminalSquare, title: "CLI reference", body: "muon chat, dispatch, fleet, memory, and more.", to: "/docs/cli" },
  { icon: MessageSquare, title: "MCP server", body: "Give your own CLI session MUON's shared brain.", to: "/docs/mcp" },
  { icon: ShieldCheck, title: "Governance", body: "Approval gates, memory tiers, full-auto, and what never happens.", to: "/docs/governance" },
  { icon: Wrench, title: "Troubleshooting", body: "Vendor CLI not found, stale index, brain not running, logs.", to: "/docs/troubleshooting" },
];

function DocsIndex() {
  return (
    <DocsLayout
      eyebrow="Docs"
      title="A local-first control plane for your coding agents"
      intro="MUON drives the coding-agent CLIs you already have — Claude Code, Codex, Cursor and OpenCode — as one coordinated crew, running entirely on your machine. Every edit passes through approval gates you control, and every fact your agents rely on lives in a shared, human-confirmed memory instead of being re-litigated task after task."
    >
      <section>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {CARDS.map((card) => (
            <Link
              key={card.title}
              href={card.to}
              className="panel group flex flex-col p-5 transition-colors hover:border-muon-blue/60"
            >
              <div className="mb-4 flex items-center justify-between">
                <card.icon className="size-5 text-trust-crew" />
                <ArrowUpRight className="size-4 text-muted-foreground transition-colors group-hover:text-foreground" />
              </div>
              <h2 className="mb-1.5 font-sans text-base font-semibold tracking-[-0.01em]">
                {card.title}
              </h2>
              <p className="text-[0.875rem] leading-relaxed text-muted-foreground">{card.body}</p>
            </Link>
          ))}
        </div>
      </section>

      <DocSection title="What MUON is">
        <P>
          You keep using the coding agents you already trust. MUON sits above them as an
          orchestrator: it plans work, dispatches it to a fleet of agent instances (0–3 per vendor),
          watches what they do, and stops for your decision at every point that matters — an edit
          outside the expected surface, a network call, a merge. Agents coordinate with each other
          through bounded, authority-free messages and advisory file claims; none of that
          coordination can approve, dispatch, or widen anything on its own.
        </P>
        <P>
          The other half is memory: a graph of decisions, constraints, conventions and attempts,
          fused at edit time with a code-level blast-radius analysis. An agent about to touch a
          symbol sees the prior, human-confirmed decisions anchored to it — and any contested
          proposals a human still needs to resolve — before it writes a line.
        </P>
      </DocSection>

      <DocSection title="What MUON is not">
        <Bullets
          items={[
            "Not a cloud service. There is no MUON account, no hosted brain, and no data leaves your machine except each vendor's own model traffic — which was already leaving; MUON does not add a hop.",
            "Not a replacement for your coding agents. It never ships or custodies one — you install and log in to each vendor CLI yourself, natively.",
            "Not fully hands-off by default. Approval gates are on unless you explicitly arm full-auto, and full-auto is a standing consent you grant per vendor lane, not a permanent setting.",
          ]}
        />
      </DocSection>

      <DocSection title="Where to start">
        <P>
          <Link href="/docs/install" className="text-foreground underline underline-offset-4">
            Install
          </Link>{" "}
          the macOS app, then run a real mission end to end with the{" "}
          <Link href="/docs/quickstart" className="text-foreground underline underline-offset-4">
            quickstart
          </Link>
          . Prefer a terminal? Everything the app does is reachable from the{" "}
          <Link href="/docs/cli" className="text-foreground underline underline-offset-4">
            CLI
          </Link>
          , or from a session you launch yourself with{" "}
          <Link href="/docs/mcp" className="text-foreground underline underline-offset-4">
            MUON's MCP server
          </Link>{" "}
          attached.
        </P>
      </DocSection>
    </DocsLayout>
  );
}

export default DocsIndex;
