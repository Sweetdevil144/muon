import type { Metadata } from "next";

import { SiteShell } from "@/components/muon/SiteShell";
import { PageHero } from "@/components/muon/PageHero";

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

export default function Page() {
  return (
    <SiteShell>
      <PageHero
        eyebrow="Legal"
        title="Terms, MUON"
        intro="Plain-language terms of use for MUON's free early releases, ahead of a counsel review before general availability."
      />
      <div className="mx-auto max-w-3xl pb-24">
        {sections.map((section) => (
          <section key={section.title} className="border-t border-rule py-8">
            <h2 className="font-sans text-lg font-semibold tracking-[-0.02em] text-foreground">
              {section.title}
            </h2>
            <p className="prose-body mt-3">{section.copy}</p>
          </section>
        ))}
      </div>
    </SiteShell>
  );
}
