import type { Metadata } from "next";
import Link from "next/link";

import {
  Bullets,
  Callout,
  Code,
  CodeBlock,
  DocSection,
  DocsLayout,
  P,
  Steps,
} from "@/components/docs/DocsLayout";

const TITLE = "Quickstart — your first MUON mission";
const DESCRIPTION =
  "Open MUON, pick a workspace, connect a coding agent, run a real mission, watch the crew coordinate, and decide the approval gates it files.";

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


function QuickstartDoc() {
  return (
    <DocsLayout
      eyebrow="Quickstart"
      title="Your first mission"
      intro="This walks the same path the app's first-run wizard does: open MUON, pick a workspace, connect one coding agent, run a real mission, watch the crew work, and decide the gates it files. Nothing here is destructive — MUON's seeded first task only adds files."
    >
      <DocSection title="Run the loop">
        <Steps
          items={[
            {
              title: "Open the app and pick a workspace",
              body: (
                <P>
                  Launch MUON (see{" "}
                  <Link href="/docs/install" className="text-foreground underline underline-offset-4">
                    Install
                  </Link>{" "}
                  if you haven't yet) and choose the folder you want the crew to work in. Memory,
                  blast-radius and every path in the run are scoped to it.
                </P>
              ),
            },
            {
              title: "Connect a vendor",
              body: (
                <>
                  <P>
                    The first-run wizard checks Claude Code, Codex, Cursor and OpenCode separately
                    for installed vs. authenticated, and gives one concrete next action for
                    whichever is missing. You never hand MUON a token — you log in to the vendor's
                    own CLI, and MUON only observes readiness.
                  </P>
                  <CodeBlock>muon onboard</CodeBlock>
                </>
              ),
            },
            {
              title: "Run a mission chat",
              body: (
                <>
                  <P>
                    Type what you want done into the chat. MUON's orchestrator plans the work,
                    dispatches it to the fleet, and reports back — the gates stay yours. No task in
                    mind? MUON can seed a tiny, safe sample so you can watch the whole loop.
                  </P>
                  <CodeBlock>{`muon quickstart                 # seed + dispatch a safe sample task
muon chat --workspace <dir>     # or start a real mission yourself`}</CodeBlock>
                </>
              ),
            },
            {
              title: "Watch the crew",
              body: (
                <>
                  <P>
                    Open the desktop's Crew Topology tab (⌘K → “Open crew topology”) to see who is
                    doing what: one node per vendor lane, subagents nested under their parent, and
                    peer edges only where two jobs actually exchanged an addressed message.
                  </P>
                  <CodeBlock>{`muon crew roles --chat <id>     # who holds which role, and why
muon crew coord --chat <id>     # peer messages, file claims, conflicts
muon dispatch status            # active jobs across the fleet`}</CodeBlock>
                  <P>
                    Peer messages render as explicit “Agent text · untrusted” — another agent's
                    words are evidence, never an instruction, and never something that can approve
                    or dispatch on its own.
                  </P>
                </>
              ),
            },
            {
              title: "See the pre-edit view",
              body: (
                <>
                  <P>
                    Before an agent edits a target, MUON fuses its code blast-radius with the
                    human-confirmed memory anchored to it — prior decisions, contested proposals,
                    and live cross-agent activity on the same target.
                  </P>
                  <CodeBlock>muon context muon-hello.ts   # or any symbol / file / module path</CodeBlock>
                  <P>
                    Trusted decisions show their full text. Contested proposals show existence-only
                    until you explicitly ask to read them — an unvetted note can never reach an
                    agent as if it were settled fact.
                  </P>
                </>
              ),
            },
            {
              title: "Approve, review, merge",
              body: (
                <>
                  <P>
                    When an agent needs to cross a boundary — an edit outside the expected surface,
                    a network call, a merge — MUON files a gate and waits. A merge gate is
                    graph-certified when possible: MUON reviews the diff itself and either certifies
                    it or marks specific files REVIEW BLIND for a human read.
                  </P>
                  <CodeBlock>{`muon approve list
muon approve review --approval-id <id>     # artifact digest + blind files
muon approve resolve --approval-id <id> --status approved`}</CodeBlock>
                </>
              ),
            },
          ]}
        />
      </DocSection>

      <DocSection title="Honest about full-auto">
        <P>
          The desktop sidebar's full-auto panel turns red when armed — that color is deliberate: it
          is disabling a gate, and MUON wants that visible at a glance, not buried in settings.
        </P>
        <Bullets
          items={[
            <>
              <strong className="text-foreground">Off (default):</strong> every approval waits for
              you.
            </>,
            <>
              <strong className="text-foreground">Armed, all lanes:</strong> approvals resolve
              automatically. Egress and blocked merge reviews still ask.
            </>,
            <>
              <strong className="text-foreground">Armed, a subset of lanes:</strong> checked lanes
              approve automatically; everything else still asks. A request MUON cannot attribute to
              a lane is never covered by a partial selection.
            </>,
          ]}
        />
        <Callout title="Standing consent, not a bypass">
          <P>
            Every auto-approval goes through the same approval path a manual click uses and leaves a
            named receipt in the audit trail — the exact command or scope approved, redacted of
            secrets, with its risk level. See{" "}
            <Link href="/docs/governance" className="text-foreground underline underline-offset-4">
              Governance
            </Link>{" "}
            for what full-auto can never cover.
          </P>
        </Callout>
      </DocSection>
    </DocsLayout>
  );
}

export default QuickstartDoc;
