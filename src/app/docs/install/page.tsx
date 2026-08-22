import type { Metadata } from "next";
import Link from "next/link";

import {
  Bullets,
  Callout,
  Code,
  CodeBlock,
  DocSection,
  DocTable,
  DocsLayout,
  P,
  Steps,
} from "@/components/docs/DocsLayout";

const TITLE = "Install MUON on macOS — docs";
const DESCRIPTION =
  "Requirements, the macOS app download, the unsigned first-launch step, installing the muon CLI and TUI, auto-update, and where MUON stores data.";

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


function InstallDoc() {
  return (
    <DocsLayout
      eyebrow="Install"
      title="Install MUON on macOS"
      intro="MUON ships as a native macOS app (Apple silicon) that hosts its own local backend and background runner — there is nothing else to start. The v1 build is unsigned, so the first launch needs one extra step past Gatekeeper."
    >
      <DocSection title="Requirements">
        <Bullets
          items={[
            <>
              <strong className="text-foreground">macOS on Apple silicon (arm64).</strong>{" "}
              Intel/universal builds are a follow-up, not available in v1.
            </>,
            <>
              <strong className="text-foreground">git</strong> installed and on your{" "}
              <Code>PATH</Code>. MUON works on git workspaces and shells out for identity, diffs and
              merges.
            </>,
            <>
              <strong className="text-foreground">At least one coding-agent CLI</strong> installed
              and logged in. MUON drives your own agents; it never ships or authenticates one for
              you.
            </>,
          ]}
        />
        <DocTable
          head={["Agent", "Install", "Log in (you run this)"]}
          rows={[
            ["Claude Code", <Code>npm i -g @anthropic-ai/claude-code</Code>, <>run <Code>claude</Code> and sign in</>],
            ["Codex", <Code>npm i -g @openai/codex</Code>, <Code>codex login</Code>],
            ["Cursor", <Code>curl https://cursor.com/install -fsS | bash</Code>, <Code>cursor-agent login</Code>],
            ["OpenCode", <Code>curl -fsSL https://opencode.ai/install | bash</Code>, <Code>opencode auth login</Code>],
          ]}
        />
        <Callout title="Each lane plays its strongest position">
          <P>
            Claude Code and Codex build, lead, and hold the coordinator seat. Cursor runs
            review-class roles (reviewer, QA, architect, scout) with a guarantee attached: it reads
            and judges, and your workspace stays untouched. OpenCode is the crew's scout, and MUON
            forwards it no credential at all.
          </P>
        </Callout>
      </DocSection>

      <DocSection title="Get the app">
        <P>
          Download the app from the{" "}
          <Link href="/download" className="text-foreground underline underline-offset-4">
            download page
          </Link>
          : grab <Code>MUON-&lt;version&gt;-arm64.dmg</Code>, open it, and drag MUON into
          Applications. Every artifact ships with a published SHA-256 checksum (
          <Code>SHA256SUMS</Code>) so you can verify what you got before you open it.
        </P>
      </DocSection>

      <DocSection title="First launch: getting past Gatekeeper">
        <P>
          Because the v1 build carries no Developer ID signature, macOS blocks the very first launch
          and calls MUON an app from an “unidentified developer.” You only do this once.
        </P>
        <Steps
          items={[
            {
              title: "Right-click → Open",
              body: (
                <P>
                  In Finder, Control-click (or right-click) <Code>MUON.app</Code> and choose Open,
                  then confirm Open in the dialog. A plain double-click only offers “Move to Trash”
                  on an unsigned app.
                </P>
              ),
            },
            {
              title: "Or: System Settings → Privacy & Security",
              body: (
                <P>
                  On newer macOS, after a blocked double-click, open System Settings → Privacy &
                  Security, scroll to the “MUON was blocked” notice, and click Open Anyway.
                </P>
              ),
            },
            {
              title: "Or: clear the quarantine flag from the Terminal",
              body: (
                <>
                  <CodeBlock>xattr -dr com.apple.quarantine /Applications/MUON.app</CodeBlock>
                  <P>
                    This is the standard macOS mechanism for an unsigned app you trust — the same
                    thing “Open Anyway” does. Run it once, after the app is in{" "}
                    <Code>/Applications</Code>.
                  </P>
                </>
              ),
            },
          ]}
        />
      </DocSection>

      <DocSection title="Install the CLI and TUI">
        <P>The terminal surfaces install with one command (requires Node 20+ and npm on your PATH):</P>
        <CodeBlock>curl -fsSL https://getmuon.com/install.sh | bash</CodeBlock>
        <P>
          That installs <Code>muon</Code> (the CLI — it auto-starts the local brain on first use, so
          there is no server to run) and <Code>muon-tui</Code> (the full-screen terminal cockpit).
          The desktop app ships the brain itself, so install it first; the CLI finds it whether or
          not the app is running. To register MUON as an MCP server with your own coding agent, run{" "}
          <Code>muon mcp install</Code> afterwards — see the{" "}
          <Link href="/docs/cli" className="text-foreground underline underline-offset-4">
            CLI reference
          </Link>{" "}
          and the{" "}
          <Link href="/docs/mcp" className="text-foreground underline underline-offset-4">
            MCP guide
          </Link>
          .
        </P>
      </DocSection>

      <DocSection title="“Unsigned” — why, and is it safe?">
        <P>
          MUON's v1 build is not signed with an Apple Developer ID certificate and is not notarized.
          Treat it as a controlled build, not (yet) a certificate-verified one.
        </P>
        <Bullets
          items={[
            <>
              <strong className="text-foreground">Why:</strong> Developer ID signing requires an
              active Apple Developer Program membership; the entitlements, notarization hook and
              config seam already exist so it can flip on later with no rework.
            </>,
            <>
              <strong className="text-foreground">What it means for you:</strong> macOS quarantines
              and warns on first launch. There is no other behavioral difference — MUON still runs
              entirely on your machine.
            </>,
            <>
              <strong className="text-foreground">How to trust the build:</strong> every release
              ships a published <Code>SHA256SUMS</Code> file next to the download — verify the DMG's
              checksum before opening it.
            </>,
          ]}
        />
      </DocSection>

      <DocSection title="Auto-update">
        <P>
          MUON makes no outbound network calls on its own, with exactly one opt-in exception: an
          update check against MUON's release feed, toggled from the sidebar's Updates panel (off by
          default).
        </P>
        <Callout tone="warn" title="v1 limitation: check-only">
          <P>
            An unsigned build can tell you a newer release exists; it cannot download or install it
            for you. The updater's install path stays refused until a signed, notarized build has
            been verified through a real two-version upgrade — a deliberate release gate, not a
            missing feature.
          </P>
        </Callout>
      </DocSection>

      <DocSection title="Where MUON stores data">
        <DocTable
          head={["Path", "What"]}
          rows={[
            [<Code>~/Library/Application Support/MUON/</Code>, "Settings, the embedded SQLite brain, the graph store, the lockfile"],
            [<Code>…/MUON/logs/brain.log</Code>, "Embedded backend log"],
            [<Code>…/MUON/logs/runner.log</Code>, "Sandboxed runner boot, lease, dispatch and recovery log"],
          ]}
        />
        <P>
          Uninstalling: delete <Code>MUON.app</Code>. Clearing the data directory is a manual step
          today.
        </P>
      </DocSection>
    </DocsLayout>
  );
}

export default InstallDoc;
