import type { Metadata } from "next";
import {
  Bullets,
  Callout,
  Code,
  CodeBlock,
  DocSection,
  DocsLayout,
  P,
} from "@/components/docs/DocsLayout";

const TITLE = "MCP server — use MUON from your own agent session";
const DESCRIPTION =
  "Register MUON's MCP server with Claude Code, Codex, Cursor or OpenCode and give any session you start the same shared, human-confirmed memory and code graph.";

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


const MODES = [
  {
    name: "base",
    flag: "default",
    body: "Context + coordination, 25 tools. What a plain install gets.",
  },
  {
    name: "observer",
    flag: "--mode observer",
    body: "Adds a bounded, read-only crew-status inventory (fleet, tasks, dispatch status, stream reads, budget, role bindings, approval checks) — never dispatch, steer, interrupt, ship, merge, approve or memory-confirm authority.",
  },
  {
    name: "coordinator seat",
    flag: "muon mcp attach",
    body: "Claude Code and Codex only. Mints a governed dispatch seat so a session you run yourself can create tasks, dispatch, steer, interrupt, ship and assign roles — under the same capped delegation manifest as any other coordinator.",
  },
];

function McpDoc() {
  return (
    <DocsLayout
      eyebrow="MCP server"
      title="Use MUON from a session you started yourself"
      intro="You don't have to drive MUON through the app. Register MUON's MCP server with your own agent CLI once, and every session you open in that terminal gets the same shared brain: the human-confirmed memory graph and the code graph over the repository you're standing in."
    >
      <DocSection title="Install it">
        <CodeBlock>{`muon mcp install claude      # or: codex | cursor | opencode
# restart the CLI, then inside it:
#   memory_preedit  → blast radius + prior decisions about a symbol
#   code_query      → find code by concept instead of grepping`}</CodeBlock>
        <P>
          <Code>install</Code> writes into that vendor's own MCP config — through the vendor's own
          writer where one exists (<Code>claude mcp add</Code>, <Code>codex mcp add</Code>). It's
          idempotent: run it again and if nothing changed, nothing is written.{" "}
          <Code>--dry-run</Code> prints exactly what would be written.{" "}
          <Code>muon mcp uninstall &lt;vendor&gt;</Code> removes exactly the entry MUON added.
        </P>
      </DocSection>

      <DocSection title="What it deliberately does not write">
        <Bullets
          items={[
            <>
              <strong className="text-foreground">No MUON token.</strong> The local brain re-mints
              its credentials on every boot, so a baked-in token would go stale. The session
              discovers a read/agent-tier credential from the brain's own <Code>0600</Code> lockfile
              instead.
            </>,
            <>
              <strong className="text-foreground">No API base.</strong> Setting one would switch off
              lockfile discovery and every call would fail. If you already export{" "}
              <Code>MUON_API_BASE</Code>, <Code>muon mcp status</Code> will tell you it's the reason
              something looks wrong.
            </>,
            <>
              <strong className="text-foreground">No mode or privilege flag, by default.</strong> An
              installed session holds agent tier, never operator tier. It cannot approve, confirm a
              memory note, or answer a gate.
            </>,
          ]}
        />
      </DocSection>

      <DocSection title="What the read tier exposes">
        <P>
          Every governed session — including one you attached by hand — gets the same 25-tool base:
          20 context tools plus 5 coordination tools. Nothing here can approve, dispatch or widen
          anything.
        </P>
        <div className="panel p-5">
          <p className="panel-label mb-3">Context (20 tools)</p>
          <p className="font-mono text-[0.8125rem] leading-relaxed text-muted-foreground">
            memory_search, memory_recall, memory_neighbors, memory_explain, memory_delete,
            memory_clone, memory_add, memory_preedit, impact_memory, preflight_edit, task_context,
            handoff_read, code_query, code_context, code_impact, repo_map, review_diff,
            data_boundaries, flow_scope, capability_preflight
          </p>
        </div>
        <P>
          The hero is <Code>memory_preedit</Code> / <Code>preflight_edit</Code>: code-graph blast
          radius fused with governed memory, prior decisions, live sibling activity and coverage
          evidence, at the edit boundary, in one read. Memory reads are workspace-partitioned and
          trust-gated — only human-confirmed memory reaches the strict gate view.
        </P>
        <div className="panel p-5">
          <p className="panel-label mb-3">Coordination (5 tools)</p>
          <p className="font-mono text-[0.8125rem] leading-relaxed text-muted-foreground">
            peer_message, peer_inbox, claim_files, release_files, crew_roles
          </p>
        </div>
        <P>
          Mission-bounded, horizontal and deliberately authority-free: a peer message is untrusted
          data to its reader, a file claim is advisory, and <Code>crew_roles</Code> is the read side
          of role assignment only.
        </P>
      </DocSection>

      <DocSection title="Observer and coordinator modes">
        <div className="grid grid-cols-1 gap-4">
          {MODES.map((mode) => (
            <div key={mode.name} className="panel p-5">
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <h3 className="font-sans text-base font-semibold">{mode.name}</h3>
                <span className="font-mono text-[0.75rem] text-muon-blue">{mode.flag}</span>
              </div>
              <p className="text-[0.9375rem] leading-[1.75] text-muted-foreground">{mode.body}</p>
            </div>
          ))}
        </div>
        <P>
          Cursor and OpenCode can be installed at base or observer, but neither can hold the
          coordinator seat — <Code>muon mcp status</Code> prints both booleans (installable vs.
          can-coordinate) per vendor so they're never conflated.
        </P>
      </DocSection>

      <DocSection title="One honest boundary">
        <Callout tone="warn" title="What MUON governs here">
          <P>
            MUON governs what an installed or attached session may do to your crew and to memory. It
            does not govern what that session does to your filesystem — your own agent's permission
            prompts do, and you are sitting there answering them. A human at the terminal answering
            a vendor's own prompts live is a stronger posture than an unattended agent, not a weaker
            one.
          </P>
        </Callout>
      </DocSection>

      <DocSection title="Check the status of an attach">
        <CodeBlock>{`muon mcp status     # tier, token source, binary path, per-vendor registration
muon doctor         # is each vendor CLI installed AND logged in`}</CodeBlock>
        <P>
          <Code>muon mcp status</Code> re-verifies everything on every run: whether a brain is
          running, which resolver branch supplies the bearer token, whether an exported{" "}
          <Code>MUON_API_BASE</Code> is silently suppressing lockfile discovery, and whether the
          recorded <Code>muon-mcp</Code> binary path still resolves. MUON never logs you in and never
          stores a vendor token.
        </P>
      </DocSection>
    </DocsLayout>
  );
}

export default McpDoc;
