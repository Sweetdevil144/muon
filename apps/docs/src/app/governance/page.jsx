import Link from "next/link";
export const metadata = {
  title: "Governance",
  description:
    "Approval gates, memory tiers, full-auto standing consent, and what MUON never does.",
};

export default function GovernancePage() {
  return (
    <>
      <p className="eyebrow">Governance</p>
      <h1>How MUON governs the crew</h1>
      <p className="lead">
        MUON separates two roles everywhere: an <strong>operator</strong>{" "}
        (you, holding an operator-tier credential) decides; an{" "}
        <strong>agent</strong> (any dispatched worker, or a session you
        attach MUON&apos;s MCP server to) does. Nothing an agent holds can
        approve, confirm memory, or answer a gate — those are operator-only
        acts, enforced by which token a caller presents, not by convention.
      </p>

      <h2>Approval gates</h2>
      <p>
        When an agent&apos;s work crosses a boundary that matters — an edit
        outside the expected surface, a network call, a merge, a dangerous
        command — MUON files a gate and the agent waits. A few rules hold
        everywhere a gate appears (desktop, TUI, CLI):
      </p>
      <ul>
        <li>
          Every field of the request has to be readable before you decide:
          the exact action, its scope, the consequence, and the bound
          evidence. <strong>Truncated text can never be approved.</strong>
        </li>
        <li>
          A native notification can deep-link to the full review — it can
          never let you approve directly from the notification itself.
        </li>
        <li>
          A decision is bound to the exact content it was made on. If the
          content changes after you&apos;ve seen it, the old approval cannot
          be reused.
        </li>
        <li>
          A merge gate can be <strong>graph-certified</strong>: MUON reviews
          the diff itself against the code graph and either certifies it or
          names specific files <strong>REVIEW BLIND</strong> (new/unindexed
          files, or a stale index) that a human has to read directly. Stale
          or unavailable review evidence never quietly opens a bypass.
        </li>
        <li>
          <code>--remember &lt;ttlMs&gt;</code> on the CLI can mint a
          content-bound receipt so one <em>exact</em> action is auto-allowed
          until it expires (1 minute to 1 hour) — never a blanket allow, and
          never available for a merge/ship decision.
        </li>
      </ul>

      <h2>Memory tiers</h2>
      <p>
        Every memory note carries exactly one of four tiers, computed by one
        shared rule so the desktop, TUI, and CLI can never describe the same
        note differently:
      </p>
      <div className="tier-grid">
        <div className="tier-card">
          <span className="tier-name">human-confirmed</span>
          <p>
            A person confirmed it. The only tier that unlocks global-scope
            promotion, pack export, and destructive-write protection.
          </p>
        </div>
        <div className="tier-card">
          <span className="tier-name">MUON-vouched</span>
          <p>
            The crew&apos;s coordinator vouched for it on the record.
            Settled and durable, but not human-confirmed.
          </p>
        </div>
        <div className="tier-card">
          <span className="tier-name">crew-auto</span>
          <p>
            Crew-visible only under an operator&apos;s explicit
            auto-confirm-agent-memory posture — nobody has actually vouched
            for it.
          </p>
        </div>
        <div className="tier-card">
          <span className="tier-name">pending / open</span>
          <p>
            Nobody vouched and nothing is carrying it — the one tier that is
            a debt. A note that lapses (expires) returns to this tier
            regardless of what once vouched for it.
          </p>
        </div>
      </div>
      <p>
        The pre-edit gate only ever shows <strong>trusted</strong> decision
        text; a contested or pending proposal shows as existence-only until
        you explicitly ask to read it and confirm or reject it. Untrusted
        note text can never reach an agent through that gate as if it were a
        decision.
      </p>

      <h2>Full-auto: standing operator consent</h2>
      <p>
        Full-auto lets you pre-authorize approvals instead of clicking
        through each one — but it is consent you grant, not a mode that
        removes the gate. Two properties make that true:
      </p>
      <ul>
        <li>
          <strong>It is scoped, not global by construction.</strong> You can
          arm it for every lane, or for specific vendor lanes only; a
          request MUON cannot attribute to a resolvable vendor lane is{" "}
          <strong>not</strong> covered by a partial selection, on purpose —
          an unattributable request must never ride a narrower consent than
          it actually has.
        </li>
        <li>
          <strong>It cannot cover everything.</strong> Egress actions and
          blocked merge reviews still ask, always. A merge that needs an
          explicit operator attestation over REVIEW BLIND files is exactly
          the kind of decision full-auto cannot manufacture.
        </li>
        <li>
          <strong>Every grant is a real, audited decision.</strong> Each
          auto-approval goes through the identical operator-tier resolve path
          a manual click uses, and leaves a receipt naming the action and
          scope it covered (redacted of secrets) — never a bare
          &ldquo;auto-approved&rdquo; with no subject.
        </li>
        <li>
          <strong>It fails back to you, visibly.</strong> If the brain
          refuses a standing grant, or a grant hasn&apos;t landed within its
          grace window, that request drops back to an ordinary blocking
          prompt — the UI is never allowed to keep calling something
          &ldquo;auto-approving&rdquo; once that claim stops being true.
        </li>
      </ul>

      <h2>What never happens</h2>
      <div className="callout ok">
        <span className="callout-title">No vendor token custody</span>
        <p>
          You log in to each coding agent with its own CLI, or use your own
          BYOK/custom-provider credential. MUON only observes readiness
          (installed / authenticated) and, for supported BYOK setups, forwards
          the one selected credential variable to the one selected child
          process. It never stores, proxies, or logs you into a vendor
          account.
        </p>
      </div>
      <div className="callout ok">
        <span className="callout-title">No data egress by default</span>
        <p>
          MUON is loopback-only (<code>127.0.0.1</code>) and local-first. The
          sole MUON-owned outbound call is the opt-in update check described
          in <Link href="/install">Install</Link> — off by default, and it only
          ever asks &ldquo;is there a newer release,&rdquo; nothing else.
          Vendor model traffic (your agent talking to its own model) remains
          vendor-owned; MUON does not add a hop to it or read its contents.
        </p>
      </div>
      <div className="callout ok">
        <span className="callout-title">No telemetry upload</span>
        <p>
          MUON&apos;s telemetry module ships with a fixed provider of{" "}
          <code>&quot;none&quot;</code> — there is no uploader in the code at
          all today. Events are spooled locally (owner-only file
          permissions) as a bounded, enum-only vocabulary with no free-text
          field, which exists for local crash diagnostics and as an
          inspectable audit artifact, not for transmission anywhere.
        </p>
      </div>

      <h2>Two tokens, one gate</h2>
      <p>
        Under the hood, everything above rests on one separation: the
        operator token can govern (approve, confirm memory, resize the
        fleet); the agent token can only do (dispatch work, propose memory,
        read the graph). A UI surface never holds the raw operator token
        itself, and an MCP server — including one attached to a session you
        launched — can only ever present the agent tier. There is no code
        path where an agent-held credential decides a gate.
      </p>

      <div className="page-footer-nav">
        <Link href="/mcp">← MCP server</Link>
        <Link href="/troubleshooting">Troubleshooting →</Link>
      </div>
    </>
  );
}
