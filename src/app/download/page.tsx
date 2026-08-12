import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { PageIntro } from "@/components/marketing/page-intro";

export const metadata: Metadata = {
  title: "Download, MUON",
  description:
    "How to run MUON today, and what the signed macOS download will look like once it ships.",
};

const requirements = [
  "A Mac with Apple silicon (M-series). Intel support is a follow-up.",
  "git installed (macOS ships it with the developer tools).",
  "At least one AI coding tool installed and signed in with your own account: Claude Code, Codex, Cursor, or OpenCode.",
] as const;

const comingSteps = [
  {
    title: "Developer-ID signed and notarized",
    copy:
      "The .dmg will carry Apple's Developer ID signature and pass notarization, so macOS Gatekeeper opens it without a right-click workaround.",
  },
  {
    title: "A published checksum",
    copy:
      "Every release will list its SHA-256 checksum next to the download link, so you can verify the file you got matches the one we built.",
  },
  {
    title: "One installer, no package managers",
    copy:
      "curl -fsSL https://getmuon.com/install.sh | bash installs the CLI and TUI on macOS and Linux. There is no Homebrew tap or apt repo to drift out of step with a release — one code path, one thing to verify.",
  },
] as const;

export default function DownloadPage() {
  return (
    <MarketingShell>
      <PageIntro
        action={{ label: "Read the security posture", href: "/security" }}
        eyebrow="Download"
        intro="MUON ships as a free macOS app. The first public build is unsigned while distribution is finalized, so installing takes one extra click, and this page shows exactly which one."
        title="MUON is a free download."
      />

      <section className="mx-auto max-w-5xl px-4 py-20 sm:px-6 sm:py-28">
        <p className="bauhaus-eyebrow">Installing</p>
        <h2 className="mt-4 max-w-3xl text-3xl font-black uppercase leading-tight tracking-[-0.04em] sm:text-4xl">
          Three steps, one extra click
        </h2>
        <p className="mt-4 max-w-2xl text-lg leading-8 text-black/60">
          Download the .dmg, drag MUON to Applications, and on first launch
          right-click the app and choose Open — that is the whole unsigned
          ceremony.
        </p>

        <div className="mt-8">
          <a
            className="inline-block border-2 border-[var(--bauhaus-ink)] bg-[var(--bauhaus-blue)] px-8 py-5 text-sm font-black uppercase tracking-[0.1em] text-white shadow-[6px_6px_0_var(--bauhaus-ink)]"
            href="https://download.getmuon.com/MUON-latest-arm64.dmg"
          >
            Download for macOS (Apple silicon)
          </a>
        </div>

        <pre className="mt-8 overflow-x-auto border-2 border-[var(--bauhaus-ink)] bg-white px-5 py-4 font-mono text-sm leading-7 text-[var(--bauhaus-ink)]">
          <code>{`1. Download MUON-<version>-arm64.dmg
2. Drag MUON into /Applications
3. First launch: right-click MUON.app -> Open -> Open`}</code>
        </pre>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-black/55">
          macOS shows the unidentified-developer prompt exactly once. Every
          artifact publishes its SHA-256 in{" "}
          <a
            className="underline underline-offset-4"
            href="https://download.getmuon.com/SHA256SUMS"
          >
            SHA256SUMS
          </a>{" "}
          so you can verify the file before you open it. The{" "}
          <Link className="underline underline-offset-4" href="/#early-access">
            early-access list
          </Link>{" "}
          is where new releases are announced first.
        </p>

        <div className="mt-14 border-t-2 border-[var(--bauhaus-ink)] pt-10">
          <p className="bauhaus-eyebrow">Terminal people</p>
          <h3 className="mt-4 text-2xl font-black uppercase tracking-[-0.03em]">
            The CLI and TUI install in one line
          </h3>
          <pre className="mt-6 overflow-x-auto border-2 border-[var(--bauhaus-ink)] bg-[var(--bauhaus-ink)] px-5 py-4 font-mono text-sm leading-7 text-white">
            <code>{`curl -fsSL https://getmuon.com/install.sh | bash

# macOS and Linux. Node.js 20+ required; nothing else is installed.`}</code>
          </pre>
          <p className="mt-4 max-w-2xl text-sm leading-7 text-black/55">
            That installs <code>muon</code> (the CLI — it starts its own local
            brain, no server to run) and <code>muon-tui</code> (the full-screen
            terminal cockpit). Requires Node 20+. Full guides live at{" "}
            <a
              className="underline underline-offset-4"
              href="https://docs.getmuon.com"
            >
              docs.getmuon.com
            </a>
            .
          </p>
        </div>

        <div className="mt-14 border-t-2 border-[var(--bauhaus-ink)] pt-10">
          <p className="bauhaus-eyebrow">Requirements</p>
          <ul className="mt-6 grid gap-4 sm:grid-cols-3">
            {requirements.map((requirement) => (
              <li
                className="border-2 border-[var(--bauhaus-ink)] bg-[var(--bauhaus-paper)] p-5 text-sm font-bold leading-6"
                key={requirement}
              >
                {requirement}
              </li>
            ))}
          </ul>
          <p className="mt-6 max-w-2xl text-sm leading-7 text-black/55">
            MUON does not ship or sell a Claude Code, Codex, Cursor, or
            OpenCode account. You bring your own account for whichever tools
            you already use, and MUON drives your own installed copy of each
            one.
          </p>
        </div>
      </section>

      <section className="border-t-2 border-[var(--bauhaus-ink)] bg-[var(--bauhaus-ink)] text-white">
        <div className="mx-auto max-w-5xl px-4 py-20 sm:px-6 sm:py-28">
          <p className="inline-block bg-[var(--bauhaus-yellow)] px-3 py-1 text-xs font-black uppercase tracking-[0.14em] text-[var(--bauhaus-ink)]">
            Coming with launch
          </p>
          <h2 className="mt-6 max-w-3xl text-3xl font-black uppercase leading-tight tracking-[-0.04em] sm:text-4xl">
            The signed build comes next
          </h2>
          <p className="mt-4 max-w-2xl text-lg leading-8 text-white/65">
            Signing and notarization are already wired into the release
            pipeline and switch on the moment the Developer ID lands — the
            same build, minus the extra click. We will not link a placeholder
            download or a fake checksum in the meantime.
          </p>
          <div className="mt-10 grid gap-6 sm:grid-cols-3">
            {comingSteps.map((step) => (
              <div className="border-2 border-white/25 p-5" key={step.title}>
                <h3 className="text-lg font-black uppercase tracking-[-0.02em]">
                  {step.title}
                </h3>
                <p className="mt-3 text-sm leading-6 text-white/65">
                  {step.copy}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
        <div className="flex flex-col gap-6 bg-[var(--bauhaus-paper)] p-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-xl text-lg font-bold leading-7">
            Read what MUON does and does not collect before you install it.
          </p>
          <div className="flex shrink-0 flex-wrap gap-3">
            <Link
              className="border-2 border-[var(--bauhaus-ink)] bg-white px-5 py-4 text-center text-sm font-black uppercase tracking-[0.1em]"
              href="/privacy"
            >
              Privacy
            </Link>
            <Link
              className="border-2 border-[var(--bauhaus-ink)] bg-[var(--bauhaus-ink)] px-5 py-4 text-center text-sm font-black uppercase tracking-[0.1em] text-white"
              href="/terms"
            >
              Terms
            </Link>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
