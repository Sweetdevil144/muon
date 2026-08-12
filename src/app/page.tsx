import Link from "next/link";
import { EarlyAccessForm } from "@/components/marketing/early-access-form";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { PresenceStage } from "@/components/marketing/presence-stage";
import {
  crewStack,
  homeStory,
  integrationStatus,
  operatingProof,
  surfaceProof,
} from "@/lib/marketing-content";

export default function Home() {
  return (
    <MarketingShell>
      <section className="bauhaus-grid border-b-2 border-[var(--bauhaus-ink)]">
        <div className="mx-auto grid min-h-[calc(100svh-4.75rem)] max-w-7xl gap-12 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-[0.92fr_1.08fr] lg:items-center">
          <div className="relative z-10">
            <p className="bauhaus-eyebrow">{homeStory.eyebrow}</p>
            <h1 className="mt-6 max-w-4xl text-balance text-5xl font-black uppercase leading-[0.88] tracking-[-0.06em] sm:text-7xl lg:text-[5.9rem]">
              {homeStory.title}
            </h1>
            <p className="mt-7 max-w-2xl text-pretty text-lg leading-8 text-black/65">
              {homeStory.intro}
            </p>
            <div className="mt-8 flex flex-wrap gap-2">
              {homeStory.proof.map((item, index) => (
                <span
                  className="inline-flex items-center gap-2 border-2 border-[var(--bauhaus-ink)] bg-white px-3 py-2 text-[0.68rem] font-black uppercase tracking-[0.1em]"
                  key={item}
                >
                  <span
                    className={`size-2 ${
                      index === 0
                        ? "rounded-full bg-[var(--bauhaus-red)]"
                        : index === 1
                          ? "bg-[var(--bauhaus-blue)]"
                          : "rounded-tl-full bg-[var(--bauhaus-yellow)]"
                    }`}
                  />
                  {item}
                </span>
              ))}
            </div>
            <div className="mt-10 max-w-2xl" id="early-access">
              <EarlyAccessForm />
              <div className="mt-4 flex flex-col gap-3 text-xs leading-5 text-black/50 sm:flex-row sm:items-center sm:justify-between">
                <p>
                  Free download. Bring the AI tools you already pay for.
                </p>
                <Link
                  className="shrink-0 font-black uppercase tracking-[0.12em] text-[var(--bauhaus-ink)] underline decoration-2 underline-offset-4"
                  href="/how-it-works"
                >
                  See how it works
                </Link>
              </div>
            </div>
          </div>
          <PresenceStage />
        </div>
      </section>

      <section className="border-b-2 border-[var(--bauhaus-ink)] bg-white">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-28">
          <div className="grid gap-8 lg:grid-cols-[0.34fr_1fr] lg:gap-16">
            <div>
              <p className="bauhaus-eyebrow">The coordination gap</p>
              <p className="mt-5 max-w-xs text-sm leading-6 text-black/50">
                More agents can mean more code. They also mean more briefings,
                handoffs, collisions, and review work for a person to manage.
              </p>
            </div>
            <h2 className="max-w-5xl text-balance text-4xl font-black uppercase leading-[0.98] tracking-[-0.05em] sm:text-6xl">
              {homeStory.explanation}
            </h2>
          </div>

          <div className="mt-16 grid border-2 border-[var(--bauhaus-ink)] lg:grid-cols-3">
            {homeStory.capabilities.map((capability, index) => (
              <article
                className={`min-h-80 p-7 sm:p-9 ${
                  index < homeStory.capabilities.length - 1
                    ? "border-b-2 border-[var(--bauhaus-ink)] lg:border-b-0 lg:border-r-2"
                    : ""
                }`}
                key={capability.title}
              >
                <span className="text-sm font-black text-[var(--bauhaus-blue)]">
                  {capability.index}
                </span>
                <h3 className="mt-16 text-2xl font-black uppercase leading-tight tracking-[-0.035em]">
                  {capability.title}
                </h3>
                <p className="mt-4 leading-7 text-black/60">
                  {capability.description}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-b-2 border-[var(--bauhaus-ink)] bg-[var(--bauhaus-ink)] text-white">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-28">
          <div className="grid gap-8 lg:grid-cols-[0.72fr_1fr] lg:items-end">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.2em] text-white/45">
                One mission, one coordinated crew
              </p>
              <h2 className="mt-6 text-balance text-4xl font-black uppercase leading-[0.96] tracking-[-0.05em] sm:text-6xl">
                How MUON runs the crew.
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-white/60">
              MUON turns a request into assigned work, keeps agents aware of
              the mission and each other, and returns one reviewable result to
              your team.
            </p>
          </div>

          <div className="mt-16 border-y border-white/25">
            {operatingProof.map((item) => (
              <article
                className="grid gap-5 border-b border-white/20 py-8 last:border-b-0 sm:grid-cols-[4rem_0.4fr_0.7fr_1fr] sm:items-start sm:gap-8"
                key={item.number}
              >
                <span className="font-mono text-sm font-black text-[var(--bauhaus-yellow)]">
                  {item.number}
                </span>
                <p className="text-xs font-black uppercase tracking-[0.16em] text-white/45">
                  {item.label}
                </p>
                <h3 className="text-xl font-black uppercase leading-tight tracking-[-0.025em]">
                  {item.title}
                </h3>
                <p className="leading-7 text-white/55">{item.description}</p>
              </article>
            ))}
          </div>
          <Link
            className="mt-10 inline-flex border-2 border-white bg-[var(--bauhaus-yellow)] px-5 py-4 text-sm font-black uppercase tracking-[0.1em] text-[var(--bauhaus-ink)] shadow-[6px_6px_0_var(--bauhaus-red)]"
            href="/how-it-works"
          >
            Follow the complete loop
          </Link>
        </div>
      </section>

      <section className="overflow-hidden border-b-2 border-[var(--bauhaus-ink)] bg-[var(--bauhaus-blue)] text-white">
        <div className="mx-auto grid max-w-7xl gap-12 px-4 py-20 sm:px-6 sm:py-28 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <div aria-hidden="true" className="bauhaus-orbit">
            <span className="bauhaus-orbit-center">
              <img
                alt=""
                className="bauhaus-orbit-mark"
                height={80}
                src="/logo.png"
                width={80}
              />
            </span>
            <span className="bauhaus-orbit-dot bauhaus-orbit-dot-a" />
            <span className="bauhaus-orbit-dot bauhaus-orbit-dot-b" />
            <span className="bauhaus-orbit-dot bauhaus-orbit-dot-c" />
          </div>
          <div>
            <p className="text-xs font-black uppercase tracking-[0.2em] text-white/65">
              Shared context without shared confusion
            </p>
            <h2 className="mt-6 text-balance text-4xl font-black uppercase leading-[0.95] tracking-[-0.05em] sm:text-6xl">
              Stop copying context between agent windows.
            </h2>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-white/72">
              Each agent keeps memory for its own job. MUON also shares what the
              crew already knows so people are not copy-pasting context between
              windows.
            </p>
            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              {[
                "Personal agent memory",
                "Shared crew memory",
                "You confirm lasting knowledge",
                "Stays on your machine",
              ].map((item) => (
                <span
                  className="border border-white/35 bg-white/10 px-4 py-3 text-sm font-bold"
                  key={item}
                >
                  {item}
                </span>
              ))}
            </div>
            <Link
              className="mt-9 inline-flex border-b-4 border-[var(--bauhaus-yellow)] pb-1 text-sm font-black uppercase tracking-[0.12em]"
              href="/product/shared-memory"
            >
              Explore shared memory
            </Link>
          </div>
        </div>
      </section>

      <section className="border-b-2 border-[var(--bauhaus-ink)] bg-white">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-28">
          <div className="grid gap-8 lg:grid-cols-[1fr_0.52fr] lg:items-end">
            <div>
              <p className="bauhaus-eyebrow">Use MUON where you work</p>
              <h2 className="mt-6 max-w-5xl text-balance text-4xl font-black uppercase leading-[0.98] tracking-[-0.05em] sm:text-6xl">
                One mission, wherever your team works.
              </h2>
            </div>
            <p className="text-lg leading-8 text-black/60">
              Move from the Desktop app to the terminal or a connected Claude or
              Codex chat without splitting jobs, approvals, or history.
            </p>
          </div>

          <div className="mt-16 grid border-2 border-[var(--bauhaus-ink)] lg:grid-cols-3">
            {surfaceProof.map((surface, index) => (
              <article
                className={`p-7 sm:p-9 ${
                  index < surfaceProof.length - 1
                    ? "border-b-2 border-[var(--bauhaus-ink)] lg:border-b-0 lg:border-r-2"
                    : ""
                }`}
                key={surface.name}
              >
                <div className="flex items-center justify-between gap-4">
                  <h3 className="text-3xl font-black uppercase tracking-[-0.04em]">
                    {surface.name}
                  </h3>
                  <span className="bg-[var(--bauhaus-yellow)] px-2 py-1 text-[0.62rem] font-black uppercase tracking-[0.1em]">
                    {surface.status}
                  </span>
                </div>
                <p className="mt-8 leading-7 text-black/60">
                  {surface.description}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-b-2 border-[var(--bauhaus-ink)] bg-[var(--bauhaus-paper)]">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-28">
          <div className="grid gap-8 lg:grid-cols-[0.65fr_1fr] lg:items-end">
            <div>
              <p className="bauhaus-eyebrow">A role for every tool</p>
              <h2 className="mt-6 text-balance text-4xl font-black uppercase leading-[0.98] tracking-[-0.05em] sm:text-6xl">
                MUON runs the crew. Each tool has a clear job.
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-black/60">
              Claude Code and Codex can build and lead. Cursor and OpenCode help
              explore and review. MUON keeps those differences honest instead of
              pretending every tool is the same.
            </p>
          </div>

          <div className="mt-10 flex flex-wrap gap-2">
            {crewStack.map((agent) => (
              <span
                className="border-2 border-[var(--bauhaus-ink)] bg-white px-3 py-2 text-[0.68rem] font-black uppercase tracking-[0.1em]"
                key={agent}
              >
                {agent}
              </span>
            ))}
          </div>

          <div className="mt-16 grid border-2 border-[var(--bauhaus-ink)] lg:grid-cols-2">
            {integrationStatus.map((integration, index) => (
              <article
                className={`grid gap-5 p-6 sm:grid-cols-[0.42fr_1fr] sm:p-8 ${
                  index < integrationStatus.length - 2
                    ? "border-b-2 border-[var(--bauhaus-ink)]"
                    : index === integrationStatus.length - 2
                      ? "border-b-2 border-[var(--bauhaus-ink)] lg:border-b-0"
                      : ""
                } ${index % 2 === 0 ? "lg:border-r-2 lg:border-[var(--bauhaus-ink)]" : ""}`}
                key={integration.name}
              >
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.14em] text-black/45">
                    {integration.category}
                  </p>
                  <h3 className="mt-3 text-2xl font-black uppercase tracking-[-0.03em]">
                    {integration.name}
                  </h3>
                  <span
                    className={`mt-4 inline-flex px-2 py-1 text-[0.64rem] font-black uppercase tracking-[0.1em] ${
                      integration.tone === "ready"
                        ? "bg-[var(--bauhaus-blue)] text-white"
                        : integration.tone === "limited"
                          ? "bg-[var(--bauhaus-yellow)]"
                          : "border border-black/30 bg-white"
                    }`}
                  >
                    {integration.status}
                  </span>
                </div>
                <p className="leading-7 text-black/60">{integration.detail}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-b-2 border-[var(--bauhaus-ink)] bg-white">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-28">
          <p className="bauhaus-eyebrow">Trust</p>
          <h2 className="mt-6 max-w-5xl text-balance text-4xl font-black uppercase leading-[0.98] tracking-[-0.05em] sm:text-6xl">
            More agent output without giving up control.
          </h2>
          <div className="mt-16 grid border-2 border-[var(--bauhaus-ink)] lg:grid-cols-3">
            {homeStory.trust.map((item, index) => (
              <article
                className={`p-7 sm:p-9 ${
                  index < homeStory.trust.length - 1
                    ? "border-b-2 border-[var(--bauhaus-ink)] lg:border-b-0 lg:border-r-2"
                    : ""
                }`}
                key={item.title}
              >
                <h3 className="text-2xl font-black uppercase leading-tight tracking-[-0.035em]">
                  {item.title}
                </h3>
                <p className="mt-4 leading-7 text-black/60">
                  {item.description}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-[var(--bauhaus-yellow)]">
        <div className="mx-auto flex max-w-7xl flex-col gap-8 px-4 py-16 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <h2 className="max-w-4xl text-4xl font-black uppercase leading-none tracking-[-0.05em] sm:text-5xl">
            {homeStory.closingCta}
          </h2>
          <Link
            className="inline-flex shrink-0 justify-center border-2 border-[var(--bauhaus-ink)] bg-[var(--bauhaus-red)] px-6 py-4 text-sm font-black uppercase tracking-[0.1em] text-white shadow-[6px_6px_0_var(--bauhaus-ink)]"
            href="/download"
          >
            Install the app
          </Link>
        </div>
      </section>
    </MarketingShell>
  );
}
