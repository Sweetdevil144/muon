import type { Metadata } from "next";
import { GithubMark as Github } from "@/components/muon/BrandIcon";



import { SiteShell } from "@/components/muon/SiteShell";
import { PageHero, SectionHead } from "@/components/muon/PageHero";

const TITLE = "Download MUON — free macOS app, CLI and TUI";
const DESCRIPTION =
  "MUON ships as a free macOS app for Apple silicon, plus a one-line CLI and terminal UI install. Bring your own Claude Code, Codex, Cursor or OpenCode account.";

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


const REQUIREMENTS = [
  "A Mac with Apple silicon (M-series). Intel support is a follow-up.",
  "git installed (macOS ships it with the developer tools).",
  "At least one AI coding tool installed and signed in with your own account: Claude Code, Codex, Cursor or OpenCode.",
];

function DownloadPage() {
  return (
    <SiteShell>
      <PageHero
        eyebrow="Download"
        title="MUON is a free download."
        intro="MUON ships as a free macOS app for one person's use under the Individual Use Grant. The first public build is unsigned while distribution is finalized, so installing takes one extra click — and this page shows exactly which one. If you arrived expecting a team SKU: linking people's instances is priced on the pricing page, in conversation."
        cta={{ label: "Read the security posture", to: "/security" }}
      />

      <a
        href="https://github.com/Sweetdevil144/muon"
        className="mb-8 flex w-fit items-center gap-2 border-b border-transparent text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <Github className="size-4" /> Source on GitHub
      </a>

      <section className="border-b border-border py-20 lg:py-28">
        <div className="grid grid-cols-12 gap-4">
          <div className="panel col-span-12 p-8 lg:col-span-7">
            <p className="panel-label mb-3">Installing</p>
            <h2 className="mb-3 font-sans text-[1.75rem] font-semibold tracking-[-0.02em]">
              Three steps, one extra click
            </h2>
            <p className="mb-6 text-[0.9375rem] leading-relaxed text-muted-foreground">
              Download the .dmg, drag MUON to Applications, and on first launch right-click the app
              and choose Open.
            </p>
            <div className="flex flex-wrap gap-3">
              <a
                href="https://download.getmuon.com/MUON-latest-arm64.dmg"
                className="btn-primary"
              >
                Download for macOS (Apple silicon)
              </a>
              <a href="https://download.getmuon.com/SHA256SUMS" className="btn-ghost">
                Verify checksums
              </a>
            </div>
            <ol className="mt-6 space-y-2 font-mono text-xs text-muted-foreground">
              <li>1. Download MUON-&lt;version&gt;-arm64.dmg</li>
              <li>2. Drag MUON into /Applications</li>
              <li>3. First launch: right-click MUON.app → Open → Open</li>
            </ol>
          </div>

          <div className="panel col-span-12 p-8 lg:col-span-5">
            <p className="panel-label mb-3">Terminal people</p>
            <h2 className="mb-3 font-sans text-[1.75rem] font-semibold tracking-[-0.02em]">
              The CLI and TUI install in one line
            </h2>
            <pre className="mb-4 overflow-x-auto border border-border bg-foreground/5 p-4 font-mono text-xs text-trust-crew">
              curl -fsSL https://getmuon.com/install.sh | bash
            </pre>
            <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">
              Installs <span className="font-mono text-foreground">muon</span> (the CLI) and{" "}
              <span className="font-mono text-foreground">muon-tui</span> (the full-screen terminal
              cockpit) on macOS and Linux. Requires Node 20+. Full guides live at{" "}
              <a href="https://docs.getmuon.com" className="text-trust-human underline">
                docs.getmuon.com
              </a>
              .
            </p>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28">
        <SectionHead
          eyebrow="Requirements"
          title="What you need before the first mission."
          note="MUON does not ship or sell an AI coding account. You bring your own, and MUON drives your installed copy of each tool."
        />
        <ul className="panel divide-y divide-border">
          {REQUIREMENTS.map((req) => (
            <li key={req} className="p-5 text-[0.9375rem] leading-relaxed text-muted-foreground">
              {req}
            </li>
          ))}
        </ul>
      </section>
    </SiteShell>
  );
}

export default DownloadPage;
