import type { Metadata } from "next";
import Link from "next/link";

import { SiteShell } from "@/components/muon/SiteShell";
import { PageHero } from "@/components/muon/PageHero";

const TITLE = "FAQ — answers before you evaluate MUON";
const DESCRIPTION =
  "What MUON is, which AI coding tools it works with, how people stay in control, where data lives, and what the free download includes.";

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


const QA = [
  {
    q: "What is MUON?",
    a: "MUON is the layer that turns your AI coding tools into one crew. You give it a mission. It plans the work, keeps agents aligned, and brings you back when a real decision is needed.",
  },
  {
    q: "Is MUON another coding agent?",
    a: "No. Claude Code, Codex, Cursor and OpenCode still do the coding. MUON runs the team around them so your people are not stuck coordinating by hand.",
  },
  {
    q: "Which tools does MUON work with?",
    a: "Claude Code and Codex build and lead. Cursor and OpenCode explore and review. MUON puts every tool in its strongest position.",
  },
  {
    q: "Do I stay in control?",
    a: "Yes. Shipping, merges and other high-impact steps wait for a person unless you explicitly grant standing consent with Full Auto. Every decision is recorded, and you can pause, redirect or take over at any time.",
  },
  {
    q: "Will agents change my main project without asking?",
    a: "No. Agent work happens in safe copies. Your main project stays clean until someone reviews the result and approves the merge.",
  },
  {
    q: "Can one AI review another AI's work?",
    a: "Yes. MUON can send the finished work to a different tool for a second look, then route the findings back without you playing messenger.",
  },
  {
    q: "Where does my data live?",
    a: "On your machine by default. MUON is built so the core engineering loop does not require a cloud control plane.",
  },
  {
    q: "Does MUON take my AI login credentials?",
    a: "No. You sign into Claude, Codex, Cursor and OpenCode the same way you already do. MUON checks readiness without storing those secrets.",
  },
  {
    q: "Where can I use MUON?",
    a: "In the Desktop app, from the terminal, or by connecting Claude Code or Codex from a chat you start yourself. Same mission, same approvals, same history.",
  },
  {
    q: "Is MUON open source?",
    a: "Not in the OSI sense, and we would rather say that plainly. The source is public at github.com/Sweetdevil144/muon under PolyForm Noncommercial 1.0.0 plus an Individual Use Grant: one person can read the code, build it, and run it free, including for work they do for an employer. Linked Operation — instances coordinating across people — is reserved and licensed separately. The licenses page and the grant in the repository are the controlling texts.",
  },
  {
    q: "What is Linked Operation?",
    a: "Two or more people's MUON instances sharing, syncing, or coordinating memory, code graphs, crews, claims, or findings — by any means, including something you host yourselves. One person on their own devices is Individual use and always free; the moment it becomes a shared brain across people, it is Linked Operation and needs a commercial licence.",
  },
  {
    q: "Can my whole company use the free download?",
    a: "Yes — each person, independently. Ten engineers can each install MUON on their own machines under the Individual Use Grant, employer laptops included. The organisation does not receive a licence by aggregation: what needs a licence is linking those instances together, not the number of people who happen to use MUON alone.",
  },
  {
    q: "Is MUON available today?",
    a: "Yes. There is a free macOS download for Apple silicon plus a one-line terminal install for the CLI and TUI. Early public builds may be unsigned, so the first launch needs a right-click and Open.",
  },
  {
    q: "How much does MUON cost?",
    a: "Individual is free forever — no card, no meter on memory or agents. Teams is Linked Operation, priced per named linked person; we are taking conversations rather than publishing a number, and starting one costs you a form and thirty minutes. Your AI tool subscriptions and usage stay separate either way.",
  },
];

function FaqPage() {
  return (
    <SiteShell>
      <PageHero
        eyebrow="FAQ"
        title="Answers before you evaluate"
        intro="Straight answers about what MUON is, which tools it works with, how people stay in control, and what to expect from the free download."
        cta={{ label: "Explore the product", to: "/product" }}
      />

      <section className="py-20 lg:py-28">
        <div className="panel divide-y divide-border">
          {QA.map((item, i) => (
            <details key={item.q} className="group p-6">
              <summary className="flex cursor-pointer list-none items-start gap-4">
                <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="font-sans text-lg font-semibold tracking-[-0.01em]">{item.q}</span>
                <span className="ml-auto font-mono text-muted-foreground group-open:hidden">+</span>
                <span className="ml-auto hidden font-mono text-muted-foreground group-open:inline">
                  −
                </span>
              </summary>
              <p className="mt-3 max-w-[80ch] pl-10 text-[0.9375rem] leading-relaxed text-muted-foreground">
                {item.a}
              </p>
            </details>
          ))}
        </div>

        <div className="panel mt-10 flex flex-col items-start justify-between gap-6 p-8 lg:flex-row lg:items-center">
          <h2 className="font-sans text-[1.75rem] font-semibold tracking-[-0.02em]">
            Still deciding if MUON fits your workflow?
          </h2>
          <Link href="/download" className="btn-primary">
            Install the app
          </Link>
        </div>
      </section>
    </SiteShell>
  );
}

export default FaqPage;
