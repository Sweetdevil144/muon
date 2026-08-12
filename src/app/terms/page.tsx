import type { Metadata } from "next";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { PageIntro } from "@/components/marketing/page-intro";

export const metadata: Metadata = {
  title: "Terms, MUON",
  description:
    "Plain-language terms of use for MUON's free early releases, ahead of a counsel review before general availability.",
};

const sections = [
  {
    title: "Provided as-is",
    copy:
      "MUON is a pre-1.0 developer tool in early release. It is provided as-is, without warranty of any kind, express or implied, including any warranty of merchantability, fitness for a particular purpose, or non-infringement.",
  },
  {
    title: "You review what ships",
    copy:
      "MUON coordinates AI coding agents, but it does not remove your responsibility. You are responsible for reviewing any agent-produced change before it merges, deploys, or otherwise ships, and for the consequences of approving it.",
  },
  {
    title: "You need the right to the code you point us at",
    copy:
      "You must have the legal right to use MUON on any repository or codebase you connect it to, whether that right comes from ownership, employment, or an explicit license or permission from the owner.",
  },
  {
    title: "Your AI tool accounts are your own",
    copy:
      "Claude Code, Codex, Cursor, and OpenCode are accounts you bring yourself. Your use of each one is governed by that vendor's own terms of service, not by MUON's, and MUON is not a party to your agreement with them.",
  },
  {
    title: "Limitation of liability",
    copy:
      "To the maximum extent permitted by law, MUON Labs will not be liable for any indirect, incidental, special, consequential, or punitive damages, or any loss of data, revenue, or profits, arising from your use of MUON, even if advised of the possibility of such damages.",
  },
  {
    title: "Governing law",
    copy:
      "To be specified. We have not yet finalized a governing jurisdiction for these terms and will update this section once we do, rather than naming a placeholder that does not reflect a real decision.",
  },
  {
    title: "Changes",
    copy:
      "These terms may change as MUON moves from early release toward general availability. We will update the date below when they do.",
  },
  {
    title: "Contact",
    copy:
      "Questions about these terms: security@muonlabs.dev.",
  },
] as const;

export default function TermsPage() {
  return (
    <MarketingShell>
      <PageIntro
        eyebrow="Terms"
        intro="Plain-language terms of use for MUON's free early releases. Short, on purpose, because pretending a pre-1.0 tool has enterprise-grade legal terms would be its own kind of dishonesty."
        title="Terms of use"
      />
      <section className="mx-auto max-w-5xl px-4 py-20 sm:px-6 sm:py-28">
        <p className="mb-10 max-w-3xl text-sm leading-7 text-black/55">
          Last updated 2026-08-05.
        </p>
        <div className="border-t-2 border-[var(--bauhaus-ink)]">
          {sections.map((section, index) => (
            <div
              className="grid gap-3 border-b-2 border-[var(--bauhaus-ink)] py-8 sm:grid-cols-[4rem_1fr] sm:gap-8 sm:py-10"
              key={section.title}
            >
              <p className="text-sm font-black text-[var(--bauhaus-red)]">
                {String(index + 1).padStart(2, "0")}
              </p>
              <div>
                <h2 className="text-xl font-black uppercase tracking-[-0.03em] sm:text-2xl">
                  {section.title}
                </h2>
                <p className="mt-4 max-w-3xl text-lg leading-8 text-black/60">
                  {section.copy}
                </p>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-14 max-w-3xl text-sm leading-7 text-black/55">
          This is a plain-language draft for the early releases and will be
          reviewed by counsel before general availability.
        </p>
      </section>
    </MarketingShell>
  );
}
