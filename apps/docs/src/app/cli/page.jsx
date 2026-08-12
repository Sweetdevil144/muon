import Link from "next/link";
export const metadata = {
  title: "CLI reference",
  description:
    "The muon CLI: chat, dispatch control, fleet, memory, mcp, doctor, and version — exact syntax.",
};

export default function CliPage() {
  return (
    <>
      <p className="eyebrow">Reference</p>
      <h1>The muon CLI</h1>
      <p className="lead">
        Everything the desktop app and TUI do is reachable from{" "}
        <code>muon</code>. The CLI auto-starts the embedded local brain on
        first use (except for <code>version</code>, <code>shutdown</code>,{" "}
        <code>custom-agents</code>, and most <code>mcp</code> subcommands,
        which deliberately never require one) — there is nothing to boot by
        hand. Every command below is copied from the CLI&apos;s own
        Commander definitions; run <code>muon &lt;command&gt; --help</code>{" "}
        for the full, current option list.
      </p>

      <div className="callout">
        <span className="callout-title">Global flags</span>
        <p>
          <code>--api-base &lt;url&gt;</code> overrides the local brain&apos;s
          API base; <code>--api-token &lt;token&gt;</code> (or{" "}
          <code>MUON_API_TOKEN</code>) supplies a bearer token. Leave both
          unset for the normal local flow — the CLI discovers a running brain
          itself, or spawns one.
        </p>
      </div>

      <h2>Chat with the orchestrator</h2>
      <div className="cmd-list">
        <div className="cmd">
          <code className="cmd-name">
            muon chat [--workspace &lt;dir&gt;] [--chat-id &lt;id&gt;] [--message
            &lt;text&gt;] [--model &lt;id&gt;]
          </code>
          <p>
            Talk to the super-orchestrator like you&apos;d talk to Claude: it
            plans, dispatches the fleet, and reports — gates stay yours. With
            no <code>--message</code>, opens an interactive REPL (
            <code>/quit</code> to exit). With one, sends it and exits
            (scriptable).
          </p>
          <div className="flags">
            <code>--archive</code> — soft-archive the chat (history and audit
            trail survive) and exit. <code>--cancel</code> — stop every
            queued/running job in the chat, keep the chat itself; safe to run
            twice.
          </div>
        </div>
      </div>

      <h2>Dispatch control</h2>
      <p>
        <code>muon dispatch</code> is the CLI mirror of the crew&apos;s
        control surface — inspect and act on a dispatched job without
        killing the whole runner.
      </p>
      <div className="cmd-list">
        <div className="cmd">
          <code className="cmd-name">
            muon dispatch status [--job-id &lt;id&gt;] [--chat-id &lt;id&gt;]
            [--json]
          </code>
          <p>
            One job&apos;s status plus its crew budget (with{" "}
            <code>--job-id</code>), or the list of active jobs (optionally
            filtered to one chat).
          </p>
        </div>
        <div className="cmd">
          <code className="cmd-name">
            muon dispatch interrupt --job-id &lt;id&gt;
          </code>
          <p>The crew&apos;s kill switch — interrupt one running job.</p>
        </div>
        <div className="cmd">
          <code className="cmd-name">
            muon dispatch steer --job-id &lt;id&gt; --message &lt;text&gt;
          </code>
          <p>Send a steer message to a running dispatched job.</p>
        </div>
        <div className="cmd">
          <code className="cmd-name">
            muon dispatch raise --job-id &lt;id&gt; --pool-ms &lt;ms&gt;
          </code>
          <p>
            Raise a mission&apos;s descendant wall-clock time pool — the
            operator&apos;s recourse when a crew exhausts its budget. Targets
            the root orchestrator job; delegated children share its pool.
          </p>
        </div>
      </div>

      <h2>Fleet and agents</h2>
      <div className="cmd-list">
        <div className="cmd">
          <code className="cmd-name">muon agents [--json] [--refresh]</code>
          <p>
            Discovery table: name, vendor handle, stable id, readiness — then
            the exact next command for the first actionable row.
          </p>
        </div>
        <div className="cmd">
          <code className="cmd-name">muon fleet [--json]</code>
          <p>
            Current fleet counts per vendor and each agent&apos;s live
            status.
          </p>
        </div>
        <div className="cmd">
          <code className="cmd-name">
            muon fleet set --claude-code &lt;n&gt; --codex &lt;n&gt; --cursor
            &lt;n&gt; --opencode &lt;n&gt;
          </code>
          <p>
            Resize the fleet per vendor, 0–3 instances each. A resize never
            kills a working agent. At least one <code>--&lt;vendor&gt;</code>{" "}
            flag is required.
          </p>
        </div>
        <div className="cmd">
          <code className="cmd-name">muon fleet agents [--json]</code>
          <p>List fleet agent instances with live status.</p>
        </div>
      </div>

      <h2>Memory</h2>
      <p>
        Decisions, constraints, conventions, attempts, and questions — every
        read below is fenced to the invoking workspace by default (
        <code>--workspace &lt;path&gt;</code> to target another, or{" "}
        <code>--unscoped</code> for the operator-only unassigned residue).
      </p>
      <div className="cmd-list">
        <div className="cmd">
          <code className="cmd-name">
            muon memory add --kind &lt;kind&gt; --text &lt;text&gt;
          </code>
          <p>
            Add a note. <code>--kind</code> is one of <code>decision</code>,{" "}
            <code>constraint</code>, <code>convention</code>,{" "}
            <code>attempt</code>, <code>question</code>. Optional anchors:{" "}
            <code>--task-id</code>, <code>--lane-id</code>,{" "}
            <code>--module</code>, <code>--symbol</code> (
            <code>&lt;module&gt;#&lt;name&gt;</code>), <code>--topic</code>.
          </p>
        </div>
        <div className="cmd">
          <code className="cmd-name">
            muon memory search &lt;query...&gt; [--filter &lt;json&gt;]
          </code>
          <p>Lexical search over notes in the fenced workspace.</p>
        </div>
        <div className="cmd">
          <code className="cmd-name">
            muon memory library [--q &lt;text&gt;] [--status ...] [--confirmed
            ...] [--kind ...] [--trust ...]
          </code>
          <p>
            Browse the governed memory library: filter by status
            (all/active/paused/rejected), confirmation state, kind, trust, or
            free text.
          </p>
        </div>
        <div className="cmd">
          <code className="cmd-name">
            muon memory recall [--task-id] [--lane-id] [--module] [--topic]
          </code>
          <p>Recall notes by task, lane, module, or topic.</p>
        </div>
        <div className="cmd">
          <code className="cmd-name">muon memory review [--auto] [--from-pack]</code>
          <p>
            The review queue: notes still <strong>unvouched</strong> and
            awaiting a human confirm or reject. A MUON-vouched or
            operator-confirmed note is settled and never listed here.
          </p>
        </div>
        <div className="cmd">
          <code className="cmd-name">
            muon memory confirm --note-id &lt;id&gt; / muon memory reject
            --note-id &lt;id&gt;
          </code>
          <p>
            Operator-only governance acts — mark a note human-confirmed, or
            reject it (kept for traceability, hidden from recall).
          </p>
        </div>
        <div className="cmd">
          <code className="cmd-name">
            muon memory pack export --out &lt;dir&gt; / import &lt;store&gt; /
            sync &lt;store&gt;
          </code>
          <p>
            Team memory sync over plain files — no MUON cloud. Export writes
            this workspace&apos;s confirmed notes as a content-addressed pack;
            import stages a teammate&apos;s pack as unconfirmed proposals in
            your review queue; sync does both. Operator-tier only.
          </p>
        </div>
      </div>

      <h2>MCP server registration</h2>
      <div className="cmd-list">
        <div className="cmd">
          <code className="cmd-name">
            muon mcp install &lt;claude|codex|cursor|opencode&gt; [--scope
            user|project] [--mode observer] [--dry-run]
          </code>
          <p>
            Register MUON&apos;s MCP server with your own CLI&apos;s config.
            See <Link href="/mcp">the MCP page</Link> for what it does and does not
            grant.
          </p>
        </div>
        <div className="cmd">
          <code className="cmd-name">
            muon mcp status [--scope &lt;scope&gt;] [--json]
          </code>
          <p>
            Explain the tier a hand-started session would get, and every
            reason it could be wrong — brain state, token source, whether the
            recorded <code>muon-mcp</code> path still resolves, per-vendor
            registration.
          </p>
        </div>
        <div className="cmd">
          <code className="cmd-name">
            muon mcp uninstall &lt;vendor&gt;
          </code>
          <p>
            Remove exactly the entry MUON wrote; every other server and key
            in that config file is left untouched.
          </p>
        </div>
        <div className="cmd">
          <code className="cmd-name">
            muon mcp attach &lt;claude|codex&gt; / muon mcp detach
            &lt;vendor&gt;
          </code>
          <p>
            Mint (or revoke) a governed dispatch seat for a coordinator CLI
            you run yourself — Claude Code and Codex only, the two lanes that
            can hold the coordinator seat.
          </p>
        </div>
      </div>

      <h2>Diagnostics and lifecycle</h2>
      <div className="cmd-list">
        <div className="cmd">
          <code className="cmd-name">muon doctor [--json]</code>
          <p>
            Backend connectivity and lane health: the versioned capability
            preflight contract MUON&apos;s own surfaces read from. Never
            rejects — every unreadable source degrades to an honest
            &ldquo;unknown&rdquo; with a reason.
          </p>
        </div>
        <div className="cmd">
          <code className="cmd-name">muon version</code>
          <p>
            App version, the indexed code-graph commit, the workspace&apos;s
            actual HEAD, and whether the two disagree (a stale index).
          </p>
        </div>
        <div className="cmd">
          <code className="cmd-name">muon onboard</code>
          <p>
            Guided first run: per-vendor installed/authenticated readiness
            plus the exact fix for any gap.
          </p>
        </div>
        <div className="cmd">
          <code className="cmd-name">
            muon quickstart [--workspace &lt;dir&gt;]
          </code>
          <p>
            Seed and dispatch a tiny, safe, additive sample task so you can
            watch the whole loop run without inventing one yourself.
          </p>
        </div>
        <div className="cmd">
          <code className="cmd-name">
            muon context &lt;target&gt; [--view-proposal &lt;noteId&gt;]
          </code>
          <p>
            The pre-edit gate for the terminal: blast-radius fused with
            governed memory, prior decisions, live cross-agent activity, and
            pending proposals for a symbol or file.
          </p>
        </div>
        <div className="cmd">
          <code className="cmd-name">
            muon approve list / review --approval-id &lt;id&gt; / resolve
            --approval-id &lt;id&gt; --status approved|rejected
          </code>
          <p>
            The approval queue from the terminal, including{" "}
            <code>review</code>&apos;s exact artifact digest and REVIEW BLIND
            file list for merge gates.
          </p>
        </div>
        <div className="cmd">
          <code className="cmd-name">muon shutdown</code>
          <p>
            Stop the persistent local brain and runner that CLI commands
            auto-start. The desktop app stops its own processes on quit; this
            is the CLI&apos;s off switch for the pair it spawned.
          </p>
        </div>
      </div>

      <div className="page-footer-nav">
        <Link href="/quickstart">← Quickstart</Link>
        <Link href="/mcp">MCP server →</Link>
      </div>
    </>
  );
}
