import Link from "next/link";
export const metadata = {
  title: "MCP server",
  description:
    "Attach MUON's governed brain to a coding-agent session you launch yourself.",
};

export default function McpPage() {
  return (
    <>
      <p className="eyebrow">MCP server</p>
      <h1>Use MUON from a session you started yourself</h1>
      <p className="lead">
        You don&apos;t have to drive MUON through the app. Register
        MUON&apos;s MCP server with your own agent CLI once, and every
        session <strong>you</strong> open in that terminal gets the same
        shared brain: the human-confirmed memory graph and the code graph
        over the repository you&apos;re standing in.
      </p>

      <pre>
        <code>{`muon mcp install claude      # or: codex | cursor | opencode
# restart the CLI, then inside it:
#   memory_preedit  → blast radius + prior decisions recorded about a symbol
#   code_query      → find code by concept instead of grepping`}</code>
      </pre>

      <p>
        <code>install</code> writes into that vendor&apos;s own MCP config —
        through the vendor&apos;s own writer where one exists (
        <code>claude mcp add</code>, <code>codex mcp add</code>). It&apos;s
        idempotent: run it again and if nothing changed, nothing is written.{" "}
        <code>--dry-run</code> prints exactly what would be written without
        writing it. <code>muon mcp uninstall &lt;vendor&gt;</code> removes
        exactly the entry MUON added and leaves every other server and key in
        that file untouched.
      </p>

      <h2>What it deliberately does not write</h2>
      <ul>
        <li>
          <strong>No MUON token.</strong> The local brain re-mints its
          credentials on every boot, so a token baked into a config file
          would go stale by the next restart. The session discovers a
          read/agent-tier credential from the brain&apos;s own{" "}
          <code>0600</code> lockfile instead.
        </li>
        <li>
          <strong>No API base.</strong> Setting one would switch off that
          lockfile discovery, and the session would fail every call. If you
          already export <code>MUON_API_BASE</code> in your shell for
          something else, <code>muon mcp status</code> will tell you it&apos;s
          the reason something looks wrong.
        </li>
        <li>
          <strong>No mode or privilege flag, by default.</strong> An
          installed session holds <strong>agent tier</strong>, never operator
          tier. It cannot approve, confirm a memory note, or answer a gate.
          Memory it adds is an unconfirmed proposal until you confirm it on a
          MUON surface.
        </li>
      </ul>

      <h2>What the read tier exposes</h2>
      <p>
        Every governed session — including one you attached by hand — gets
        the same 25-tool base: 20 <strong>context</strong> tools plus 5{" "}
        <strong>coordination</strong> tools. Nothing here can approve,
        dispatch, or widen anything.
      </p>

      <h3>Context (20 tools)</h3>
      <p>
        <code>memory_search</code>, <code>memory_recall</code>,{" "}
        <code>memory_neighbors</code>, <code>memory_explain</code>,{" "}
        <code>memory_delete</code>, <code>memory_clone</code>,{" "}
        <code>memory_add</code>, <code>memory_preedit</code>,{" "}
        <code>impact_memory</code>, <code>preflight_edit</code>,{" "}
        <code>task_context</code>, <code>handoff_read</code>,{" "}
        <code>code_query</code>, <code>code_context</code>,{" "}
        <code>code_impact</code>, <code>repo_map</code>,{" "}
        <code>review_diff</code>, <code>data_boundaries</code>,{" "}
        <code>flow_scope</code>, <code>capability_preflight</code>.
      </p>
      <p>
        The hero is <code>memory_preedit</code>/<code>preflight_edit</code>:
        code-graph blast radius fused with governed memory, prior decisions,
        live sibling activity, and coverage evidence, at the edit boundary,
        in one read. Memory reads are workspace-partitioned and trust-gated —
        only human-confirmed memory reaches the strict gate view.{" "}
        <code>memory_delete</code> is governed by handle-scoped identity and
        ledger authorization; it is not a free delete.
      </p>

      <h3>Coordination (5 tools)</h3>
      <p>
        <code>peer_message</code>, <code>peer_inbox</code>,{" "}
        <code>claim_files</code>, <code>release_files</code>,{" "}
        <code>crew_roles</code>. Mission-bounded, horizontal, and
        deliberately authority-free: a peer message is untrusted data to its
        reader, a file claim is advisory, and <code>crew_roles</code> is the
        read side of role assignment only.
      </p>

      <h2>Observer and coordinator modes</h2>
      <div className="tier-grid">
        <div className="tier-card">
          <span className="tier-name">base (default)</span>
          <p>Context + coordination, 25 tools. What a plain install gets.</p>
        </div>
        <div className="tier-card">
          <span className="tier-name">
            observer <span className="pill">--mode observer</span>
          </span>
          <p>
            Adds a bounded, read-only crew-status inventory (fleet status,
            task list, dispatch status, stream reads, budget, workflow
            status, role bindings, approval checks) — never dispatch, steer,
            interrupt, ship, merge, approve, or memory-confirm authority.
          </p>
        </div>
        <div className="tier-card">
          <span className="tier-name">
            coordinator seat <span className="pill">muon mcp attach</span>
          </span>
          <p>
            Claude Code and Codex only. Mints a governed dispatch seat so a
            terminal session you run yourself can create tasks, dispatch,
            steer, interrupt, ship, and assign roles — under the same capped
            delegation manifest as any other coordinator, and still never{" "}
            <code>set_fleet</code>, <code>raise_budget</code>, or{" "}
            <code>apply_workflow</code>.
          </p>
        </div>
      </div>

      <p>
        Cursor and OpenCode can be installed at base/observer, but neither
        can hold the coordinator seat — <code>muon mcp status</code> prints
        both booleans (installable vs. can-coordinate) per vendor so
        they&apos;re never conflated.
      </p>

      <h2>One honest boundary</h2>
      <div className="callout">
        <span className="callout-title">What MUON governs here</span>
        <p>
          MUON governs what an installed or attached session may do to your{" "}
          <strong>crew</strong> and to <strong>memory</strong>. It does{" "}
          <strong>not</strong> govern what that session does to your{" "}
          <strong>filesystem</strong> — your own agent&apos;s permission
          prompts do, and you are sitting there answering them. That
          compensating fact is real: a human at the terminal answering a
          vendor&apos;s own prompts live is a stronger posture than an
          unattended agent, not a weaker one.
        </p>
      </div>

      <h2>Check the status of an attach</h2>
      <p>
        <code>muon mcp status</code> re-verifies everything on every run:
        whether a brain is running, which resolver branch supplies the
        bearer token, whether an exported <code>MUON_API_BASE</code> is
        silently suppressing lockfile discovery, whether the recorded{" "}
        <code>muon-mcp</code> binary path still resolves (catching an app
        update that moved it, instead of failing silently inside your CLI),
        and per vendor whether the entry exists, where, and whether that CLI
        is even installed. <code>muon doctor</code> is the separate check for
        whether each vendor CLI is installed <strong>and</strong> logged in —
        MUON never logs you in and never stores a vendor token.
      </p>

      <div className="page-footer-nav">
        <Link href="/cli">← CLI reference</Link>
        <Link href="/governance">Governance →</Link>
      </div>
    </>
  );
}
