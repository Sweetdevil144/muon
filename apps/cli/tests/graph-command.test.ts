import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitNexusIndexFreshness } from "@muon/client/gitnexus-freshness";
import type {
  GitNexusReindexInput,
  GitNexusReindexOutcome,
  PrimaryCheckoutResolution,
} from "@muon/client/gitnexus-reindex";
import {
  exitCodeForOutcome,
  registerGraphCommands,
  type GraphCommandDependencies,
} from "../src/commands/graph.js";

// ADR-0054 — `muon graph` from the outside: what a person and a script SEE.
//
// Dependency-injected like `version.test.ts`, and deliberately never spawning
// `gitnexus`: a real index run is ~27s. What is asserted is the OUTPUT, because
// the honesty rules in this feature live in the copy — a refusal must not render
// as progress, and a run that did not reach HEAD must not exit 0.

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const REPO = "/src/app";

const primary: PrimaryCheckoutResolution = { ok: true, repoRoot: REPO };

async function run(
  argv: string[],
  dependencies: GraphCommandDependencies
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  process.exitCode = 0;
  const program = new Command();
  program.exitOverride();
  registerGraphCommands(program, dependencies);
  await program.parseAsync(["graph", ...argv], { from: "user" });
  const text = (spy: typeof out): string =>
    spy.mock.calls.map((call) => String(call[0])).join("");
  return { stdout: text(out), stderr: text(err), exitCode: process.exitCode };
}

/** A reindex stub that records the input the command composed. */
function stubReindex(outcome: GitNexusReindexOutcome): {
  reindex: GraphCommandDependencies["reindex"];
  inputs: GitNexusReindexInput[];
} {
  const inputs: GitNexusReindexInput[] = [];
  return {
    inputs,
    reindex: async (input) => {
      inputs.push(input);
      return outcome;
    },
  };
}

const noRunner: GraphCommandDependencies["createRunner"] = () => async () => {};

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe("muon graph status", () => {
  it("reports a fresh index with its shape", async () => {
    const freshness: GitNexusIndexFreshness = {
      status: "fresh",
      indexedCommit: HEAD,
      headCommit: HEAD,
      indexedAt: "2026-08-17T12:00:00.000Z",
      stats: { files: 1879, nodes: 23228, processes: 300 },
    };
    const { stdout, exitCode } = await run(["status"], {
      resolveCheckout: async () => primary,
      readFreshness: async () => freshness,
    });
    expect(stdout).toContain("repository: /src/app");
    expect(stdout).toContain("index: at HEAD");
    expect(stdout).toContain("23228 symbols");
    expect(exitCode).toBe(0);
  });

  it("says BEHIND HEAD for a stale index — never a bare 'ready'", async () => {
    const { stdout } = await run(["status"], {
      resolveCheckout: async () => primary,
      readFreshness: async () => ({
        status: "stale",
        indexedCommit: OLD,
        headCommit: HEAD,
      }),
    });
    expect(stdout).toContain("index: BEHIND HEAD");
  });

  it("surfaces a rebuild in flight as an instruction, and it comes last", async () => {
    const { stdout } = await run(["status"], {
      resolveCheckout: async () => primary,
      readFreshness: async () => ({
        status: "stale",
        indexedCommit: OLD,
        headCommit: HEAD,
        rebuild: { owner: "desktop", startedAt: "2026-08-17T12:00:00.000Z" },
      }),
    });
    expect(stdout).toContain("rebuilding now: desktop");
    expect(stdout).toContain("a second run would race it");
    expect(stdout.trimEnd().split("\n").pop()).toContain("rebuilding now");
  });

  it("--json prints the payload verbatim, and the human lines come from it", async () => {
    const freshness: GitNexusIndexFreshness = {
      status: "stale",
      indexedCommit: OLD,
      headCommit: HEAD,
    };
    const deps: GraphCommandDependencies = {
      resolveCheckout: async () => primary,
      readFreshness: async () => freshness,
    };
    const { stdout } = await run(["status", "--json"], deps);
    expect(JSON.parse(stdout)).toEqual({ repoRoot: REPO, freshness });
  });

  it("from a governed worktree, answers about the PRIMARY and says it did", async () => {
    // A READ substitutes rather than refusing: every governed run happens in a
    // worktree, the primary's store is the one every brain tool reads, and the
    // MCP already resolves the primary for exactly this reason. The substitution
    // is visible — never a silent answer about a different root.
    const asked: string[] = [];
    const { stdout, exitCode } = await run(["status"], {
      resolveCheckout: async () => ({
        ok: false,
        skip: "governed-worktree",
        repoRoot: REPO,
        note: `That path is a governed worktree, not the primary checkout. Use the primary checkout instead: ${REPO}`,
      }),
      readFreshness: async (root) => {
        asked.push(root);
        return { status: "fresh", indexedCommit: HEAD, headCommit: HEAD };
      },
    });
    expect(asked).toEqual([REPO]);
    expect(stdout).toContain(`repository: ${REPO}`);
    expect(stdout).toContain("governed worktree");
    expect(stdout).toContain("index: at HEAD");
    expect(exitCode).toBe(0);
  });

  it("--json marks the worktree substitution as a field, not only as prose", async () => {
    const { stdout } = await run(["status", "--json"], {
      resolveCheckout: async () => ({
        ok: false,
        skip: "governed-worktree",
        repoRoot: REPO,
        note: "worktree",
      }),
      readFreshness: async () => ({
        status: "fresh",
        indexedCommit: HEAD,
        headCommit: HEAD,
      }),
    });
    const payload = JSON.parse(stdout) as Record<string, unknown>;
    expect(payload.repoRoot).toBe(REPO);
    expect(payload.askedAboutWorktree).toBe(true);
  });

  it("exits 1 with no repository at all — never invents a root", async () => {
    const { stderr, stdout, exitCode } = await run(["status"], {
      resolveCheckout: async () => ({
        ok: false,
        skip: "no-repo",
        note: "No git repository here to index.",
      }),
      readFreshness: async () => {
        throw new Error("must not read anything");
      },
    });
    expect(stdout).toBe("");
    expect(stderr).toContain("No git repository");
    expect(exitCode).toBe(1);
  });
});

