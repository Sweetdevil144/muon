import Link from "next/link";
export const metadata = {
  title: "Troubleshooting",
  description:
    "Vendor CLI not found or logged out, a stale code index, the brain not running, log locations, and how to reset.",
};

export default function TroubleshootingPage() {
  return (
    <>
      <p className="eyebrow">Troubleshooting</p>
      <h1>Troubleshooting</h1>
      <p className="lead">
        Start with <code>muon doctor</code> (machine-readable JSON, safe to
        script against) or <code>muon onboard</code> (the human-guided
        version) — both are read-only diagnostics and never reject on a
        degraded environment; every source that can&apos;t be read degrades
        to an honest &ldquo;unknown&rdquo; with a reason instead of a crash.
      </p>
      <pre>
        <code>{`muon doctor --json     # scriptable capability preflight
muon onboard           # guided, human-readable checklist`}</code>
      </pre>

      <h2>A vendor CLI isn&apos;t found, or reads as logged out</h2>
      <p>
        MUON checks two things separately per vendor —{" "}
        <strong>installed</strong> and <strong>authenticated</strong> — and
        both <code>muon doctor</code> and <code>muon onboard</code> name
        which one is missing rather than a generic &ldquo;not ready.&rdquo;
      </p>
      <table>
        <thead>
          <tr>
            <th>Vendor</th>
            <th>Reinstall</th>
            <th>Re-authenticate</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Claude Code</td>
            <td>
              <code>npm i -g @anthropic-ai/claude-code</code>
            </td>
            <td>run <code>claude</code>, sign in</td>
          </tr>
          <tr>
            <td>Codex</td>
            <td>
              <code>npm i -g @openai/codex</code>
            </td>
            <td>
              <code>codex login</code>
            </td>
          </tr>
          <tr>
            <td>Cursor</td>
            <td>
              <code>curl https://cursor.com/install -fsS | bash</code>
            </td>
            <td>
              <code>cursor-agent login</code>
            </td>
          </tr>
          <tr>
            <td>OpenCode</td>
            <td>
              <code>curl -fsSL https://opencode.ai/install | bash</code>
            </td>
            <td>
              <code>opencode auth login</code>
            </td>
          </tr>
        </tbody>
      </table>
      <div className="callout">
        <span className="callout-title">Codex with a custom provider</span>
        <p>
          If <code>~/.codex/config.toml</code> selects a custom{" "}
          <code>model_provider</code> (e.g. Azure), MUON requires the exact{" "}
          <code>env_key</code> that provider declares — a cached native login
          does not authenticate a different selected provider. Set the
          provider&apos;s key in your shell environment (never a repository
          file) and launch MUON from a shell that has it, or switch back to a
          built-in provider and <code>codex login</code>.
        </p>
      </div>
      <p>
        Each lane holds the roles it is best at, by design: Cursor takes
        review-class roles (reviewer, QA, architect, scout) with a
        no-writes guarantee, and OpenCode scouts. If a dispatch is refused
        for a role, that is the role model working, not a fault.
      </p>

      <h2>The code index looks stale</h2>
      <p>
        MUON&apos;s embedded code graph indexes your workspace in the
        background as you commit. Check whether it has fallen behind HEAD:
      </p>
      <pre>
        <code>muon version</code>
      </pre>
      <p>
        The JSON includes <code>brainCommit</code> (what the graph is
        indexed at), <code>headCommit</code> (your workspace&apos;s actual
        HEAD), and <code>stale</code> (whether they disagree). If it&apos;s
        stale:
      </p>
      <ul>
        <li>
          In the desktop app, open the graph/code panel and use the{" "}
          <strong>Re-index</strong> button — it&apos;s the operator&apos;s
          explicit escape hatch and is disabled while an index is already
          running (indexing is exclusive per repository, so two triggers
          can&apos;t race each other into a corrupted store).
        </li>
        <li>
          The MCP server also opportunistically refreshes freshness on
          certain reads (<code>code_impact</code>), so a short lag often
          clears on its own during normal use.
        </li>
        <li>
          A stale index degrades gracefully rather than lying: MUON&apos;s
          own orchestrator is instructed to treat a stale or unindexed file
          as <strong>review-blind</strong> and route it to a human rather
          than certify a diff it can&apos;t actually see.
        </li>
      </ul>

      <h2>The brain doesn&apos;t seem to be running</h2>
      <p>
        &ldquo;The brain&rdquo; is MUON&apos;s embedded local backend. The
        desktop app supervises its own; the CLI auto-spawns one on first use
        for every command except <code>version</code>, <code>shutdown</code>,{" "}
        <code>custom-agents</code>, and most <code>mcp</code> subcommands
        (which are deliberately brain-independent, since some of them exist
        specifically to diagnose a brain that isn&apos;t there).
      </p>
      <pre>
        <code>{`muon doctor          # reports connectivity honestly, even if the brain is down
muon mcp status      # reports whether a brain is running, and its port/pid
muon shutdown        # stop the CLI-spawned brain + runner cleanly
muon chat            # any ordinary command re-spawns one if none is found`}</code>
      </pre>
      <p>
        If the desktop app and a CLI-spawned brain both start up, MUON
        detects and adopts the already-running one rather than starting a
        second — running <code>muon doctor</code> tells you which profile
        (data directory, port, pid) you&apos;re actually talking to.
      </p>

      <h2>Where logs live</h2>
      <table>
        <thead>
          <tr>
            <th>Path</th>
            <th>What</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>~/Library/Application Support/MUON/logs/brain.log</code>
            </td>
            <td>Embedded backend log</td>
          </tr>
          <tr>
            <td>
              <code>~/Library/Application Support/MUON/logs/runner.log</code>
            </td>
            <td>
              Sandboxed runner boot, lease, dispatch, and recovery log
            </td>
          </tr>
          <tr>
            <td>
              <code>~/Library/Application Support/MUON/</code>
            </td>
            <td>
              Everything else MUON persists locally — settings, the embedded
              SQLite brain, the graph store, the lockfile
            </td>
          </tr>
        </tbody>
      </table>

      <h2>How to reset</h2>
      <ol className="step-list">
        <li>
          <h3>Stop everything cleanly first</h3>
          <p>
            Quit the desktop app, then run <code>muon shutdown</code> to stop
            any CLI-spawned brain and runner. Confirm nothing is left with{" "}
            <code>muon doctor</code>.
          </p>
        </li>
        <li>
          <h3>Wipe local state</h3>
          <p>
            Delete <code>~/Library/Application Support/MUON/</code>. This
            removes the embedded SQLite brain, the graph store, the lockfile,
            and settings — everything MUON knows locally, including
            unconfirmed memory proposals. Confirmed decisions you care about
            should be exported first with{" "}
            <code>muon memory pack export --out &lt;dir&gt;</code> if you
            want them back afterward.
          </p>
          <p className="callout limit" style={{ marginTop: "0.6rem" }}>
            <span className="callout-title">No dedicated reset command</span>
            Removing the data directory by hand is the current reset path —
            there is no <code>muon reset</code> command in v1.
          </p>
        </li>
        <li>
          <h3>Relaunch</h3>
          <p>
            Reopen the app or run any <code>muon</code> command; MUON
            reinitializes a fresh brain and re-indexes the workspace the next
            time it needs to.
          </p>
        </li>
      </ol>

      <h2>Still stuck?</h2>
      <p>
        Send a mail with your <code>muon doctor --json</code> output
        attached (it never includes a credential value, only readiness
        booleans and reasons) at{" "}
        <a href="mailto:abhinavpandey1230@gmail.com">
          abhinavpandey1230@gmail.com
        </a>
   
        .
      </p>

      <div className="page-footer-nav">
        <Link href="/governance">← Governance</Link>
        <Link href="/">Overview →</Link>
      </div>
    </>
  );
}
