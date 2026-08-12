import type { Metadata } from "next";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { PageIntro } from "@/components/marketing/page-intro";

export const metadata: Metadata = {
  title: "Privacy, MUON",
  description:
    "What MUON stores locally, what leaves your machine, and what this website collects.",
};

const sections = [
  {
    title: "MUON runs on your machine",
    copy:
      "MUON is local-first. Your mission history, memory, and activity are stored in a local database and settings files under your own user profile on your Mac. We do not run a server that copies this data off your machine, and there is no MUON account required to use it.",
  },
  {
    title: "Diagnostics are opt-in, anonymous, and structurally bounded",
    copy:
      "By default MUON uploads nothing. If you turn on the diagnostics toggle in Settings, a fixed set of events is sent to our analytics provider (PostHog, hosted in the US): app launches, coarse crash codes, update checks, and activation milestones. Every field is an enum, a number, a boolean, or the app version, so a file path, prompt, repo name, or credential has no field to travel in. Events carry a random identifier created when you opt in and discarded when you opt out, never your name, email, or machine identity. The exact bytes are also written to a local spool file you can read yourself.",
  },
  {
    title: "Your AI tool logins never touch MUON",
    copy:
      "Claude Code, Codex, Cursor, and OpenCode are your own accounts, authenticated through each tool's own login. MUON runs your already-installed copy of each one and never stores, reads, or forwards its login credential.",
  },
  {
    title: "GitHub, only if you connect it",
    copy:
      "Connecting GitHub is optional. If you do, MUON stores that credential in a settings file on your machine, locked to your user account (file permission 0600, unreadable by other users on the same machine). It is used only for GitHub API calls you initiate: signing in, reading pull requests and reviews, and opening or merging a pull request. It is never used for anything else, and never sent anywhere other than GitHub's own API.",
  },
  {
    title: "What actually leaves your machine",
    copy:
      "Two things. First, whatever traffic your own AI coding tools send to their own vendors when you use them, that is between you and Anthropic, OpenAI, Cursor, or OpenCode; MUON does not add tracking to it and has no visibility into it. Second, GitHub API calls, but only for the connection above, only when you use it, and only to GitHub.",
  },
  {
    title: "This website",
    copy:
      "muonlabs.dev uses Vercel Web Analytics for aggregated traffic counts, such as which pages get visited. Vercel's documented design for this product does not use cookies, does not collect anything that identifies you personally, and discards session-level data after 24 hours. We do not run any other analytics, advertising pixel, or tracking script on this site.",
  },
  {
    title: "We do not sell data",
    copy:
      "We do not sell, rent, or trade any data, whether it is the local data on your machine or the limited traffic data described above.",
  },
  {
    title: "The telemetry promise, kept",
    copy:
      "We wrote here that an uploader would ship only with consent, an exact description, and a revision to this page. That is this revision: the uploader exists as of v0.1.2, it is off by default, the field list above is complete, and turning the toggle off stops uploads immediately.",
  },
  {
    title: "Questions or a report",
    copy:
      "Contact security@muonlabs.dev with privacy or security questions, including a request to understand what a specific build stores locally.",
  },
] as const;

export default function PrivacyPage() {
  return (
    <MarketingShell>
      <PageIntro
        eyebrow="Privacy"
        intro="A plain description of what MUON stores on your machine, what leaves it, and what this website collects. Checked against the code, not just the intent."
        title="Your data stays on your machine"
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
      </section>
    </MarketingShell>
  );
}
