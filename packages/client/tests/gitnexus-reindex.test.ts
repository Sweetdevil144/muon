import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireGitNexusIndexLock,
  readGitNexusIndexRebuild,
} from "../src/gitnexus-index-lock.js";
import {
  readGitNexusIndexFreshness,
  describeIndexFreshnessGap,
  type GitNexusIndexFreshness,
} from "../src/gitnexus-freshness.js";
import {
  classifyCheckout,
  reindexCodeGraph,
  resolvePrimaryCheckout,
  GITNEXUS_REINDEX_MIN_INTERVAL_MS,
  type GitNexusAnalyzeRunner,
} from "../src/gitnexus-reindex.js";

// ADR-0054. NO real index run anywhere in this file: a full analyze of a real
// repository measures ~27s, so the subprocess is an injected runner (the
// `port-scan.ts` discipline) and every decision is exercised against it. The
// LOCK, the freshness read and the store on disk are real — those are the parts
// whose cross-process behaviour a fake would hide.

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

let repo: string;

async function writeMeta(content: Record<string, unknown>): Promise<void> {
  await mkdir(join(repo, ".gitnexus"), { recursive: true });
  await writeFile(
    join(repo, ".gitnexus", "meta.json"),
    JSON.stringify(content)
  );
}

/** `git rev-parse` for a PRIMARY checkout at `repo`. */
function primaryGit(root: string) {
  return async (args: string[]): Promise<string> => {
    if (args.includes("--git-dir") || args.includes("--git-common-dir")) {
      return `${join(root, ".git")}\n`;
    }
    throw new Error(`unexpected git args: ${args.join(" ")}`);
  };
}

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** Turn `dir` into a real one-commit git repo; returns its real HEAD sha. */
function gitRepoAt(dir: string): string {
  const git = (...args: string[]): string =>
    String(
      execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" })
    );
  git("init", "-b", "main");
  git("config", "user.email", "test@muon.local");
  git("config", "user.name", "muon test");
  git("commit", "--allow-empty", "-m", "one");
  return git("rev-parse", "HEAD").trim();
}

/** A runner that records its calls and resolves. */
function recordingRunner(): {
  runner: GitNexusAnalyzeRunner;
  calls: Array<{ repoRoot: string; force: boolean }>;
} {
  const calls: Array<{ repoRoot: string; force: boolean }> = [];
  return {
    calls,
    runner: async (input) => {
      calls.push(input);
    },
  };
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "muon-reindex-"));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true }).catch(() => {});
});

describe("classifyCheckout — the one worktree rule", () => {
  it("names the primary checkout for a primary checkout and calls it no worktree", () => {
    const result = classifyCheckout({
      path: "/src/app",
      gitDir: "/src/app/.git",
      gitCommonDir: "/src/app/.git",
    });
    expect(result.primary).toBe("/src/app");
    expect(result.linkedWorktree).toBe(false);
    expect(result.governedShape).toBe(false);
  });

  it("is subdirectory-safe: a SUBDIR of the primary is not a linked worktree", () => {
    // The naive rule (`primary !== path`) called this a worktree and would have
    // refused every command run from a package directory.
    const result = classifyCheckout({
      path: "/src/app/packages/client",
      gitDir: "/src/app/.git",
      gitCommonDir: "/src/app/.git",
    });
    expect(result.linkedWorktree).toBe(false);
    expect(result.primary).toBe("/src/app");
  });

  it("catches a linked worktree that lives OUTSIDE the checkout (MUON's real layout)", () => {
    // Governed worktrees are `~/.muon/worktrees/<profile>/<repo>-<hash>`, so a
    // path-shape test alone would still see `.muon/worktrees` here — this case
    // pins that GIT's answer is what decides, and it works even when the path
    // says nothing.
    const result = classifyCheckout({
      path: "/elsewhere/task-tree",
      gitDir: "/src/app/.git/worktrees/task-7",
      gitCommonDir: "/src/app/.git",
    });
    expect(result.linkedWorktree).toBe(true);
    expect(result.primary).toBe("/src/app");
  });

  it("catches the legacy in-repo `.muon/worktrees` layout on path shape alone", () => {
    // Second arm: git is not consulted at all here, so an older tree still
    // refuses even if git answers wrongly or not at all.
    const result = classifyCheckout({ path: "/src/app/.muon/worktrees/task-1" });
    expect(result.governedShape).toBe(true);
  });

  it("matches SEGMENTS, not substrings", () => {
    expect(
      classifyCheckout({ path: "/src/my.muon/worktreesish/x" }).governedShape
    ).toBe(false);
    expect(
      classifyCheckout({ path: "/src/.muonx/worktrees/x" }).governedShape
    ).toBe(false);
  });

  it("reports no primary when git named nothing", () => {
    expect(classifyCheckout({ path: "/src/app" }).primary).toBeUndefined();
  });
});

