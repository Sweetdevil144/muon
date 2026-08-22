import { spawn } from "node:child_process";
import type { GitNexusAnalyzeRunner } from "@muon/client/gitnexus-reindex";
import { resolveGitNexus } from "./brain-commit.js";

/**
 * ADR-0054 — the CLI's half of a reindex: how the subprocess is actually run.
 *
 * The DECISION (fence, drift, floor, single-flight, honest reporting) lives once
 * in `@muon/client/gitnexus-reindex`. This file is only the spawn, kept apart
 * because it is the part that differs per surface: the desktop detaches its
 * child and never waits, while a CLI invocation IS the wait.
 */

/**
 * How long one analyze may run before it is killed. Ten minutes, matching the
 * desktop supervisor's watchdog and the MCP refresh budget, because it bounds
 * the same work: a full rebuild of a large repository legitimately takes
 * minutes, and anything past this is a wedged child, not a slow one.
 */
export const ANALYZE_TIMEOUT_MS = 600_000;

/**
 * Stream the indexer's own progress to stderr, so a 27-second wait shows work
 * instead of a frozen prompt — and to STDERR specifically, so `--json` keeps a
 * parseable stdout. `inherit` rather than a pipe we re-print: GitNexus already
 * writes readable progress, and re-formatting it would be a second place for
 * its output to go stale.
 */
export function createAnalyzeRunner(options: {
  /** Show the indexer's output. False for `--json` and for tests. */
  verbose: boolean;
  resolveCli?: typeof resolveGitNexus;
}): GitNexusAnalyzeRunner | null {
  const cli = (options.resolveCli ?? resolveGitNexus)();
  if (!cli) return null;
  return ({ repoRoot, force }) =>
    new Promise<void>((resolvePromise, reject) => {
      const child = spawn(
        cli.binary,
        [
          ...cli.commandPrefix,
          "analyze",
          repoRoot,
          "--index-only",
          ...(force ? ["--force"] : []),
        ],
        {
          cwd: repoRoot,
          stdio: options.verbose ? ["ignore", "inherit", "inherit"] : "ignore",
          windowsHide: true,
          env: {
            ...process.env,
            // Hard rule: no new egress — never install an extension over the net.
            GITNEXUS_LBUG_EXTENSION_INSTALL: "load-only",
          },
        }
      );
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolvePromise();
      };
      const timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
        finish(
          new Error(
            `gitnexus analyze did not finish within ${Math.round(
              ANALYZE_TIMEOUT_MS / 1000
            )}s`
          )
        );
      }, ANALYZE_TIMEOUT_MS);
      child.on("error", (error) => finish(error));
      child.on("exit", (code, signal) => {
        if (code === 0) {
          finish();
          return;
        }
        finish(
          new Error(
            `gitnexus analyze exited (${
              code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`
            })`
          )
        );
      });
    });
}
