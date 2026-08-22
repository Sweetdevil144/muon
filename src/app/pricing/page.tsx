import type { Metadata } from "next";
import { GithubMark as Github } from "@/components/muon/BrandIcon";

import Link from "next/link";

import { SiteShell } from "@/components/muon/SiteShell";
import { PageHero } from "@/components/muon/PageHero";

const TITLE = "Pricing — Individual is free, linking people is the paid product | MUON";
const DESCRIPTION =
  "One person can run MUON free forever under the Individual Use Grant. Linked Operation — two or more people's instances coordinating — is the commercial licence, priced per named person.";

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

// Every bullet is a full clause and a checkable fact (appendix §4): what
// Individual includes, and what a Teams conversation is actually buying.
const INDIVIDUAL = [
  "The complete local product: desk, crews, confirmed memory, dual graph, approvals",
  "No card, no trial, and no meter on memory, recalls, or agents",
  "An employer-issued laptop still counts as your device",
  "Any number of colleagues may each use Individual independently — that does not become a team licence",
  "Packs you carry between your own machines are still Individual use",
  "Your Claude Code, Codex, Cursor, and OpenCode accounts stay yours",
];

const TEAMS = [
  "The legal right the Individual Use Grant reserves: instances that link across people",
  "Recipient-bound packs exchanged between named people",
  "Imports that arrive unconfirmed until a human on the receiving side confirms them",
  "Code and memory that stay on your machines — buying Teams does not move your repository into our cloud",
  "Priced per named person whose instance may link — never per agent, per recall, or per token",
];

function PricingPage() {
  return (
    <SiteShell>
      <PageHero
        eyebrow="Pricing"
        title="Individual is free. Linking people is the paid product."
        intro="You can run MUON alone under the Individual Use Grant, including for work you do for an employer. The source is public under PolyForm Noncommercial 1.0.0. When two or more people's instances coordinate, that is Linked Operation, and it requires a commercial licence. Your Claude, Codex, Cursor, and OpenCode subscriptions stay yours either way."
        cta={{ label: "Start a Teams conversation", to: "/enterprise" }}
      />

      <section className="py-20 lg:py-28">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="panel relative flex flex-col border-muon-blue/60 p-8 ring-1 ring-muon-blue/30">
            <span className="absolute -top-3 left-8 bg-muon-blue px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-primary-foreground">
              Start here
            </span>
            <p className="panel-label mb-3">Individual</p>
            <div className="mb-3 font-sans text-5xl font-semibold tracking-[-0.03em]">Free</div>
            <p className="mb-6 text-[0.9375rem] leading-relaxed text-muted-foreground">
              Forever, for one person. Individual stays whole and free: we do not meter
              remembering, we do not charge per agent, and we do not lock local data if a Team
              subscription ends.
            </p>
            <ul className="mb-8 space-y-2">
              {INDIVIDUAL.map((item) => (
                <li key={item} className="flex gap-3 text-sm text-muted-foreground">
                  <span className="mt-1.5 size-1.5 shrink-0 bg-trust-crew" />
                  {item}
                </li>
              ))}
            </ul>
            <div className="mt-auto flex flex-col gap-2">
              <Link href="/download" className="btn-primary w-full">
                Install the app
              </Link>
              <a
                href="https://github.com/Sweetdevil144/muon"
                className="btn-ghost flex w-full items-center justify-center gap-2"
              >
                <Github className="size-4" /> View the source
              </a>
            </div>
          </div>

          <div className="panel flex flex-col p-8">
            <p className="panel-label mb-3">Teams — Linked Operation</p>
            <div className="mb-3 font-sans text-3xl font-semibold tracking-[-0.03em]">
              Per named person, in conversation
            </div>
            <p className="mb-6 text-[0.9375rem] leading-relaxed text-muted-foreground">
              Teams starts at the moment two people&apos;s instances share memory, graphs, crews,
              claims, or findings — including if you host the link yourselves. You pay for named
              humans whose instances are allowed to link, not for agents, not for recalls, and not
              for a hosted repository. Until checkout ships, the price is a conversation, and we
              would rather have it honestly than print a number we cannot charge yet.
            </p>
            <ul className="mb-8 space-y-2">
              {TEAMS.map((item) => (
                <li key={item} className="flex gap-3 text-sm text-muted-foreground">
                  <span className="mt-1.5 size-1.5 shrink-0 bg-trust-human" />
                  {item}
                </li>
              ))}
            </ul>
            <Link href="/enterprise" className="mt-auto btn-ghost w-full">
              Start a Teams conversation
            </Link>
          </div>
        </div>

        <p className="mt-8 max-w-[80ch] text-sm leading-relaxed text-muted-foreground">
          A company-wide ledger with verified tenancy and stewards is a later conversation, opened
          from the same form. It is not for sale on this page.
        </p>
      </section>
    </SiteShell>
  );
}

export default PricingPage;
