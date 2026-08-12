import Link from "next/link";
export const metadata = {
  title: "Quickstart",
  description:
    "Your first MUON mission: open the app, connect a vendor, run a mission, and approve its work.",
};

export default function QuickstartPage() {
  return (
    <>
      <p className="eyebrow">Quickstart</p>
      <h1>Your first mission</h1>
      <p className="lead">
        This walks the same path the app&apos;s own first-run wizard does:
        open MUON, pick a workspace, connect one coding agent, run a real
        mission, watch the crew work, and decide the gates it files. Nothing
        here is destructive by default — MUON&apos;s own seeded first task
        only adds files, it never edits or deletes anything you already
        have.
      </p>

      <ol className="step-list">
        <li>
          <h3>Open the app and pick a workspace</h3>
          <p>
            Launch MUON (see <Link href="/install">Install</Link> if you haven&apos;t
            yet) and choose the folder you want the crew to work in. This
            becomes the chat&apos;s workspace — memory, blast-radius, and
            every path in the run are scoped to it.
          </p>
        </li>
        <li>
          <h3>Connect a vendor</h3>
          <p>
            The first-run wizard checks Claude Code, Codex, Cursor, and
            OpenCode separately for <em>installed</em> vs. <em>authenticated</em>,
            and gives one concrete next action for whichever is missing. You
            never hand MUON a token — you log in to the vendor&apos;s own CLI,
            and MUON only observes readiness.
          </p>
          <p>From a terminal, the same check is:</p>
          <pre>
            <code>muon onboard</code>
          </pre>
        </li>
        <li>
          <h3>Run a mission chat</h3>
          <p>
            Type what you want done into the chat. MUON&apos;s orchestrator
            plans the work, dispatches it to the fleet, and reports back —
            the gates stay yours. No task ready in mind? MUON can seed a
            tiny, safe sample (adds a <code>greet(name)</code> helper and a
            test) so you can watch the whole loop without inventing one:
          </p>
          <pre>
            <code>{`muon quickstart                    # seed + dispatch a safe sample task
muon chat --workspace <dir>        # or start a real mission yourself`}</code>
          </pre>
        </li>
        <li>
          <h3>Watch the crew</h3>
          <p>
            Open the desktop&apos;s <strong>Crew Topology</strong> tab
            (⌘K → &ldquo;Open crew topology&rdquo;) to see who is doing what:
            one node per vendor lane, nested subagents drawn under their
            parent, and peer edges only where two jobs actually exchanged an
            addressed message. From the terminal:
          </p>
          <pre>
            <code>{`muon crew roles --chat <id>     # who holds which role, and why
muon crew coord --chat <id>     # peer messages, file claims, conflicts
muon dispatch status            # active jobs across the fleet`}</code>
          </pre>
          <p>
            Peer messages are rendered as explicit{" "}
            <strong>&ldquo;Agent text · untrusted&rdquo;</strong> — another
            agent&apos;s words are evidence, never an instruction and never
            something that can approve or dispatch anything on its own.
          </p>
        </li>
        <li>
          <h3>See the moat: the pre-edit hero</h3>
          <p>
            Before an agent edits a target, MUON fuses its code blast-radius
            with the <strong>human-confirmed</strong> memory anchored to it —
            prior decisions, contested proposals, and any live cross-agent
            activity on the same target. It auto-populates from the task you
            just ran. From the terminal:
          </p>
          <pre>
            <code>muon context muon-hello.ts   # or any symbol / file / module path</code>
          </pre>
          <p>
            Trusted decisions show their full text. Contested proposals show
            existence-only until you explicitly ask to read them — an
            unvetted note can never sneak into an agent as if it were settled
            fact.
          </p>
        </li>
        <li>
          <h3>Approve, review, merge</h3>
          <p>
            When an agent needs to cross a boundary — an edit outside the
            expected surface, a network call, a merge — MUON files a gate and
            waits. Desktop notifications deep-link to the full review; they
            never let you approve directly from the notification itself.
            Every field of the request (exact action, scope, consequence,
            bound evidence) has to be visible, and truncated text can never
            be approved.
          </p>
          <p>
            A merge gate in particular is graph-certified when possible: MUON
            reviews the diff itself and either certifies it or marks specific
            files <strong>REVIEW BLIND</strong> (new or unindexed files, or a
            stale index) that need a human&apos;s own read before the merge
            can go through. From the terminal:
          </p>
          <pre>
            <code>{`muon approve list
muon approve review --approval-id <id>     # exact artifact digest + blind files
muon approve resolve --approval-id <id> --status approved`}</code>
          </pre>
        </li>
      </ol>

      <h2>Honest about full-auto</h2>
      <p>
        The desktop sidebar has a <strong>full-auto</strong> panel that turns
        red when armed — that color is deliberate: it is disabling a gate,
        and MUON wants that visible at a glance, not buried in a settings
        page. You can arm it for every lane or for specific vendor lanes
        only:
      </p>
      <ul>
        <li>
          <strong>Off (default):</strong> &ldquo;every approval waits for
          you.&rdquo;
        </li>
        <li>
          <strong>Armed, all lanes:</strong> &ldquo;every approval resolves
          automatically. Egress and blocked merge reviews still ask.&rdquo;
        </li>
        <li>
          <strong>Armed, a subset of lanes:</strong> &ldquo;checked lanes
          approve automatically; every other request still asks you.&rdquo;
          A request MUON cannot attribute to a specific vendor lane is never
          covered by a partial selection — only the all-lanes checkbox does
          that.
        </li>
      </ul>
      <p>
        Full-auto is <strong>standing operator consent</strong>, not a
        bypass: every auto-approval still goes through the same approval
        path a manual click uses, and it leaves a named receipt in the audit
        trail (the exact command or scope that was approved, redacted of
        secrets, with its risk level) — never a bare &ldquo;auto-approved,&rdquo;
        because a decision recorded without its subject isn&apos;t a
        reviewable one. See <Link href="/governance">Governance</Link> for what
        full-auto can never cover.
      </p>

      <div className="page-footer-nav">
        <Link href="/install">← Install</Link>
        <Link href="/cli">CLI reference →</Link>
      </div>
    </>
  );
}
