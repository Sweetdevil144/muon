import type { Metadata } from "next";
import Link from "next/link";

import {
  Bullets,
  Callout,
  Code,
  DocSection,
  DocsLayout,
  P,
} from "@/components/docs/DocsLayout";

const TITLE = "Governance — approval gates, memory tiers and full-auto";
const DESCRIPTION =
  "How MUON separates operator from agent: approval gates, graph-certified merges, the four memory trust tiers, scoped full-auto consent, and what never happens.";

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


const TIERS = [
  {
    name: "human-confirmed",
    color: "bg-trust-human",
    body: "A person confirmed it. The only tier that unlocks global-scope promotion, pack export and destructive-write protection.",
  },
  {
    name: "MUON-vouched",
    color: "bg-trust-crew",
    body: "The crew's coordinator vouched for it on the record. Settled and durable, but not human-confirmed.",
  },
  {
    name: "crew-auto",
    color: "bg-trust-stale",
    body: "Crew-visible only under an operator's explicit auto-confirm posture — nobody has actually vouched for it.",
  },
  {
    name: "pending / open",
    color: "bg-trust-unconfirmed",
    body: "Nobody vouched and nothing is carrying it — the one tier that is a debt. A note that lapses returns here regardless of what once vouched for it.",
  },
];

function GovernanceDoc() {
  return (
    <DocsLayout
      eyebrow="Governance"
      title="How MUON governs the crew"
      intro="MUON separates two roles everywhere: an operator (you, holding an operator-tier credential) decides; an agent (any dispatched worker, or a session with MUON's MCP server attached) does. Nothing an agent holds can approve, confirm memory, or answer a gate — enforced by which token a caller presents, not by convention."
    >
      <DocSection title="Approval gates">
        <P>
          When an agent's work crosses a boundary that matters — an edit outside the expected
          surface, a network call, a merge, a dangerous command — MUON files a gate and the agent
          waits. A few rules hold everywhere a gate appears (desktop, TUI, CLI):
        </P>
        <Bullets
          items={[
            <>
              Every field of the request has to be readable before you decide: the exact action, its
              scope, the consequence and the bound evidence.{" "}
              <strong className="text-foreground">Truncated text can never be approved.</strong>
            </>,
            "A native notification can deep-link to the full review — it can never let you approve directly from the notification itself.",
            "A decision is bound to the exact content it was made on. If the content changes after you've seen it, the old approval cannot be reused.",
            <>
              A merge gate can be graph-certified: MUON reviews the diff against the code graph and
              either certifies it or names specific files{" "}
              <strong className="text-foreground">REVIEW BLIND</strong> (new, unindexed, or a stale
              index) that a human has to read directly.
            </>,
            <>
              <Code>--remember &lt;ttlMs&gt;</Code> on the CLI mints a content-bound receipt so one
              exact action is auto-allowed until it expires (1 minute to 1 hour) — never a blanket
              allow, and never available for a merge or ship decision.
            </>,
          ]}
        />
      </DocSection>

      <DocSection title="Memory tiers">
        <P>
          Every memory note carries exactly one of four tiers, computed by one shared rule so the
          desktop, TUI and CLI can never describe the same note differently.
        </P>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {TIERS.map((tier) => (
            <div key={tier.name} className="panel p-5">
              <div className="mb-2 flex items-center gap-2.5">
                <span className={`size-2.5 ${tier.color}`} />
                <h3 className="font-sans text-base font-semibold">{tier.name}</h3>
              </div>
              <p className="text-[0.9375rem] leading-[1.7] text-muted-foreground">{tier.body}</p>
            </div>
          ))}
        </div>
        <P>
          The pre-edit gate only ever shows trusted decision text; a contested or pending proposal
          shows as existence-only until you explicitly ask to read it and confirm or reject it.
          Untrusted note text can never reach an agent through that gate as if it were a decision.
        </P>
      </DocSection>

      <DocSection title="Full-auto: standing operator consent">
        <P>
          Full-auto lets you pre-authorize approvals instead of clicking through each one — but it is
          consent you grant, not a mode that removes the gate.
        </P>
        <Bullets
          items={[
            <>
              <strong className="text-foreground">Scoped, not global by construction.</strong> Arm it
              for every lane, or for specific vendor lanes only; a request MUON cannot attribute to a
              resolvable lane is not covered by a partial selection.
            </>,
            <>
              <strong className="text-foreground">It cannot cover everything.</strong> Egress actions
              and blocked merge reviews still ask, always. A merge needing an operator attestation
              over REVIEW BLIND files is exactly what full-auto cannot manufacture.
            </>,
            <>
              <strong className="text-foreground">Every grant is an audited decision.</strong> Each
              auto-approval goes through the identical operator-tier resolve path a manual click
              uses, leaving a receipt naming the action and scope it covered.
            </>,
            <>
              <strong className="text-foreground">It fails back to you, visibly.</strong> If a
              standing grant is refused or hasn't landed within its grace window, the request drops
              back to an ordinary blocking prompt.
            </>,
          ]}
        />
      </DocSection>

      <DocSection title="What never happens">
        <div className="space-y-4">
          <Callout title="No vendor token custody">
            <P>
              You log in to each coding agent with its own CLI, or use your own BYOK credential. MUON
              only observes readiness and, for supported BYOK setups, forwards the one selected
              credential variable to the one selected child process. It never stores, proxies, or logs
              you into a vendor account.
            </P>
          </Callout>
          <Callout title="No data egress by default">
            <P>
              MUON is loopback-only and local-first. The sole MUON-owned outbound call is the opt-in
              update check described in{" "}
              <Link href="/docs/install" className="text-foreground underline underline-offset-4">
                Install
              </Link>{" "}
              — off by default. Vendor model traffic remains vendor-owned; MUON does not add a hop to
              it or read its contents.
            </P>
          </Callout>
          <Callout title="No telemetry upload">
            <P>
              MUON's telemetry module ships with a fixed provider of “none” — there is no uploader in
              the code at all. Events are spooled locally as a bounded, enum-only vocabulary with no
              free-text field, for local crash diagnostics and as an inspectable audit artifact.
            </P>
          </Callout>
        </div>
      </DocSection>

      <DocSection title="Two tokens, one gate">
        <P>
          Everything above rests on one separation: the operator token can govern (approve, confirm
          memory, resize the fleet); the agent token can only do (dispatch work, propose memory, read
          the graph). A UI surface never holds the raw operator token itself, and an MCP server —
          including one attached to a session you launched — can only ever present the agent tier.
          There is no code path where an agent-held credential decides a gate.
        </P>
      </DocSection>
    </DocsLayout>
  );
}

export default GovernanceDoc;
