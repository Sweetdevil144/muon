import type { Metadata } from "next";
import Link from "next/link";

import { SiteShell } from "@/components/muon/SiteShell";
import { PageHero } from "@/components/muon/PageHero";

const TITLE = "Security — custody, authority and evidence | MUON";
const DESCRIPTION =
  "Plain-language summary of how MUON treats custody, authority and evidence: local by default, people approve what matters, and an inspectable trail.";

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


const POSTURE = [
  {
    title: "Local by default",
    body: "MUON runs on your machine. Mission data, memory and activity stay local unless you choose to export them. MUON does not take custody of your Claude, Codex, Cursor or OpenCode logins.",
  },
  {
    title: "People approve what matters",
    body: "Sensitive edits, shell commands and shipping wait for a person by default. Full Auto is an explicit, per-agent standing consent you can revoke at any time, and every automatic approval is recorded.",
  },
  {
    title: "A trail you can inspect",
    body: "Approvals and key decisions keep identity and request context where the product supports it. Activity history is append-only. A full enterprise audit export surface is still being completed.",
  },
  {
    title: "Secrets stay out of logs",
    body: "Diagnostic paths scrub tokens and key-shaped strings before they hit logs or CI. Builds fail if secret-handling code logs the wrong way.",
  },
  {
    title: "What is not claimed yet",
    body: "MUON does not claim SOC 2, ISO 27001 or a finished third-party penetration test for current early releases. Internal adversarial tests cover refusal paths and containment; they are not a substitute for external attestation.",
  },
  {
    title: "Shared responsibility",
    body: "You keep AI tools updated, protect operator access and review approvals. MUON is responsible for narrow permissions, memory boundaries and failing closed when authority cannot be verified.",
  },
  {
    title: "Vulnerability disclosure",
    body: "Report security issues to security@muonlabs.dev. We aim to acknowledge within 3 business days and share a remediation timeline within 14 days for confirmed issues.",
  },
];

function SecurityPage() {
  return (
    <SiteShell>
      <PageHero
        eyebrow="Security"
        title="Security and trust boundaries"
        intro="A plain-language summary of how MUON treats custody, authority and evidence, including what is shipped today and what is still open."
        cta={{ label: "Talk to us about enterprise fit", to: "/enterprise" }}
      />

      <section className="py-20 lg:py-28">
        <p className="mb-6 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          This page describes product posture, not a certification.
        </p>
        <ol className="panel divide-y divide-border">
          {POSTURE.map((item, i) => (
            <li key={item.title} className="grid grid-cols-12 gap-4 p-6">
              <div className="col-span-12 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground lg:col-span-2">
                {String(i + 1).padStart(2, "0")}
              </div>
              <div className="col-span-12 lg:col-span-10">
                <h2 className="mb-2 font-sans text-lg font-semibold tracking-[-0.01em]">
                  {item.title}
                </h2>
                <p className="max-w-[80ch] text-[0.9375rem] leading-relaxed text-muted-foreground">
                  {item.body}
                </p>
              </div>
            </li>
          ))}
        </ol>

        <div className="panel mt-10 flex flex-col items-start justify-between gap-6 p-8 lg:flex-row lg:items-center">
          <h2 className="font-sans text-[1.75rem] font-semibold tracking-[-0.02em]">
            Need a deeper security conversation?
          </h2>
          <Link href="/enterprise" className="btn-primary">
            Contact enterprise
          </Link>
        </div>
      </section>
    </SiteShell>
  );
}

export default SecurityPage;
