import Link from "next/link";
export const metadata = {
  title: "Install",
  description:
    "Install the MUON macOS app, including the unsigned Gatekeeper first-launch flow.",
};

export default function InstallPage() {
  return (
    <>
      <p className="eyebrow">Install</p>
      <h1>Install MUON on macOS</h1>
      <p className="lead">
        MUON ships as a native macOS app (Apple silicon only) that hosts its
        own local backend and background runner — there is nothing else to
        start. The v1 build is <strong>unsigned</strong>, so the first launch
        requires one extra step past macOS Gatekeeper. That is expected, not
        a defect: see{" "}
        <a href="#unsigned">why it&apos;s unsigned</a> below.
      </p>

      <h2>Requirements</h2>
      <ul>
        <li>
          <strong>macOS on Apple silicon (arm64).</strong> Intel/universal
          builds are a follow-up, not available in v1.
        </li>
        <li>
          <strong>git</strong> installed and on your <code>PATH</code>. MUON
          operates on git repositories/workspaces and shells out to git for
          workspace identity, diffs, and merges.
        </li>
        <li>
          <strong>At least one coding-agent CLI installed and logged in.</strong>{" "}
          MUON drives your own agents; it never ships or authenticates one for
          you. Pick at least one:
        </li>
      </ul>

      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th>Install</th>
            <th>Log in (you run this)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Claude Code</td>
            <td>
              <code>npm i -g @anthropic-ai/claude-code</code>
            </td>
            <td>run <code>claude</code> and sign in</td>
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
        <span className="callout-title">Each lane plays its strongest position</span>
        <p>
          Claude Code and Codex build, lead, and hold the coordinator seat.
          Cursor runs review-class roles (reviewer, QA, architect, scout) with
          a guarantee attached: it reads and judges, and your workspace stays
          untouched. OpenCode is the crew&apos;s scout, and MUON forwards it
          no credential at all; it keeps its own <code>auth.json</code>.
        </p>
      </div>

      <h2>Get the app</h2>
      <p>
        Download the app from{" "}
        <a href="https://getmuon.com/download">getmuon.com/download</a>: grab{" "}
        <code>MUON-&lt;version&gt;-arm64.dmg</code>, open it, and drag{" "}
        <strong>MUON</strong> into <strong>Applications</strong>. Every
        artifact ships with a published SHA-256 checksum
        (<code>SHA256SUMS</code>, served alongside the download) so you can
        verify what you got before you open it.
      </p>

      <h2 id="first-launch">First launch: getting past Gatekeeper</h2>
      <p>
        Because the v1 build carries no Developer ID signature, macOS blocks
        the very first launch and calls MUON an app from an
        &ldquo;unidentified developer.&rdquo; You only do this once — macOS
        remembers your choice after.
      </p>

      <ol className="step-list">
        <li>
          <h3>Right-click → Open</h3>
          <p>
            In Finder, <strong>Control-click</strong> (or right-click){" "}
            <code>MUON.app</code> and choose <strong>Open</strong>, then
            confirm <strong>Open</strong> in the dialog that appears. A plain
            double-click only offers &ldquo;Move to Trash&rdquo; on an
            unsigned app — you must use right-click → Open.
          </p>
        </li>
        <li>
          <h3>Or: System Settings → Privacy &amp; Security</h3>
          <p>
            On newer macOS, after a blocked double-click, open{" "}
            <strong>System Settings → Privacy &amp; Security</strong>, scroll
            to the &ldquo;MUON was blocked&rdquo; notice, and click{" "}
            <strong>Open Anyway</strong>.
          </p>
        </li>
        <li>
          <h3>Or: clear the quarantine flag from the Terminal</h3>
          <p>
            The two options above are the documented path. If you&apos;d
            rather do it from a terminal, the quarantine attribute macOS
            attaches to anything downloaded from the web can be stripped
            directly with:
          </p>
          <pre>
            <code>xattr -dr com.apple.quarantine /Applications/MUON.app</code>
          </pre>
          <p>
            This is the standard macOS mechanism for an unsigned app you
            trust — it does the same thing as clicking &ldquo;Open
            Anyway,&rdquo; just from the shell. Run it once, after the app is
            in <code>/Applications</code>.
          </p>
        </li>
      </ol>

      <h2 id="cli">Install the CLI and TUI</h2>
      <p>
        The terminal surfaces install with one command (requires Node 20+
        and npm on your <code>PATH</code>):
      </p>
      <pre>
        <code>{`curl -fsSL https://getmuon.com/install.sh | bash`}</code>
      </pre>
      <p>
        macOS and Linux, one command. It needs Node.js 20+ and installs
        nothing else. There is deliberately no Homebrew tap or apt repo — one
        installer means one code path, and nothing that can drift out of step
        with a release.
      </p>
      <p>
        That installs two commands: <code>muon</code> (the CLI — it
        auto-starts the local brain on first use, so there is no server to
        run) and <code>muon-tui</code> (the full-screen terminal cockpit).
        The desktop app is what ships the brain itself, so install it first;
        the CLI finds it whether or not the app is running.
        To register MUON as an MCP server with your own coding agent — so
        Claude Code or Codex can drive a governed crew from inside its own
        session — run <code>muon mcp install</code> afterwards. See{" "}
        <Link href="/cli">the CLI reference</Link> and{" "}
        <Link href="/mcp">the MCP guide</Link>.
      </p>

      <h2 id="unsigned">&ldquo;Unsigned&rdquo;, why, and is it safe?</h2>
      <p>
        MUON&apos;s v1 build is <strong>not signed with an Apple Developer ID
        certificate and is not notarized</strong>. Treat it as a controlled
        build, not (yet) a certificate-verified one.
      </p>
      <ul>
        <li>
          <strong>Why:</strong> Developer ID signing requires an active Apple
          Developer Program membership; wiring it in is deliberately staged
          as an off-by-default toggle so it can flip on later with a cert and
          no rework — the entitlements, the notarization hook
          (<code>afterSign</code>), and the config seam already exist in the
          build.
        </li>
        <li>
          <strong>What it means for you:</strong> macOS quarantines and warns
          on first launch, which is the friction above. There is no other
          behavioral difference — MUON still runs entirely on your machine.
        </li>
        <li>
          <strong>How to trust the build:</strong> every release ships with a
          published <code>SHA256SUMS</code> file next to the download —
          verify the DMG&apos;s checksum before opening it.
        </li>
      </ul>

      <h2>Auto-update</h2>
      <p>
        MUON makes no outbound network calls on its own, with exactly one
        opt-in exception: an update check against MUON&apos;s release feed
        (<code>download.getmuon.com</code>), toggled from the sidebar&apos;s{" "}
        <strong>Updates</strong> panel (off by default).
      </p>
      <div className="callout">
        <span className="callout-title">Updates are explicit, verified, and reversible</span>
        <p>
          When a newer release exists, you click <strong>Download</strong> —
          MUON fetches the update and verifies its checksum against the
          release feed — then <strong>Restart into the new version</strong>.
          The app swaps itself in /Applications, keeps a rollback copy until
          the new version boots cleanly, and restarts. Nothing downloads or
          installs without your click.
        </p>
      </div>

      <h2>Where MUON stores data</h2>
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
              <code>~/Library/Application Support/MUON/</code>
            </td>
            <td>Settings, the embedded SQLite brain, the graph store, the lockfile</td>
          </tr>
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
            <td>Sandboxed runner boot, lease, dispatch, and recovery log</td>
          </tr>
        </tbody>
      </table>
      <p>
        Uninstalling: delete <code>MUON.app</code>, and{" "}
        <code>npm uninstall -g muon-cli</code> for the CLI and TUI. Clearing
        the data directory is deliberately a separate, manual step — your
        memory graph is not something an uninstaller should decide to
        destroy.
      </p>

      <div className="page-footer-nav">
        <Link href="/">← Overview</Link>
        <Link href="/quickstart">Quickstart →</Link>
      </div>
    </>
  );
}
