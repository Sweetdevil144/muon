import type { Command } from "commander";
import {
  probeGitNexusIndexFreshness,
  type GitNexusIndexFreshness,
} from "@muon/client/gitnexus-freshness";
import {
  reindexCodeGraph,
  resolvePrimaryCheckout,
  type GitNexusReindexOutcome,
} from "@muon/client/gitnexus-reindex";
import { createAnalyzeRunner } from "../lib/gitnexus-analyze.js";
import { printJson } from "../lib/output.js";
import { failCommand } from "../lib/refusal.js";

/**
 * ADR-0054 — the local code graph, from the terminal.
 *
 * Until now the ONLY surface that could refresh a stale GitNexus index was the
 * desktop app: its supervisor watches HEAD, debounces, and offers a Re-index
 * button. A CLI/TUI-only operator had none of it — the graph went stale on their
 * first commit and stayed stale, and every brain tool degraded quietly (impact
 * answers from old line numbers, `review_diff` REVIEW-BLIND) with no local
 * gesture to fix it. This is that gesture.
 *
 * Client-free and brain-free, like `muon docs` and `muon version`: the store is
 * a directory in the working tree, so this answers on a machine with no MUON
 * server running — which is exactly the machine whose graph is most likely
 * stale.
 *
 * CROSS-SURFACE PARITY. The decision (worktree fence → drift check → interval
 * floor → cross-process single-flight → honest reporting) is
 * `@muon/client/gitnexus-reindex`, the same module a TUI verb will call, taking
 * the SAME cross-process lock the desktop supervisor and the MCP server take.
 * So all three exclude each other, and this command can never become a second
 * indexer racing the first. `--json` prints the coordinator's own outcome
 * verbatim and the human lines are composed FROM it, never beside it.
 */

type SharedOptions = { workspace?: string; json?: boolean };

