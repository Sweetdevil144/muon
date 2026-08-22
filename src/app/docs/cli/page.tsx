import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import {
  Callout,
  Code,
  DocSection,
  DocsLayout,
  P,
} from "@/components/docs/DocsLayout";

const TITLE = "muon CLI reference — chat, dispatch, fleet, memory, mcp";
const DESCRIPTION =
  "Every command in the muon CLI: chat with the orchestrator, control dispatch, resize the fleet, govern memory, register the MCP server, and run diagnostics.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
  },
};


function Cmd({ sig, children }: { sig: string; children: ReactNode }) {
  return (
    <div className="panel p-5">
      <p className="mb-2 break-words font-mono text-[0.8125rem] text-foreground">{sig}</p>
      <div className="text-[0.9375rem] leading-[1.75] text-muted-foreground">{children}</div>
    </div>
  );
}

function CliDoc() {
  return (
    <DocsLayout
      eyebrow="Reference"
      title="The muon CLI"
      intro="Everything the desktop app and TUI do is reachable from muon. The CLI auto-starts the embedded local brain on first use — there is nothing to boot by hand. Run muon <command> --help for the full, current option list."
    >
      <Callout title="Global flags">
        <P>
          <Code>--api-base &lt;url&gt;</Code> overrides the local brain's API base;{" "}
          <Code>--api-token &lt;token&gt;</Code> (or <Code>MUON_API_TOKEN</Code>) supplies a bearer
          token. Leave both unset for the normal local flow — the CLI discovers a running brain
          itself, or spawns one.
        </P>
      </Callout>

      <DocSection title="Chat with the orchestrator">
        <Cmd sig="muon chat [--workspace <dir>] [--chat-id <id>] [--message <text>] [--model <id>]">
          Talk to the super-orchestrator: it plans, dispatches the fleet and reports — gates stay
          yours. With no <Code>--message</Code> it opens an interactive REPL (<Code>/quit</Code> to
          exit); with one it sends and exits, so it scripts cleanly. <Code>--archive</Code>{" "}
          soft-archives the chat (history and audit trail survive); <Code>--cancel</Code> stops every
          queued or running job in the chat.
        </Cmd>
      </DocSection>

      <DocSection title="Dispatch control">
        <div className="space-y-4">
          <Cmd sig="muon dispatch status [--job-id <id>] [--chat-id <id>] [--json]">
            One job's status plus its crew budget, or the list of active jobs.
          </Cmd>
          <Cmd sig="muon dispatch interrupt --job-id <id>">
            The crew's kill switch — interrupt one running job without killing the runner.
          </Cmd>
          <Cmd sig="muon dispatch steer --job-id <id> --message <text>">
            Send a steer message to a running dispatched job.
          </Cmd>
          <Cmd sig="muon dispatch raise --job-id <id> --pool-ms <ms>">
            Raise a mission's descendant wall-clock pool — the operator's recourse when a crew
            exhausts its budget.
          </Cmd>
        </div>
      </DocSection>

      <DocSection title="Fleet and agents">
        <div className="space-y-4">
          <Cmd sig="muon agents [--json] [--refresh]">
            Discovery table: name, vendor handle, stable id, readiness — then the exact next command
            for the first actionable row.
          </Cmd>
          <Cmd sig="muon fleet [--json]">
            Current fleet counts per vendor and each agent's live status.
          </Cmd>
          <Cmd sig="muon fleet set --claude-code <n> --codex <n> --cursor <n> --opencode <n>">
            Resize the fleet per vendor, 0–3 instances each. A resize never kills a working agent.
          </Cmd>
          <Cmd sig="muon fleet agents [--json]">List fleet agent instances with live status.</Cmd>
        </div>
      </DocSection>

      <DocSection title="Memory">
        <P>
          Decisions, constraints, conventions, attempts and questions — every read is fenced to the
          invoking workspace by default (<Code>--workspace &lt;path&gt;</Code> to target another).
        </P>
        <div className="space-y-4">
          <Cmd sig="muon memory add --kind <decision|constraint|convention|attempt|question> --text <text>">
            Add a note, optionally anchored with <Code>--task-id</Code>, <Code>--lane-id</Code>,{" "}
            <Code>--module</Code>, <Code>--symbol</Code> or <Code>--topic</Code>.
          </Cmd>
          <Cmd sig="muon memory search <query...> [--filter <json>]">
            Lexical search over notes in the fenced workspace.
          </Cmd>
          <Cmd sig="muon memory library [--q] [--status] [--confirmed] [--kind] [--trust]">
            Browse the governed memory library with filters.
          </Cmd>
          <Cmd sig="muon memory recall [--task-id] [--lane-id] [--module] [--topic]">
            Recall notes by task, lane, module or topic.
          </Cmd>
          <Cmd sig="muon memory review [--auto] [--from-pack]">
            The review queue: notes still unvouched and awaiting a human confirm or reject.
          </Cmd>
          <Cmd sig="muon memory confirm --note-id <id>  /  muon memory reject --note-id <id>">
            Operator-only governance acts — mark a note human-confirmed, or reject it (kept for
            traceability, hidden from recall).
          </Cmd>
          <Cmd sig="muon memory pack export --out <dir> | import <store> | sync <store>">
            Team memory sync over plain files — no MUON cloud. Import stages a teammate's pack as
            unconfirmed proposals in your review queue. Operator-tier only.
          </Cmd>
        </div>
      </DocSection>

      <DocSection title="MCP server registration">
        <div className="space-y-4">
          <Cmd sig="muon mcp install <claude|codex|cursor|opencode> [--scope user|project] [--mode observer] [--dry-run]">
            Register MUON's MCP server with your own CLI's config. See the{" "}
            <Link href="/docs/mcp" className="text-foreground underline underline-offset-4">
              MCP page
            </Link>{" "}
            for what it does and does not grant.
          </Cmd>
          <Cmd sig="muon mcp status [--scope <scope>] [--json]">
            Explain the tier a hand-started session would get, and every reason it could be wrong.
          </Cmd>
          <Cmd sig="muon mcp uninstall <vendor>">
            Remove exactly the entry MUON wrote; every other server and key stays untouched.
          </Cmd>
          <Cmd sig="muon mcp attach <claude|codex>  /  muon mcp detach <vendor>">
            Mint (or revoke) a governed dispatch seat for a coordinator CLI you run yourself — Claude
            Code and Codex only.
          </Cmd>
        </div>
      </DocSection>

      <DocSection title="Diagnostics and lifecycle">
        <div className="space-y-4">
          <Cmd sig="muon doctor [--json]">
            Backend connectivity and lane health. Never rejects — every unreadable source degrades to
            an honest “unknown” with a reason.
          </Cmd>
          <Cmd sig="muon version">
            App version, the indexed code-graph commit, the workspace's actual HEAD, and whether the
            two disagree (a stale index).
          </Cmd>
          <Cmd sig="muon onboard">
            Guided first run: per-vendor installed/authenticated readiness plus the exact fix for any
            gap.
          </Cmd>
          <Cmd sig="muon quickstart [--workspace <dir>]">
            Seed and dispatch a tiny, safe, additive sample task.
          </Cmd>
          <Cmd sig="muon context <target> [--view-proposal <noteId>]">
            The pre-edit gate for the terminal: blast-radius fused with governed memory, prior
            decisions, live cross-agent activity and pending proposals.
          </Cmd>
          <Cmd sig="muon approve list | review --approval-id <id> | resolve --approval-id <id> --status approved|rejected">
            The approval queue from the terminal, including the exact artifact digest and REVIEW
            BLIND file list for merge gates.
          </Cmd>
          <Cmd sig="muon shutdown">
            Stop the persistent local brain and runner that CLI commands auto-start.
          </Cmd>
        </div>
      </DocSection>
    </DocsLayout>
  );
}

export default CliDoc;
