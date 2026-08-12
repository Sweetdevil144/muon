import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { PageIntro } from "@/components/marketing/page-intro";

export const metadata: Metadata = {
  title: "Security, MUON",
  description:
    "How MUON handles local custody, human approval, audit evidence, and vulnerability disclosure.",
};

const sections = [
  {
    title: "Local by default",
    copy:
      "MUON runs on your machine. Mission data, memory, and activity stay local unless you choose to export them. MUON does not take custody of your Claude, Codex, Cursor, or OpenCode logins. Those stay with their own vendors.",
  },
  {
    title: "People approve what matters",
    copy:
      "Sensitive edits, shell commands, and shipping wait for a person by default. Full Auto is an explicit, per-agent standing consent you can revoke at any time, and every automatic approval is recorded with its subject and risk. Nothing auto-approves unless you switched that on.",
  },
  {
    title: "A trail you can inspect",
    copy:
      "Approvals and key decisions keep identity and request context where the product supports it. Activity history is append-only. A full enterprise audit export surface is still being completed.",
  },
  {
    title: "Secrets stay out of logs",
    copy:
      "Diagnostic paths scrub tokens and key-shaped strings before they hit logs or CI. Builds fail if secret-handling code logs the wrong way.",
  },
  {
    title: "What is not claimed yet",
    copy:
      "MUON does not claim SOC 2, ISO 27001, or a finished third-party penetration test for the current early releases. Internal adversarial tests cover refusal paths and containment. Those are not a substitute for external attestation.",
  },
  {
    title: "Shared responsibility",
    copy:
      "You keep AI tools updated, protect the machine and operator access, review approvals, and avoid committing secrets into projects MUON works on. MUON is responsible for narrow permissions, memory boundaries, and failing closed when authority cannot be verified.",
  },
  {
    title: "Vulnerability disclosure",
    copy:
      "Report security issues to security@muonlabs.dev. We aim to acknowledge reports within 3 business days and share a remediation timeline within 14 days for confirmed issues that affect confidentiality, integrity, or availability of governed actions.",
  },
] as const;

export default function SecurityPage() {
  return (
    <MarketingShell>
      <PageIntro
        action={{ label: "Talk to us about enterprise fit", href: "/enterprise" }}
        eyebrow="Security"
        intro="Plain-language summary of how MUON treats custody, authority, and evidence, including what is shipped today and what is still open."
        title="Security and trust boundaries"
      />
      <section className="mx-auto max-w-5xl px-4 py-20 sm:px-6 sm:py-28">
        <p className="mb-10 max-w-3xl text-sm leading-7 text-black/55">
          Last updated 2026-08-01. This page describes product posture, not a
          certification.
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
        <div className="mt-14 flex flex-col gap-6 bg-[var(--bauhaus-paper)] p-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-2xl font-black uppercase tracking-[-0.03em]">
            Need a deeper security conversation?
          </p>
          <Link
            className="shrink-0 border-2 border-[var(--bauhaus-ink)] bg-[var(--bauhaus-ink)] px-5 py-4 text-center text-sm font-black uppercase tracking-[0.1em] text-white"
            href="/enterprise"
          >
            Contact enterprise
          </Link>
        </div>
      </section>
    </MarketingShell>
  );
}
