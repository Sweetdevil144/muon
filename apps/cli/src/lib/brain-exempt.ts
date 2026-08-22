import type { Command } from "commander";

/**
 * WHICH COMMANDS RUN WITHOUT A BRAIN.
 *
 * `muon` auto-spawns the embedded brain in its `preAction` hook so the CLI
 * "just works" with no server to start. For a command that never calls the
 * brain, that boot is not merely wasted: it is the first thing the person sees
 * go wrong. A tarball-only machine (the Linux path `public/install.sh`
 * describes, where no desktop exists to host a brain) would open
 * `muon docs query` with `muon: <note>` about a brain failure that has nothing
 * to do with reading documentation.
 *
 * This decision used to be a loop written inline in the hook, which is the one
 * shape that cannot be unit-tested — the hook ends in `process.exit` and a
 * spawn. Extracted for the same reason the identity gate's exempt list was:
 * a POSITIVE set exercised against a real command tree beats a claim in a
 * comment.
 */

/**
 * A POSITIVE set (ADR-0022): absent means "needs the brain". Each member reads
 * or writes only local state, so each must keep working with no brain running.
 *
 *  - `version` — local package, git and GitNexus metadata.
 *  - `custom-agents` — a local JSON file (`custom-agents-store.ts`).
 *  - `shutdown` — the OFF switch; spawning a brain to kill it is absurd, and
 *    "no live brain" is one of its honest answers.
 *  - `graph` — ADR-0054; reads and rewrites `<repo>/.gitnexus` under a file
 *    lock. The machine whose graph is stale is often the machine with no brain,
 *    and `graph status` has to answer there.
 *  - `docs` — ADR-0053; reads the repository's markdown in process.
 *  - `uninstall` — removes this CLI and stops a running brain on the way out.
 *  - `setup` — the first command a new user runs; vendor config plus the
 *    enrolment record, both local files.
 */
export const BRAIN_EXEMPT_COMMANDS: ReadonlySet<string> = new Set([
  "version",
  "custom-agents",
  "shutdown",
  "graph",
  "docs",
  "uninstall",
  "setup",
]);

/**
 * `mcp` is the one family that splits. ADR-0028 Tier C: `attach` mints a real
 * dispatch job and `detach` revokes one, so those two need a live brain. Every
 * other `mcp` subcommand is exempt — and for `status`/`probe` that is
 * load-bearing rather than an optimisation, because they REPORT whether a brain
 * is running. Auto-spawning one first would make the command change the exact
 * state it exists to diagnose, and a user with a dead brain would be told
 * everything is fine.
 */
export const MCP_SUBCOMMANDS_NEEDING_BRAIN: ReadonlySet<string> = new Set([
  "attach",
  "detach",
]);

/**
 * Does this invocation need the embedded brain spawned before it runs?
 *
 * Walks the command's own ancestry, so `muon docs query` is exempt through its
 * `docs` parent without every subcommand having to be enumerated.
 */
export function commandNeedsBrain(actionCommand: Command): boolean {
  for (
    let cmd: Command | null | undefined = actionCommand;
    cmd;
    cmd = cmd.parent
  ) {
    const name = cmd.name();
    if (BRAIN_EXEMPT_COMMANDS.has(name)) return false;
    if (name === "mcp") {
      return MCP_SUBCOMMANDS_NEEDING_BRAIN.has(actionCommand.name());
    }
  }
  return true;
}
