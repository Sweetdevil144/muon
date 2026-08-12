import type { Metadata } from "next";
import { EnterpriseContactForm } from "@/components/marketing/enterprise-contact-form";
import { MarketingShell } from "@/components/marketing/marketing-shell";

export const metadata: Metadata = {
  title: "Enterprise, MUON",
  description:
    "Evaluate MUON as the central control layer for engineering teams using multiple coding agents.",
};

export default function EnterprisePage() {
  return (
    <MarketingShell>
      <section className="bauhaus-grid border-b-2 border-[var(--bauhaus-ink)]">
        <div className="mx-auto grid max-w-7xl gap-12 px-4 py-20 sm:px-6 sm:py-28 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
          <div>
            <p className="bauhaus-eyebrow">Enterprise</p>
            <h1 className="mt-6 text-balance text-5xl font-black uppercase leading-[0.9] tracking-[-0.055em] sm:text-7xl">
              Scale agent work without scaling coordination overhead
            </h1>
            <p className="mt-6 max-w-2xl text-pretty text-lg leading-8 text-black/65">
              MUON is for teams that already use AI coding tools and need one
              accountable way to assign work, keep agents aligned, and review
              what actually ships.
            </p>

            <div className="mt-10 border-y-2 border-[var(--bauhaus-ink)]">
              {[
                {
                  title: "Strong fit",
                  copy:
                    "Engineering teams trying multi-agent delivery, review-heavy workflows, or environments where local custody and auditability matter.",
                },
                {
                  title: "How teams start",
                  copy:
                    "Desktop is free for individuals. Team pricing is discussed here. Claude Code and Codex can build and lead. Cursor and OpenCode help explore and review.",
                },
                {
                  title: "Honest tool roles",
                  copy:
                    "MUON assigns every AI tool the work it is best at. People keep approval for sensitive actions and shipping.",
                },
              ].map((item) => (
                <div
                  className="grid gap-2 border-b border-black/25 py-5 last:border-b-0 sm:grid-cols-[0.32fr_1fr]"
                  key={item.title}
                >
                  <h2 className="text-sm font-black uppercase tracking-[0.1em]">
                    {item.title}
                  </h2>
                  <p className="text-sm leading-6 text-black/60">{item.copy}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="border-2 border-[var(--bauhaus-ink)] bg-white p-6 shadow-[10px_10px_0_var(--bauhaus-ink)] sm:p-10">
            <p className="bauhaus-eyebrow">Start a technical fit conversation</p>
            <p className="mt-4 mb-8 max-w-2xl leading-7 text-black/60">
              Tell us how your team uses coding agents today, where
              coordination or review breaks down, and which security or
              deployment constraints matter most.
            </p>
            <EnterpriseContactForm />
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
