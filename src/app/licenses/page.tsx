import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { PageIntro } from "@/components/marketing/page-intro";

export const metadata: Metadata = {
  title: "Licenses, MUON",
  description:
    "MUON's own license, and where to find the inventory of open-source components it includes.",
};

export default function LicensesPage() {
  return (
    <MarketingShell>
      <PageIntro
        eyebrow="Licenses"
        intro="MUON's own license, and where the open-source components it is built on are listed."
        title="MUON's license and third-party notices"
      />
      <section className="mx-auto max-w-5xl px-4 py-20 sm:px-6 sm:py-28">
        <div className="border-t-2 border-[var(--bauhaus-ink)]">
          <div className="grid gap-3 border-b-2 border-[var(--bauhaus-ink)] py-8 sm:grid-cols-[4rem_1fr] sm:gap-8 sm:py-10">
            <p className="text-sm font-black text-[var(--bauhaus-red)]">01</p>
            <div>
              <h2 className="text-xl font-black uppercase tracking-[-0.03em] sm:text-2xl">
                MUON&apos;s own license
              </h2>
              <p className="mt-4 max-w-3xl text-lg leading-8 text-black/60">
                MUON&apos;s source is licensed under the{" "}
                <strong>PolyForm Noncommercial License 1.0.0</strong>. In
                short, you can read, run, and modify the code for
                noncommercial purposes; commercial use requires a separate
                agreement with us. The full license text ships in the{" "}
                <code className="border border-black/20 bg-white px-1.5 py-0.5 font-mono text-[0.85em]">
                  LICENSE
                </code>{" "}
                file at the root of the repository, and that file is the
                controlling text if this page ever summarizes it
                imprecisely.
              </p>
            </div>
          </div>

          <div className="grid gap-3 border-b-2 border-[var(--bauhaus-ink)] py-8 sm:grid-cols-[4rem_1fr] sm:gap-8 sm:py-10">
            <p className="text-sm font-black text-[var(--bauhaus-red)]">02</p>
            <div>
              <h2 className="text-xl font-black uppercase tracking-[-0.03em] sm:text-2xl">
                What MUON includes
              </h2>
              <p className="mt-4 max-w-3xl text-lg leading-8 text-black/60">
                MUON is built on open-source software, hundreds of packages
                across its runtime, tooling, and this website, each under
                its own license. We do not reproduce that whole list on this
                page. Instead, an automatically generated inventory lives in
                the repository and is regenerated from the dependency
                lockfile, not hand-maintained, so it stays accurate.
              </p>
            </div>
          </div>

          <div className="grid gap-3 border-b-2 border-[var(--bauhaus-ink)] py-8 sm:grid-cols-[4rem_1fr] sm:gap-8 sm:py-10">
            <p className="text-sm font-black text-[var(--bauhaus-red)]">03</p>
            <div>
              <h2 className="text-xl font-black uppercase tracking-[-0.03em] sm:text-2xl">
                The canonical inventory
              </h2>
              <p className="mt-4 max-w-3xl text-lg leading-8 text-black/60">
                The full, current list of package names, versions, and
                license identifiers is in{" "}
                <code className="border border-black/20 bg-white px-1.5 py-0.5 font-mono text-[0.85em]">
                  docs/THIRD-PARTY-NOTICES.md
                </code>{" "}
                in the repository. It currently covers the production
                dependencies of this site&apos;s own workspace. The separate
                dependency trees under the app and backend packages are not
                folded into it yet. That file lists license identifiers
                only, not full license texts, consult each named
                package&apos;s own repository for that.
              </p>
            </div>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
