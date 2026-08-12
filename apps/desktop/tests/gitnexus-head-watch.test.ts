import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { GitNexusIndexSupervisor } from "../src/lib/gitnexus-index.js";

// The whole point of HEAD watching is "does a REAL commit actually wake us" —
// which a fake fs seam can assert about our logic but never about the platform's
// watcher. These drive the supervisor's REAL `node:fs` watchers against REAL git
// repos: a commit in a terminal, a branch switch, a reset, and a LINKED WORKTREE
// (where `.git` is a file, which is how MUON's own agents commit).

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });

const trash: string[] = [];
afterAll(() => {
  for (const dir of trash) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
});

function makeRepo(prefix = "gnx-watch-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trash.push(dir);
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@muon.local");
  git(dir, "config", "user.name", "muon test");
  writeFileSync(join(dir, "a.txt"), "one");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "one");
  return dir;
}

/** A supervisor whose analyze is faked (we assert the TRIGGER, not the CLI). */
function watchedSupervisor() {
  const analyzed: string[] = [];
  const children: EventEmitter[] = [];
  const spawn = ((_binary: string, args: string[]) => {
    analyzed.push(args[args.indexOf("analyze") + 1] ?? "?");
    const child = new EventEmitter() as EventEmitter & {
      unref: () => void;
      kill: () => boolean;
    };
    child.unref = vi.fn();
    child.kill = vi.fn(() => true);
    children.push(child);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  const supervisor = new GitNexusIndexSupervisor({
    spawn,
    resolveCli: () => ({ binary: "/bin/true", commandPrefix: [] }),
    debounceMs: 150,
    minIntervalMs: 0,
    statusRefreshMs: 0,
    onLog: () => undefined,
  });
  return {
    supervisor,
    analyzed,
    /** Let the (fake) analyze finish so the next trigger can spawn. */
    finish: () => children.at(-1)?.emit("exit", 0, null),
  };
}

const waitFor = async (predicate: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
};

describe.skipIf(!hasGit)("GitNexus HEAD watching against real git", () => {
  it("re-indexes on a real commit, branch switch and reset — no window focus", async () => {
    const repo = makeRepo();
    const { supervisor, analyzed, finish } = watchedSupervisor();
    supervisor.bind(repo);
    try {
      // First index (no .gitnexus yet).
      expect(await waitFor(() => analyzed.length >= 1)).toBe(true);
      expect(analyzed[0]).toBe(repo);
      expect(supervisor.getWatchedPathCount()).toBeGreaterThan(0);
      finish();

      // A commit made in a terminal while the window keeps focus — the exact
      // case the old focus-only nudge could never see.
      const beforeCommit = analyzed.length;
      writeFileSync(join(repo, "b.txt"), "two");
      git(repo, "add", ".");
      git(repo, "commit", "-m", "two");
      expect(await waitFor(() => analyzed.length > beforeCommit)).toBe(true);
      finish();

      // A branch switch (HEAD rewritten to point at a NESTED ref).
      const beforeSwitch = analyzed.length;
      git(repo, "checkout", "-b", "feat/x");
      expect(await waitFor(() => analyzed.length > beforeSwitch)).toBe(true);
      finish();

      // A commit on that nested branch — proves the watch set re-targeted.
      const beforeNested = analyzed.length;
      writeFileSync(join(repo, "c.txt"), "three");
      git(repo, "add", ".");
      git(repo, "commit", "-m", "three");
      expect(await waitFor(() => analyzed.length > beforeNested)).toBe(true);
      finish();

      // A hard reset.
      const beforeReset = analyzed.length;
      git(repo, "reset", "--hard", "HEAD~1");
      expect(await waitFor(() => analyzed.length > beforeReset)).toBe(true);
    } finally {
      supervisor.stop();
    }
    expect(supervisor.getWatchedPathCount()).toBe(0);
  }, 60_000);

  it("watches a LINKED WORKTREE (`.git` is a FILE) and sees its commits", async () => {
    const repo = makeRepo();
    const tree = mkdtempSync(join(tmpdir(), "gnx-worktree-"));
    rmSync(tree, { recursive: true, force: true }); // `worktree add` wants it gone
    trash.push(tree);
    git(repo, "worktree", "add", "-b", "wt", tree);

    const { supervisor, analyzed, finish } = watchedSupervisor();
    supervisor.bind(tree);
    try {
      expect(await waitFor(() => analyzed.length >= 1)).toBe(true);
      expect(analyzed[0]).toBe(tree); // indexed at the worktree root
      expect(supervisor.getWatchedPathCount()).toBeGreaterThan(0);
      finish();

      const before = analyzed.length;
      writeFileSync(join(tree, "w.txt"), "from the worktree");
      git(tree, "add", ".");
      git(tree, "commit", "-m", "worktree commit");
      expect(await waitFor(() => analyzed.length > before)).toBe(true);
    } finally {
      supervisor.stop();
    }
    expect(supervisor.getWatchedPathCount()).toBe(0);
  }, 60_000);

  it("a non-git folder: zero watchers, zero analyze, an honest reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gnx-nogit-"));
    trash.push(dir);
    const { supervisor, analyzed } = watchedSupervisor();
    supervisor.bind(dir);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(analyzed).toHaveLength(0); // NEVER analyze a non-git folder
    expect(supervisor.getWatchedPathCount()).toBe(0);
    expect(supervisor.getStatus()).toMatchObject({
      status: "idle",
      reason: "no-repo",
    });
    supervisor.stop();
  }, 30_000);
});
