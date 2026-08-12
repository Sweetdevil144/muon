import Link from "next/link";
export const metadata = {
  title: "Overview",
  description:
    "MUON is a local-first governed control plane for the coding-agent CLIs you already run.",
};

export default function HomePage() {
  return (
    <>
      <p className="eyebrow">MUON</p>
      <h1>A local-first control plane for your coding agents</h1>
      <p className="lead">
        MUON drives the coding-agent CLIs you already have — Claude Code,
        Codex, Cursor, and OpenCode — as one coordinated crew, running
        entirely on your machine. Every edit passes through approval gates
        you control, and every fact your agents rely on lives in a shared,
        human-confirmed memory instead of being re-litigated task after task.
        Nothing about MUON custodies a vendor credential or phones home: it
        runs on loopback, makes no outbound calls of its own beyond an
        opt-in update check, and telemetry ships with no upload provider at
        all.
      </p>

      <div className="link-grid">
        <Link className="link-card" href="/install">
          <span className="link-title">Install →</span>
          <span className="link-desc">
            The macOS app, the unsigned Gatekeeper dance, and requirements.
          </span>
        </Link>
        <Link className="link-card" href="/quickstart">
          <span className="link-title">Quickstart →</span>
          <span className="link-desc">
            Open the app, connect an agent, run your first mission.
          </span>
        </Link>
        <Link className="link-card" href="/cli">
          <span className="link-title">CLI reference →</span>
          <span className="link-desc">
            <code>muon chat</code>, <code>dispatch</code>,{" "}
            <code>fleet</code>, <code>memory</code>, and more.
          </span>
        </Link>
        <Link className="link-card" href="/mcp">
          <span className="link-title">MCP server →</span>
          <span className="link-desc">
            Give your own CLI session MUON&apos;s shared brain.
          </span>
        </Link>
        <Link className="link-card" href="/governance">
          <span className="link-title">Governance →</span>
          <span className="link-desc">
            Approval gates, memory tiers, full-auto, and what never happens.
          </span>
        </Link>
        <Link className="link-card" href="/troubleshooting">
          <span className="link-title">Troubleshooting →</span>
          <span className="link-desc">
            Vendor CLI not found, stale index, brain not running, logs.
          </span>
        </Link>
      </div>

      <h2>What MUON is</h2>
      <p>
        You keep using the coding agents you already trust. MUON sits above
        them as an orchestrator: it plans work, dispatches it to a fleet of
        agent instances (0–3 per vendor), watches what they do, and stops for
        your decision at every point that matters — an edit outside the
        expected surface, a network call, a merge. Agents coordinate with
        each other through bounded, authority-free messages and advisory
        file claims; none of that coordination can approve, dispatch, or
        widen anything on its own.
      </p>
      <p>
        The other half is memory: a graph of decisions, constraints,
        conventions, and attempts, fused at edit time with a code-level
        blast-radius analysis. An agent about to touch a symbol sees the
        prior, human-confirmed decisions anchored to it and any contested
        proposals a human still needs to resolve — before it writes a line.
      </p>

      <h2>What MUON is not</h2>
      <ul>
        <li>
          Not a cloud service. There is no MUON account, no hosted brain, and
          no data leaves your machine except each vendor&apos;s own model
          traffic (which was already leaving, MUON does not add a hop).
        </li>
        <li>
          Not a replacement for your coding agents. It never ships or
          custodies one — you install and log in to each vendor CLI
          yourself, natively.
        </li>
        <li>
          Not fully hands-off by default. Approval gates are on unless you
          explicitly arm full-auto, and full-auto is a standing consent you
          grant per vendor lane, not a permanent setting — see{" "}
          <Link href="/governance">Governance</Link>.
        </li>
      </ul>

      <h2>Where to start</h2>
      <ol>
        <li>
          <Link href="/install">Install</Link> the macOS app (unsigned in v1 — the
          page covers the Gatekeeper prompt).
        </li>
        <li>
          <Link href="/quickstart">Quickstart</Link> — connect a vendor and run a
          real mission end to end.
        </li>
        <li>
          Prefer a terminal? Everything the app does is also reachable from
          the <Link href="/cli">CLI</Link>, or from a session you launch yourself
          with <Link href="/mcp">MUON&apos;s MCP server</Link> attached.
        </li>
      </ol>
    </>
  );
}
