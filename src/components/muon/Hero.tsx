import { GithubMark as Github } from "./BrandIcon";
import Link from "next/link";
import { Check } from "lucide-react";

import { MissionRun } from "./MissionRun";

// The proof line is one sentence of facts, not a pill list (appendix §4):
// name the tools, name the roles, name what the visitor keeps.
const PROOF = [
  "Claude Code and Codex build and lead",
  "Cursor and OpenCode explore and review",
  "You keep the accounts you already pay for",
];

export function Hero() {
  return (
    <section className="py-12 lg:py-20">
      <div className="grid grid-cols-12 gap-8">
        <div className="col-span-12 lg:col-span-5">
          <p className="panel-label mb-4">
            A local control plane for the coding agents you already use
          </p>
          <h1 className="mb-5 font-sans text-4xl font-semibold leading-[1.08] tracking-[-0.03em] lg:text-[3.25rem]">
            One person&apos;s agents, one desk, one memory you confirm.
          </h1>
          <p className="prose-body mb-7 max-w-[52ch] text-base lg:text-lg">
            MUON sits on your machine and runs the crew around Claude Code, Codex, Cursor and
            OpenCode. You give it a mission. It plans the work, keeps a shared memory the agents
            cannot silently rewrite, and brings the merge back to you. It is not another model, and
            it does not need your repository in someone else&apos;s cloud.
          </p>

          <div className="mb-4 flex flex-wrap gap-3">
            <Link href="/download" className="btn-primary">
              Install the app
            </Link>
            <Link href="/how-it-works" className="btn-ghost">
              See how it works
            </Link>
            <a
              href="https://github.com/Sweetdevil144/muon"
              aria-label="MUON on GitHub"
              className="btn-ghost px-3"
            >
              <Github className="size-4" />
            </a>
          </div>

          <div className="mb-7 overflow-x-auto border border-border bg-foreground/5 px-4 py-3 font-mono text-xs text-trust-crew">
            curl -fsSL https://getmuon.com/install.sh | bash
          </div>

          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            {PROOF.map((item) => (
              <li key={item} className="flex items-center gap-2 text-sm text-muted-foreground">
                <Check className="size-3.5 text-trust-crew" />
                {item}
              </li>
            ))}
          </ul>

        </div>

        <div className="col-span-12 lg:col-span-7">
          <MissionRun variant="compact" />
        </div>
      </div>
    </section>
  );
}