function write(lines: string[]): void {
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** Where the operator is standing, without resolving a repo — the coordinator
 *  owns that, because refusing a worktree is part of the same decision. */
function startDir(options: SharedOptions): string {
  return options.workspace ?? process.cwd();
}

/**
 * The store's own words for one freshness value. `missing` is never softened to
 * "unknown": no readable index means graph-backed claims are unavailable, which
 * is a different instruction to the reader than "the graph is behind".
 */
function renderFreshness(freshness: GitNexusIndexFreshness): string[] {
  const lines: string[] = [];
  lines.push(
    `index: ${
      freshness.status === "fresh"
        ? "at HEAD"
        : freshness.status === "stale"
          ? "BEHIND HEAD"
          : "not readable"
    }`
  );
  if (freshness.indexedCommit) {
    lines.push(`indexed commit: ${freshness.indexedCommit.slice(0, 12)}`);
  }
  if (freshness.headCommit) {
    lines.push(`HEAD: ${freshness.headCommit.slice(0, 12)}`);
  }
  if (freshness.indexedAt) lines.push(`indexed at: ${freshness.indexedAt}`);
  if (freshness.stats) {
    const shape = [
      freshness.stats.files === undefined
        ? undefined
        : `${freshness.stats.files} files`,
      freshness.stats.nodes === undefined
        ? undefined
        : `${freshness.stats.nodes} symbols`,
      freshness.stats.processes === undefined
        ? undefined
        : `${freshness.stats.processes} flows`,
    ].filter((part): part is string => part !== undefined);
    if (shape.length > 0) lines.push(`graph: ${shape.join(" · ")}`);
  }
  // The in-flight line comes LAST and reads as an instruction, because it
  // changes what the reader should do about every line above it.
  if (freshness.rebuild) {
    const who = freshness.rebuild.owner ?? "another MUON process";
    const since = freshness.rebuild.startedAt
      ? ` since ${freshness.rebuild.startedAt}`
      : "";
    lines.push(
      `rebuilding now: ${who}${since} — wait for it; a second run would race it`
    );
  }
  return lines;
}

/** The human rendering of an outcome, composed from the payload `--json` prints. */
function renderOutcome(outcome: GitNexusReindexOutcome): string[] {
  const lines: string[] = [];
  if (outcome.repoRoot) lines.push(`repository: ${outcome.repoRoot}`);
  lines.push(
    outcome.status === "reindexed"
      ? outcome.forced
        ? "rebuilt from scratch"
        : "updated incrementally"
      : outcome.status === "failed"
        ? "FAILED"
        : `skipped (${outcome.skip})`
  );
  lines.push(outcome.note);
  if (outcome.status !== "skipped") {
    lines.push("", ...renderFreshness(outcome.after));
  } else if (outcome.before) {
    lines.push("", ...renderFreshness(outcome.before));
  }
  return lines;
}

/**
 * Which skips and failures are worth a non-zero exit.
 *
 * A skip is USUALLY success: "already at HEAD" and "cooling down" are the
 * automatic path working. But `already-running`, `lock-unavailable` and
 * `cli-missing` mean the caller's request was NOT served, and a script that
 * treats them as done would go on to trust a graph nobody refreshed. Exit 1
 * says "not served", which is the honest answer, and a failed run says it too.
 */
export function exitCodeForOutcome(outcome: GitNexusReindexOutcome): number {
  if (outcome.status === "failed") return 1;
  if (outcome.status === "reindexed") {
    // Ran clean but the store is still not at HEAD: reporting 0 here would let a
    // pipeline treat an unmoved graph as a refreshed one.
    return outcome.after.status === "fresh" ? 0 : 1;
  }
  return outcome.skip === "already-fresh" || outcome.skip === "cooling-down"
    ? 0
    : 1;
}

export type GraphCommandDependencies = {
  readFreshness?: (repoRoot: string) => Promise<GitNexusIndexFreshness>;
  reindex?: typeof reindexCodeGraph;
  createRunner?: typeof createAnalyzeRunner;
  resolveCheckout?: typeof resolvePrimaryCheckout;
};

export function registerGraphCommands(
  program: Command,
  dependencies: GraphCommandDependencies = {}
): void {
  const readFreshness = dependencies.readFreshness ?? probeGitNexusIndexFreshness;
  const reindex = dependencies.reindex ?? reindexCodeGraph;
  const createRunner = dependencies.createRunner ?? createAnalyzeRunner;
  const resolveCheckout = dependencies.resolveCheckout ?? resolvePrimaryCheckout;

  const graph = program
    .command("graph")
    .description(
      "The local GitNexus code graph this workspace's brain tools answer from (ADR-0054): is it current, and refresh it when it is not"
    );

  const shared = <T extends Command>(command: T): T => {
    command.option("--workspace <dir>", "Repository (default: cwd)");
    command.option("--json", "Print as JSON");
    return command;
  };

  shared(
    graph
      .command("status")
      .description(
        "Is the code graph at the current commit — and is MUON rebuilding it right now"
      )
  ).action(async (options: SharedOptions) => {
    try {
      // The SAME resolver the reindex uses, but a READ answers about the primary
      // rather than refusing. Reading a worktree's own store would report a graph
      // nothing queries; reading the PRIMARY's is the correct answer to "is the
      // graph that answers for this code current", and every governed run happens
      // in a worktree — the MCP resolves the primary for exactly this reason
      // (`primaryRepoRoot` in gitnexus-tools.ts). The substitution is never
      // silent: the `repository:` line names the root that was read.
      //
      // `reindex` still REFUSES, because redirecting a minutes-long,
      // store-rewriting operation to a repository the caller did not name is a
      // different act from answering a question about one.
      const checkout = await resolveCheckout(startDir(options));
      // Present on BOTH arms: `ok` carries the primary it resolved, and a
      // worktree refusal carries the primary it names in its own note.
      const repoRoot: string | undefined = checkout.repoRoot;
      if (!repoRoot) {
        if (options.json) {
          printJson({
            skip: checkout.ok ? "no-repo" : checkout.skip,
            note: checkout.ok ? "No git repository here." : checkout.note,
          });
          process.exitCode = 1;
          return;
        }
        failCommand(
          new Error(checkout.ok ? "No git repository here." : checkout.note),
          "Cannot read the code graph here."
        );
        return;
      }
      const freshness = await readFreshness(repoRoot);
      if (options.json) {
        printJson({
          repoRoot,
          ...(checkout.ok ? {} : { askedAboutWorktree: true }),
          freshness,
        });
        return;
      }
      write([
        `repository: ${repoRoot}`,
        ...(checkout.ok
          ? []
          : [
              "(you are in a governed worktree; this is the primary checkout's graph — the one every brain tool reads)",
            ]),
        ...renderFreshness(freshness),
      ]);
    } catch (error) {
      failCommand(error, "Failed to read the code graph status.");
    }
  });

  shared(
    graph
      .command("reindex")
      .description(
        "Bring the code graph up to the current commit. Single-flight across every MUON process; refuses rather than racing one already running"
      )
      .option(
        "--if-stale",
        "Only run when the graph is actually behind HEAD, and honour the 5-minute floor between automatic runs (the shape a hook or a cron wants)"
      )
      .option("--force", "Rebuild from scratch instead of an incremental pass")
  ).action(
    async (
      options: SharedOptions & { ifStale?: boolean; force?: boolean }
    ) => {
      try {
        const runner = createRunner({
          // Never to stdout when `--json` is on: the payload must stay
          // parseable byte-for-byte.
          verbose: options.json !== true,
        });
        const outcome = await reindex(
          {
            workspacePath: startDir(options),
            // `--if-stale` IS the automatic policy, named for what the caller
            // wants rather than for our internal word. Without it a human
            // typed this, so both the drift check and the floor step aside.
            trigger: options.ifStale === true ? "auto" : "manual",
            ...(options.force === true ? { force: true } : {}),
          },
          { runAnalyze: runner }
        );
        if (options.json) {
          printJson(outcome);
        } else {
          write(renderOutcome(outcome));
        }
        const code = exitCodeForOutcome(outcome);
        if (code !== 0) process.exitCode = code;
      } catch (error) {
        failCommand(error, "Failed to re-index the code graph.");
      }
    }
  );
}

