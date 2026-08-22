import type { Metadata } from "next";
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

const TITLE = "Troubleshooting MUON — doctor, stale index, logs, reset";
const DESCRIPTION =
  "Fix a vendor CLI that reads as missing or logged out, a stale code index, a brain that isn't running, and learn where MUON's local logs and data live.";

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


function TroubleshootingDoc() {
  return (
    <DocsLayout
      eyebrow="Troubleshooting"
      title="When something looks wrong"
      intro="Start with muon doctor (machine-readable JSON, safe to script against) or muon onboard (the human-guided version). Both are read-only diagnostics and never reject on a degraded environment — every source that can't be read degrades to an honest “unknown” with a reason instead of a crash."
    >
      <CodeBlock>{`muon doctor --json     # scriptable capability preflight
muon onboard           # guided, human-readable checklist`}</CodeBlock>

      <DocSection title="A vendor CLI isn't found, or reads as logged out">
        <P>
          MUON checks two things separately per vendor — installed and authenticated — and both{" "}
          <Code>muon doctor</Code> and <Code>muon onboard</Code> name which one is missing rather
          than a generic “not ready.”
        </P>
        <DocTable
          head={["Vendor", "Reinstall", "Re-authenticate"]}
          rows={[
            ["Claude Code", <Code>npm i -g @anthropic-ai/claude-code</Code>, <>run <Code>claude</Code>, sign in</>],
            ["Codex", <Code>npm i -g @openai/codex</Code>, <Code>codex login</Code>],
            ["Cursor", <Code>curl https://cursor.com/install -fsS | bash</Code>, <Code>cursor-agent login</Code>],
            ["OpenCode", <Code>curl -fsSL https://opencode.ai/install | bash</Code>, <Code>opencode auth login</Code>],
          ]}
        />
        <Callout tone="warn" title="Codex with a custom provider">
          <P>
            If <Code>~/.codex/config.toml</Code> selects a custom <Code>model_provider</Code> (e.g.
            Azure), MUON requires the exact <Code>env_key</Code> that provider declares — a cached
            native login does not authenticate a different selected provider. Set the provider's key
            in your shell environment (never a repository file) and launch MUON from a shell that
            has it, or switch back to a built-in provider and run <Code>codex login</Code>.
          </P>
        </Callout>
        <P>
          Each lane holds the roles it is best at, by design: Cursor takes review-class roles with a
          no-writes guarantee, and OpenCode scouts. If a dispatch is refused for a role, that is the
          role model working, not a fault.
        </P>
      </DocSection>

      <DocSection title="The code index looks stale">
        <P>
          MUON's embedded code graph indexes your workspace in the background as you commit. Check
          whether it has fallen behind HEAD:
        </P>
        <CodeBlock>muon version</CodeBlock>
        <P>
          The JSON includes <Code>brainCommit</Code> (what the graph is indexed at),{" "}
          <Code>headCommit</Code> (your actual HEAD) and <Code>stale</Code> (whether they disagree).
        </P>
        <Bullets
          items={[
            "In the desktop app, open the graph/code panel and use Re-index — it's disabled while an index is already running, since indexing is exclusive per repository.",
            <>
              The MCP server opportunistically refreshes freshness on certain reads (
              <Code>code_impact</Code>), so a short lag often clears on its own.
            </>,
            "A stale index degrades gracefully rather than lying: the orchestrator treats a stale or unindexed file as review-blind and routes it to a human rather than certifying a diff it can't see.",
          ]}
        />
      </DocSection>

      <DocSection title="The brain doesn't seem to be running">
        <P>
          “The brain” is MUON's embedded local backend. The desktop app supervises its own; the CLI
          auto-spawns one on first use for every command except <Code>version</Code>,{" "}
          <Code>shutdown</Code>, <Code>custom-agents</Code> and most <Code>mcp</Code> subcommands,
          which are deliberately brain-independent.
        </P>
        <CodeBlock>{`muon doctor          # reports connectivity honestly, even if the brain is down
muon mcp status      # whether a brain is running, and its port/pid
muon shutdown        # stop the CLI-spawned brain + runner cleanly
muon chat            # any ordinary command re-spawns one if none is found`}</CodeBlock>
        <P>
          If the desktop app and a CLI-spawned brain both start, MUON detects and adopts the
          already-running one rather than starting a second — <Code>muon doctor</Code> tells you
          which profile you're actually talking to.
        </P>
      </DocSection>

      <DocSection title="Where logs live">
        <DocTable
          head={["Path", "What"]}
          rows={[
            [<Code>…/MUON/logs/brain.log</Code>, "Embedded backend log"],
            [<Code>…/MUON/logs/runner.log</Code>, "Sandboxed runner boot, lease, dispatch and recovery log"],
            [
              <Code>~/Library/Application Support/MUON/</Code>,
              "Everything else MUON persists locally — settings, the embedded SQLite brain, the graph store, the lockfile",
            ],
          ]}
        />
      </DocSection>

      <DocSection title="How to reset">
        <Steps
          items={[
            {
              title: "Stop everything cleanly first",
              body: (
                <P>
                  Quit the desktop app, then run <Code>muon shutdown</Code> to stop any CLI-spawned
                  brain and runner. Confirm nothing is left with <Code>muon doctor</Code>.
                </P>
              ),
            },
            {
              title: "Wipe local state",
              body: (
                <>
                  <P>
                    Delete <Code>~/Library/Application Support/MUON/</Code>. This removes the
                    embedded brain, the graph store, the lockfile and settings — including
                    unconfirmed memory proposals. Export first with{" "}
                    <Code>muon memory pack export --out &lt;dir&gt;</Code> if you want confirmed
                    decisions back afterwards.
                  </P>
                  <P>
                    Removing the data directory by hand is the current reset path — there is no{" "}
                    <Code>muon reset</Code> command in v1.
                  </P>
                </>
              ),
            },
            {
              title: "Relaunch",
              body: (
                <P>
                  Reopen the app or run any <Code>muon</Code> command; MUON reinitializes a fresh
                  brain and re-indexes the workspace the next time it needs to.
                </P>
              ),
            },
          ]}
        />
      </DocSection>

      <DocSection title="Still stuck?">
        <P>
          Send a mail with your <Code>muon doctor --json</Code> output attached — it never includes a
          credential value, only readiness booleans and reasons — to{" "}
          <a
            href="mailto:abhinavpandey1230@gmail.com"
            className="text-foreground underline underline-offset-4"
          >
            abhinavpandey1230@gmail.com
          </a>
          .
        </P>
      </DocSection>
    </DocsLayout>
  );
}

export default TroubleshootingDoc;