describe("muon graph reindex", () => {
  const reindexed = (
    after: GitNexusIndexFreshness,
    forced = false
  ): GitNexusReindexOutcome => ({
    status: "reindexed",
    repoRoot: REPO,
    forced,
    before: { status: "stale", indexedCommit: OLD, headCommit: HEAD },
    after,
    elapsedMs: 27_000,
    note: "Updated the code graph in 27s. It is now at the current commit.",
  });

  it("without --if-stale it is a MANUAL run: no drift check, no floor", async () => {
    const { reindex, inputs } = stubReindex(
      reindexed({ status: "fresh", indexedCommit: HEAD, headCommit: HEAD })
    );
    const { exitCode } = await run(["reindex"], {
      reindex,
      createRunner: noRunner,
    });
    expect(inputs[0]?.trigger).toBe("manual");
    expect(inputs[0]?.force).toBeUndefined();
    expect(exitCode).toBe(0);
  });

  it("--if-stale is the AUTOMATIC policy", async () => {
    const { reindex, inputs } = stubReindex({
      status: "skipped",
      skip: "already-fresh",
      repoRoot: REPO,
      before: { status: "fresh", indexedCommit: HEAD, headCommit: HEAD },
      note: "The code graph is already at the current commit.",
    });
    const { stdout, exitCode } = await run(["reindex", "--if-stale"], {
      reindex,
      createRunner: noRunner,
    });
    expect(inputs[0]?.trigger).toBe("auto");
    expect(stdout).toContain("skipped (already-fresh)");
    // A no-op that was correct is success: a hook must not fail every minute.
    expect(exitCode).toBe(0);
  });

  it("--force asks for a full rebuild", async () => {
    const { reindex, inputs } = stubReindex(
      reindexed({ status: "fresh", indexedCommit: HEAD, headCommit: HEAD }, true)
    );
    const { stdout } = await run(["reindex", "--force"], {
      reindex,
      createRunner: noRunner,
    });
    expect(inputs[0]?.force).toBe(true);
    expect(stdout).toContain("rebuilt from scratch");
  });

  it("exits NON-ZERO when another run holds the store — the request was not served", async () => {
    const { reindex } = stubReindex({
      status: "skipped",
      skip: "already-running",
      repoRoot: REPO,
      before: { status: "stale", indexedCommit: OLD, headCommit: HEAD },
      note: "An index run is already in progress (desktop, pid 1). Waiting for it to finish is the only correct move — a second run would race it.",
    });
    const { stdout, exitCode } = await run(["reindex"], {
      reindex,
      createRunner: noRunner,
    });
    expect(stdout).toContain("skipped (already-running)");
    expect(stdout).toContain("a second run would race it");
    expect(exitCode).toBe(1);
  });

  it("a FAILED run exits 1 and never prints a fresh-looking line", async () => {
    const { reindex } = stubReindex({
      status: "failed",
      repoRoot: REPO,
      forced: true,
      before: { status: "stale", indexedCommit: OLD, headCommit: HEAD },
      after: { status: "stale", indexedCommit: OLD, headCommit: HEAD },
      elapsedMs: 4_000,
      reason: "gitnexus analyze exited (code 1)",
      note: "The index run failed (gitnexus analyze exited (code 1)). The code graph is still BEHIND the current commit (indexed bbbbbbbb, HEAD is aaaaaaaa) — treat graph-backed answers as UNKNOWN risk, never clear.",
    });
    const { stdout, exitCode } = await run(["reindex"], {
      reindex,
      createRunner: noRunner,
    });
    expect(stdout).toContain("FAILED");
    expect(stdout).toContain("index: BEHIND HEAD");
    expect(stdout).not.toContain("index: at HEAD");
    expect(exitCode).toBe(1);
  });

  it("--json prints the coordinator's outcome verbatim", async () => {
    const outcome = reindexed({
      status: "fresh",
      indexedCommit: HEAD,
      headCommit: HEAD,
    });
    const { reindex } = stubReindex(outcome);
    const { stdout } = await run(["reindex", "--json"], {
      reindex,
      createRunner: noRunner,
    });
    expect(JSON.parse(stdout)).toEqual(outcome);
  });

  it("--json keeps stdout parseable by silencing the indexer's own output", async () => {
    // The indexer writes progress; if it inherited stdout, a `--json` consumer
    // would get GitNexus's log lines glued to the payload.
    const verbosity: boolean[] = [];
    const { reindex } = stubReindex(
      reindexed({ status: "fresh", indexedCommit: HEAD, headCommit: HEAD })
    );
    await run(["reindex", "--json"], {
      reindex,
      createRunner: (options) => {
        verbosity.push(options.verbose);
        return async () => {};
      },
    });
    await run(["reindex"], {
      reindex,
      createRunner: (options) => {
        verbosity.push(options.verbose);
        return async () => {};
      },
    });
    expect(verbosity).toEqual([false, true]);
  });

  it("passes --workspace through as the start directory", async () => {
    const { reindex, inputs } = stubReindex(
      reindexed({ status: "fresh", indexedCommit: HEAD, headCommit: HEAD })
    );
    await run(["reindex", "--workspace", "/elsewhere"], {
      reindex,
      createRunner: noRunner,
    });
    expect(inputs[0]?.workspacePath).toBe("/elsewhere");
  });
});

describe("exitCodeForOutcome", () => {
  const before: GitNexusIndexFreshness = {
    status: "stale",
    indexedCommit: OLD,
    headCommit: HEAD,
  };

  it("a clean run that did NOT reach HEAD is not success", async () => {
    // The one case a naive `status === 'reindexed' ? 0 : 1` gets wrong, and the
    // one that would let a pipeline trust an unmoved graph.
    expect(
      exitCodeForOutcome({
        status: "reindexed",
        repoRoot: REPO,
        forced: false,
        before,
        after: before,
        elapsedMs: 1,
        note: "",
      })
    ).toBe(1);
  });

  it("only already-fresh and cooling-down are success skips", async () => {
    const skip = (s: "already-fresh" | "cooling-down" | "cli-missing" | "no-repo") =>
      exitCodeForOutcome({ status: "skipped", skip: s, note: "" });
    expect(skip("already-fresh")).toBe(0);
    expect(skip("cooling-down")).toBe(0);
    expect(skip("cli-missing")).toBe(1);
    expect(skip("no-repo")).toBe(1);
  });
});