describe("resolvePrimaryCheckout", () => {
  it("refuses a governed worktree and NAMES the primary to use instead", async () => {
    const result = await resolvePrimaryCheckout("/elsewhere/task-tree", {
      runGit: async (args) =>
        args.includes("--git-common-dir")
          ? "/src/app/.git\n"
          : "/src/app/.git/worktrees/task-7\n",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.skip).toBe("governed-worktree");
    expect(result.repoRoot).toBe("/src/app");
    expect(result.note).toContain("/src/app");
  });

  it("refuses a non-repo as no-repo, never as an error", async () => {
    const result = await resolvePrimaryCheckout("/tmp/not-a-repo", {
      runGit: async () => {
        throw new Error("not a git repository");
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.skip).toBe("no-repo");
  });
});

describe("reindexCodeGraph — the worktree fence", () => {
  it("REFUSES a governed worktree and spawns nothing", async () => {
    const { runner, calls } = recordingRunner();
    const outcome = await reindexCodeGraph(
      { workspacePath: "/elsewhere/task-tree", trigger: "manual" },
      {
        runAnalyze: runner,
        runGit: async (args) =>
          args.includes("--git-common-dir")
            ? "/src/app/.git\n"
            : "/src/app/.git/worktrees/task-7\n",
      }
    );
    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") throw new Error("unreachable");
    expect(outcome.skip).toBe("governed-worktree");
    // The fence is BEFORE any store read or lock, so nothing ran at all.
    expect(calls).toHaveLength(0);
  });

  it("REFUSES the legacy in-repo .muon/worktrees path even when git answers primary", async () => {
    const { runner, calls } = recordingRunner();
    const worktree = join(repo, ".muon", "worktrees", "task-1");
    const outcome = await reindexCodeGraph(
      { workspacePath: worktree, trigger: "manual" },
      { runAnalyze: runner, runGit: primaryGit(repo) }
    );
    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") throw new Error("unreachable");
    expect(outcome.skip).toBe("governed-worktree");
    expect(calls).toHaveLength(0);
  });
});

describe("reindexCodeGraph — drift detection", () => {
  it("auto: SKIPS when the graph is already at HEAD (drift false)", async () => {
    const { runner, calls } = recordingRunner();
    const outcome = await reindexCodeGraph(
      { workspacePath: repo, trigger: "auto" },
      {
        runAnalyze: runner,
        runGit: primaryGit(repo),
        readFreshness: async () => ({
          status: "fresh",
          indexedCommit: HEAD,
          headCommit: HEAD,
        }),
      }
    );
    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") throw new Error("unreachable");
    expect(outcome.skip).toBe("already-fresh");
    expect(calls).toHaveLength(0);
  });

  it("auto: RUNS incrementally when the graph is behind HEAD (drift true)", async () => {
    const { runner, calls } = recordingRunner();
    const outcome = await reindexCodeGraph(
      { workspacePath: repo, trigger: "auto" },
      {
        runAnalyze: runner,
        runGit: primaryGit(repo),
        readFreshness: async () => ({
          status: "stale",
          indexedCommit: OLD,
          headCommit: HEAD,
        }),
      }
    );
    expect(outcome.status).toBe("reindexed");
    expect(calls).toEqual([{ repoRoot: repo, force: false }]);
  });

  it("manual: runs even when the graph claims to be fresh, and FORCES a rebuild", async () => {
    // "It says ready and I do not believe it" is exactly the manual gesture; an
    // incremental run early-returns "already up to date", so without --force
    // the command would report work it never did.
    const { runner, calls } = recordingRunner();
    const outcome = await reindexCodeGraph(
      { workspacePath: repo, trigger: "manual" },
      {
        runAnalyze: runner,
        runGit: primaryGit(repo),
        readFreshness: async () => ({
          status: "fresh",
          indexedCommit: HEAD,
          headCommit: HEAD,
        }),
      }
    );
    expect(outcome.status).toBe("reindexed");
    if (outcome.status !== "reindexed") throw new Error("unreachable");
    expect(outcome.forced).toBe(true);
    expect(calls).toEqual([{ repoRoot: repo, force: true }]);
  });

  it("a MISSING store is rebuilt from scratch — we know nothing, so trust nothing", async () => {
    const { runner, calls } = recordingRunner();
    await reindexCodeGraph(
      { workspacePath: repo, trigger: "auto" },
      {
        runAnalyze: runner,
        runGit: primaryGit(repo),
        readFreshness: async () => ({ status: "missing" }),
      }
    );
    expect(calls).toEqual([{ repoRoot: repo, force: true }]);
  });
});

describe("reindexCodeGraph — the interval floor", () => {
  const justIndexed: GitNexusIndexFreshness = {
    status: "stale",
    indexedCommit: OLD,
    headCommit: HEAD,
    indexedAt: "2026-08-17T12:00:00.000Z",
  };
  const at = (offsetMs: number) => () =>
    Date.parse("2026-08-17T12:00:00.000Z") + offsetMs;

  it("auto: SKIPS a stale store indexed inside the floor", async () => {
    const { runner, calls } = recordingRunner();
    const outcome = await reindexCodeGraph(
      { workspacePath: repo, trigger: "auto" },
      {
        runAnalyze: runner,
        runGit: primaryGit(repo),
        readFreshness: async () => justIndexed,
        now: at(GITNEXUS_REINDEX_MIN_INTERVAL_MS - 1),
      }
    );
    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") throw new Error("unreachable");
    expect(outcome.skip).toBe("cooling-down");
    expect(calls).toHaveLength(0);
  });

  it("auto: RUNS once the floor has elapsed", async () => {
    const { runner, calls } = recordingRunner();
    const outcome = await reindexCodeGraph(
      { workspacePath: repo, trigger: "auto" },
      {
        runAnalyze: runner,
        runGit: primaryGit(repo),
        readFreshness: async () => justIndexed,
        now: at(GITNEXUS_REINDEX_MIN_INTERVAL_MS),
      }
    );
    expect(outcome.status).toBe("reindexed");
    expect(calls).toHaveLength(1);
  });

  it("manual: the floor does NOT apply — a human clicking is not a hot loop", async () => {
    const { runner, calls } = recordingRunner();
    const outcome = await reindexCodeGraph(
      { workspacePath: repo, trigger: "manual" },
      {
        runAnalyze: runner,
        runGit: primaryGit(repo),
        readFreshness: async () => justIndexed,
        now: at(0),
      }
    );
    expect(outcome.status).toBe("reindexed");
    expect(calls).toHaveLength(1);
  });
});

describe("reindexCodeGraph — single flight", () => {
  it("two CONCURRENT calls produce exactly ONE subprocess; the second observes the run in flight", async () => {
    // The real cross-process lock and the real store dir: this is the guard
    // whose whole job is to be correct across processes, so faking it would
    // test nothing. `analyze --force` deletes the store's DB files, so two
    // overlapping runs can destroy a graph that takes minutes to rebuild.
    const calls: Array<{ repoRoot: string; force: boolean }> = [];
    let releaseFirst: (() => void) | undefined;
    const held = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    const runner: GitNexusAnalyzeRunner = async (input) => {
      calls.push(input);
      await held;
    };
    const deps = {
      runAnalyze: runner,
      runGit: primaryGit(repo),
      readFreshness: async (): Promise<GitNexusIndexFreshness> => ({
        status: "stale",
        indexedCommit: OLD,
        headCommit: HEAD,
      }),
    };
    const first = reindexCodeGraph(
      { workspacePath: repo, trigger: "manual" },
      deps
    );
    // Let the first call take the lock and enter the runner.
    await new Promise((r) => setTimeout(r, 10));
    const second = await reindexCodeGraph(
      { workspacePath: repo, trigger: "manual" },
      deps
    );

    expect(second.status).toBe("skipped");
    if (second.status !== "skipped") throw new Error("unreachable");
    expect(second.skip).toBe("already-running");
    // And the in-flight run is visible to ANY consumer, not just this process.
    expect(readGitNexusIndexRebuild(repo)?.owner).toBe("cli");

    releaseFirst?.();
    const firstOutcome = await first;
    expect(firstOutcome.status).toBe("reindexed");
    expect(calls).toHaveLength(1);
  });

  it("refuses when ANOTHER MUON process (desktop) holds the store", async () => {
    const attempt = acquireGitNexusIndexLock(repo, { owner: "desktop" });
    expect(attempt.acquired).toBe(true);
    try {
      const { runner, calls } = recordingRunner();
      const outcome = await reindexCodeGraph(
        { workspacePath: repo, trigger: "manual" },
        {
          runAnalyze: runner,
          runGit: primaryGit(repo),
          readFreshness: async () => ({
            status: "stale",
            indexedCommit: OLD,
            headCommit: HEAD,
          }),
        }
      );
      expect(outcome.status).toBe("skipped");
      if (outcome.status !== "skipped") throw new Error("unreachable");
      expect(outcome.skip).toBe("already-running");
      expect(outcome.note).toContain("desktop");
      expect(calls).toHaveLength(0);
    } finally {
      if (attempt.acquired) attempt.lock.release();
    }
  });

  it("releases the lock on SUCCESS, so the next caller is not refused", async () => {
    const deps = {
      runAnalyze: recordingRunner().runner,
      runGit: primaryGit(repo),
      readFreshness: async (): Promise<GitNexusIndexFreshness> => ({
        status: "stale",
        indexedCommit: OLD,
        headCommit: HEAD,
      }),
    };
    await reindexCodeGraph({ workspacePath: repo, trigger: "manual" }, deps);
    expect(readGitNexusIndexRebuild(repo)).toBeNull();
    const again = await reindexCodeGraph(
      { workspacePath: repo, trigger: "manual" },
      deps
    );
    expect(again.status).toBe("reindexed");
  });

  it("releases the lock on FAILURE too — a crashed run must not wedge the store", async () => {
    const outcome = await reindexCodeGraph(
      { workspacePath: repo, trigger: "manual" },
      {
        runAnalyze: async () => {
          throw new Error("gitnexus analyze exited (code 1)");
        },
        runGit: primaryGit(repo),
        readFreshness: async () => ({ status: "missing" }),
      }
    );
    expect(outcome.status).toBe("failed");
    expect(readGitNexusIndexRebuild(repo)).toBeNull();
  });

  it("skips with cli-missing WITHOUT taking the lock", async () => {
    const outcome = await reindexCodeGraph(
      { workspacePath: repo, trigger: "manual" },
      {
        runAnalyze: null,
        runGit: primaryGit(repo),
        readFreshness: async () => ({ status: "missing" }),
      }
    );
    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") throw new Error("unreachable");
    expect(outcome.skip).toBe("cli-missing");
    expect(outcome.note).toContain("gitnexus analyze");
    // Holding the store hostage because we have nothing to run with would block
    // the desktop and the MCP for the stale-lock timeout.
    expect(readGitNexusIndexRebuild(repo)).toBeNull();
  });
});

describe("reindexCodeGraph — honest reporting", () => {
  it("a FAILED run never reports fresh, and quotes what the store actually says", async () => {
    const outcome = await reindexCodeGraph(
      { workspacePath: repo, trigger: "manual" },
      {
        runAnalyze: async () => {
          throw new Error("boom");
        },
        runGit: primaryGit(repo),
        readFreshness: async () => ({
          status: "stale",
          indexedCommit: OLD,
          headCommit: HEAD,
        }),
      }
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.after.status).toBe("stale");
    expect(outcome.reason).toContain("boom");
    expect(outcome.note).toContain("BEHIND");
    expect(outcome.note).not.toMatch(/\bat the current commit\b/);
  });

  it("a CLEAN run that did not move the store is still reported as behind", async () => {
    // The analyze exiting 0 is what `analyze` said. `after` is what the store
    // says, and the note must quote the store — otherwise a pipeline treats an
    // unmoved graph as a refreshed one.
    const outcome = await reindexCodeGraph(
      { workspacePath: repo, trigger: "manual" },
      {
        runAnalyze: async () => {},
        runGit: primaryGit(repo),
        readFreshness: async () => ({
          status: "stale",
          indexedCommit: OLD,
          headCommit: HEAD,
        }),
      }
    );
    expect(outcome.status).toBe("reindexed");
    if (outcome.status !== "reindexed") throw new Error("unreachable");
    expect(outcome.after.status).toBe("stale");
    expect(outcome.note).toContain("BEHIND");
  });

  it("retries ONCE with --force after a failed incremental, inside the same lock", async () => {
    const calls: Array<{ repoRoot: string; force: boolean }> = [];
    const outcome = await reindexCodeGraph(
      { workspacePath: repo, trigger: "auto" },
      {
        runAnalyze: async (input) => {
          calls.push(input);
          if (!input.force) throw new Error("incremental interrupted");
        },
        runGit: primaryGit(repo),
        readFreshness: async () => ({
          status: "stale",
          indexedCommit: OLD,
          headCommit: HEAD,
        }),
      }
    );
    expect(calls).toEqual([
      { repoRoot: repo, force: false },
      { repoRoot: repo, force: true },
    ]);
    expect(outcome.status).toBe("reindexed");
    if (outcome.status !== "reindexed") throw new Error("unreachable");
    expect(outcome.forced).toBe(true);
  });

  it("does NOT spin: a force retry that also fails reports the FIRST cause once", async () => {
    const calls: Array<{ repoRoot: string; force: boolean }> = [];
    const outcome = await reindexCodeGraph(
      { workspacePath: repo, trigger: "auto" },
      {
        runAnalyze: async (input) => {
          calls.push(input);
          throw new Error(input.force ? "rebuild failed" : "incremental failed");
        },
        runGit: primaryGit(repo),
        readFreshness: async () => ({
          status: "stale",
          indexedCommit: OLD,
          headCommit: HEAD,
        }),
      }
    );
    expect(calls).toHaveLength(2);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toContain("incremental failed");
  });
});

// ── The DEFAULT seams, against a real git repo ──────────────────────────────
//
// Every test above injects `readFreshness` and `runGit`, and that is exactly how
// a real defect survived a green suite: the default freshness read omitted the
// HEAD commit, so a healthy store classified as `missing` — which made the drift
// check unable to ever see `fresh` AND made the force rule rebuild from scratch
// on every automatic run. Only the real command showed it. These exercise the
// defaults; only `runAnalyze` stays injected, because that is the ~27s part.

describe.skipIf(!hasGit)("the default seams resolve real git facts", () => {
  it("auto: a store at real HEAD is `already-fresh`, not `missing`", async () => {
    const head = gitRepoAt(repo);
    await writeMeta({ lastCommit: head, indexedAt: new Date().toISOString() });
    const { runner, calls } = recordingRunner();
    const outcome = await reindexCodeGraph(
      { workspacePath: repo, trigger: "auto" },
      { runAnalyze: runner }
    );
    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") throw new Error("unreachable");
    expect(outcome.skip).toBe("already-fresh");
    expect(outcome.before?.status).toBe("fresh");
    expect(calls).toHaveLength(0);
  });

  it("auto: a store BEHIND real HEAD runs INCREMENTALLY, never a full rebuild", async () => {
    // The defect's most expensive symptom: `missing` forced `--force`, so a
    // routine catch-up after one commit paid for a whole rebuild.
    gitRepoAt(repo);
    await writeMeta({
      lastCommit: OLD,
      indexedAt: "2020-01-01T00:00:00.000Z", // far outside the floor
    });
    const { runner, calls } = recordingRunner();
    const outcome = await reindexCodeGraph(
      { workspacePath: repo, trigger: "auto" },
      { runAnalyze: runner }
    );
    expect(outcome.status).toBe("reindexed");
    if (outcome.status !== "reindexed") throw new Error("unreachable");
    expect(outcome.before.status).toBe("stale");
    expect(outcome.forced).toBe(false);
    expect(calls).toEqual([{ repoRoot: realpathSync(repo), force: false }]);
  });

  it("the default fence resolves a real linked worktree to the real primary", async () => {
    gitRepoAt(repo);
    const tree = join(repo, "..", `${basename(repo)}-wt`);
    execFileSync("git", ["worktree", "add", "--detach", tree, "HEAD"], {
      cwd: repo,
      stdio: "ignore",
    });
    try {
      const resolution = await resolvePrimaryCheckout(tree);
      expect(resolution.ok).toBe(false);
      if (resolution.ok) throw new Error("expected a refusal");
      expect(resolution.skip).toBe("governed-worktree");
      expect(resolution.repoRoot).toBe(realpathSync(repo));
    } finally {
      await rm(tree, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("the freshness signal consumers read flips after a successful reindex", () => {
  it("stale → TOOL GAP block; reindexed to HEAD → no block, from the real store", async () => {
    // The data pipeline end to end, against the REAL store on disk: what the
    // runner's worker preamble and the desktop banner both read is
    // `readGitNexusIndexFreshness`, so the proof that a reindex is worth
    // anything is that THIS value changes.
    await writeMeta({ lastCommit: OLD, indexedAt: "2026-08-17T12:00:00.000Z" });
    const before = await readGitNexusIndexFreshness({
      repoRoot: repo,
      headCommit: HEAD,
    });
    expect(before.status).toBe("stale");
    expect(describeIndexFreshnessGap(before)).toContain("STALE");

    // The injected "indexer" does what a real analyze does: rewrite the meta.
    const outcome = await reindexCodeGraph(
      { workspacePath: repo, trigger: "manual" },
      {
        runAnalyze: async () => {
          await writeMeta({
            lastCommit: HEAD,
            indexedAt: "2026-08-17T12:05:00.000Z",
            stats: { files: 3, nodes: 9 },
          });
        },
        runGit: primaryGit(repo),
        readFreshness: (repoRoot) =>
          readGitNexusIndexFreshness({ repoRoot, headCommit: HEAD }),
      }
    );
    expect(outcome.status).toBe("reindexed");
    if (outcome.status !== "reindexed") throw new Error("unreachable");
    expect(outcome.after.status).toBe("fresh");
    expect(outcome.after.stats?.nodes).toBe(9);
    expect(describeIndexFreshnessGap(outcome.after)).toBeUndefined();

    // And an independent reader — a separate process would do exactly this —
    // now agrees.
    const after = await readGitNexusIndexFreshness({
      repoRoot: repo,
      headCommit: HEAD,
    });
    expect(after.status).toBe("fresh");
    expect(after.rebuild).toBeUndefined();
  });
});
