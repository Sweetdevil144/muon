import type { Metadata } from "next";

import { SiteShell } from "@/components/muon/SiteShell";
import { PageHero } from "@/components/muon/PageHero";

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

export default function Page() {
  return (
    <SiteShell>
      <PageHero
        eyebrow="Legal"
        title="Privacy, MUON"
        intro="What MUON stores locally, what leaves your machine, and what this website collects."
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
