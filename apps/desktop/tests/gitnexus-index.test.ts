import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  GITNEXUS_MANUAL_REINDEX_COMMAND,
  GitNexusIndexSupervisor,
  aggregateTargetStatus,
  needsForceReindex,
  planGitWatch,
  projectGitNexusStatus,
  type GitNexusIndexStatus,
  type GitNexusMeta,
  type GitNexusRepoStatus,
  type GitWatchFs,
  type ResolvedGitNexusCli,
} from "../src/lib/gitnexus-index.js";
import type { GitNexusIndexLockAttempt } from "@muon/client/gitnexus-index-lock";

type SpawnCall = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  detached?: boolean;
  stdio?: unknown;
  cwd?: string;
};

type FakeChild = EventEmitter & {
  unref: () => void;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  pid: number | undefined;
  emitExit: (code?: number | null, signal?: NodeJS.Signals | null) => void;
};

let nextPid = 2000;
function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.unref = vi.fn();
  child.pid = ++nextPid;
  child.kill = vi.fn(() => true);
  child.emitExit = (code = 0, signal = null) => child.emit("exit", code, signal);
  return child;
}

/** Deterministic clock + manual timer queue (mirrors the runner test's Waiter). */
function makeClock() {
  let nowMs = 0;
  let seq = 0;
  const pending = new Map<number, () => void>();
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
    setTimer: (fn: () => void, _ms: number) => {
      const id = ++seq;
      pending.set(id, fn);
      return id;
    },
    clearTimer: (h: unknown) => {
      pending.delete(h as number);
    },
    fireAll: () => {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((fn) => fn());
    },
    pendingCount: () => pending.size,
  };
}

const CLI: ResolvedGitNexusCli = {
  binary: "/path/to/electron",
  commandPrefix: ["/repo/packages/mcp/node_modules/gitnexus/dist/cli/index.js"],
};

/**
 * A fake `node:fs` watch seam. `tree` maps a path to what it is; `files` holds
 * readable contents. Every started watch is recorded so a test can fire events
 * at it and assert it was closed.
 */
type FakeWatch = {
  path: string;
  fire: (filename: string | null) => void;
  fail: (error: unknown) => void;
  closed: boolean;
};
function fakeWatchFs(
  tree: Record<string, "dir" | "file"> = {},
  files: Record<string, string> = {}
) {
  const watches: FakeWatch[] = [];
  const fs: GitWatchFs = {
    kind: (path) => tree[path] ?? null,
    read: (path) => files[path] ?? null,
    watch: (path, onEvent, onError) => {
      const record: FakeWatch = {
        path,
        fire: (filename) => onEvent(filename),
        fail: (error) => onError(error),
        closed: false,
      };
      watches.push(record);
      return {
        close: () => {
          record.closed = true;
        },
      };
    },
  };
  return { fs, watches, live: () => watches.filter((w) => !w.closed) };
}

/** A normal clone at /ws, on branch main. */
const NORMAL_REPO = {
  tree: {
    "/ws/.git": "dir",
    "/ws/.git/refs/heads": "dir",
    "/ws/.git/logs": "dir",
  } as Record<string, "dir" | "file">,
  files: { "/ws/.git/HEAD": "ref: refs/heads/main\n" },
};

/**
 * An in-memory stand-in for the shared cross-process index lock, so these unit
 * tests stay hermetic (no real `.gitnexus` dir, no real lock file) while still
 * exercising the SAME contract: one holder per store, a refusal value for
 * everyone else, idempotent release. The real file lock is proven against real
 * processes in packages/client and packages/mcp.
 */
function fakeLockStore() {
  const held = new Map<string, number>(); // target → holder id
  let next = 0;
  return {
    held,
    acquire: (target: string): GitNexusIndexLockAttempt => {
      if (held.has(target)) {
        return {
          acquired: false,
          reason: "held",
          note: "An index run is already in progress (desktop).",
        };
      }
      const id = ++next;
      held.set(target, id);
      return {
        acquired: true,
        lock: {
          holder: {
            pid: 4242,
            startedAt: "2026-07-27T00:00:00.000Z",
            owner: "desktop",
            target,
            nonce: `n${id}`,
          },
          adoptChild: () => undefined,
          release: () => {
            if (held.get(target) === id) held.delete(target);
          },
        },
      };
    },
  };
}

function makeSupervisor(
  overrides: {
    calls?: SpawnCall[];
    locks?: ReturnType<typeof fakeLockStore>;
    clock?: ReturnType<typeof makeClock>;
    resolveCli?: () => ResolvedGitNexusCli | null;
    readMeta?: (ws: string) => Promise<GitNexusMeta | null>;
    readHead?: (ws: string) => Promise<string | null>;
    onChange?: (s: unknown) => void;
    childFactory?: () => FakeChild;
    minIntervalMs?: number;
    statusRefreshMs?: number;
    watchFs?: GitWatchFs;
    resolveTargets?: (root: string) => string[];
  } = {}
) {
  const calls = overrides.calls ?? [];
  const clock = overrides.clock ?? makeClock();
  const locks = overrides.locks ?? fakeLockStore();
  const children: FakeChild[] = [];
  const spawn = ((command: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({
      command,
      args,
      env: (opts.env as NodeJS.ProcessEnv) ?? {},
      detached: opts.detached as boolean,
      stdio: opts.stdio,
      cwd: opts.cwd as string,
    });
    const child = overrides.childFactory?.() ?? fakeChild();
    children.push(child);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;

  const supervisor = new GitNexusIndexSupervisor({
    spawn,
    execPath: "/path/to/electron",
    // Default: treat the opened folder as one repo (the pre-multi-repo behavior),
    // so these supervisor tests exercise spawn/debounce/status without hitting
    // real git. The Auto Repository Detection walk is tested in gitnexus-repos.
    resolveTargets: overrides.resolveTargets ?? ((root: string) => [root]),
    acquireIndexLock: locks.acquire,
    resolveCli: overrides.resolveCli ?? (() => CLI),
    readMeta: overrides.readMeta ?? (async () => null),
    readHead: overrides.readHead ?? (async () => "HEADSHA"),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    debounceMs: 3000,
    minIntervalMs: overrides.minIntervalMs ?? 300_000,
    // Tests drive real triggers (bind / HEAD / exit), which bypass the floor;
    // 0 keeps the routine-nudge path unthrottled unless a test says otherwise.
    statusRefreshMs: overrides.statusRefreshMs ?? 0,
    // Hermetic by default: an empty tree resolves to zero watchers, so no test
    // ever opens a real fd or touches the real filesystem.
    watchFs: overrides.watchFs ?? fakeWatchFs().fs,
    onChange: overrides.onChange,
    onLog: () => undefined,
  });
  return { supervisor, calls, children, clock, locks };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("projectGitNexusStatus", () => {
  it("maps meta.json to a ready status with symbolCount/lastIndexedAt/commit", () => {
    const meta: GitNexusMeta = {
      indexedAt: "2026-07-19T00:00:00.000Z",
      lastCommit: "abc123",
      stats: { nodes: 5651, files: 120, edges: 12372 },
    };
    expect(
      projectGitNexusStatus(meta, {
        workspacePath: "/ws",
        head: "abc123",
        running: false,
        cliMissing: false,
      })
    ).toEqual({
      status: "ready",
      workspacePath: "/ws",
      symbolCount: 5651,
      lastIndexedAt: "2026-07-19T00:00:00.000Z",
      indexedCommit: "abc123",
      stale: false,
    });
  });

  it("is idle when no index exists, unknown when the CLI is missing", () => {
    expect(
      projectGitNexusStatus(null, { workspacePath: "/ws", head: "x", running: false, cliMissing: false }).status
    ).toBe("idle");
    expect(
      projectGitNexusStatus(null, { workspacePath: "/ws", head: "x", running: false, cliMissing: true }).status
    ).toBe("unknown");
  });

  it("flags stale when HEAD moved, omits stale when HEAD is unknown", () => {
    const meta: GitNexusMeta = { lastCommit: "abc", stats: { nodes: 1 } };
    expect(projectGitNexusStatus(meta, { workspacePath: "/ws", head: "def", running: false, cliMissing: false }).stale).toBe(true);
    expect(projectGitNexusStatus(meta, { workspacePath: "/ws", head: null, running: false, cliMissing: false })).not.toHaveProperty("stale");
  });

  it("reports indexing while a child runs", () => {
    expect(
      projectGitNexusStatus(null, { workspacePath: "/ws", head: null, running: true, cliMissing: false }).status
    ).toBe("indexing");
  });
});

describe("GitNexusIndexSupervisor", () => {
  it("defaults to unknown and never throws before bind", () => {
    const { supervisor } = makeSupervisor();
    expect(supervisor.getStatus()).toEqual({ status: "unknown" });
  });

  it("spawns analyze --index-only detached with load-only + ELECTRON_RUN_AS_NODE", async () => {
    const { supervisor, calls, children, clock } = makeSupervisor();
    supervisor.bind("/ws");
    await flush();
    clock.fireAll(); // fire the debounce
    await flush();

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe("/path/to/electron");
    expect(call.args).toEqual([
      "/repo/packages/mcp/node_modules/gitnexus/dist/cli/index.js",
      "analyze",
      "/ws",
      "--index-only",
    ]);
    expect(call.detached).toBe(true);
    expect(call.stdio).toBe("ignore");
    expect(call.cwd).toBe("/ws");
    expect(call.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(call.env.GITNEXUS_LBUG_EXTENSION_INSTALL).toBe("load-only");
    expect(children[0]!.unref).toHaveBeenCalledOnce();
    expect(supervisor.getStatus().status).toBe("indexing");
  });

  it("coalesces bursty triggers into a single spawn (debounce)", async () => {
    const { supervisor, calls, clock } = makeSupervisor();
    supervisor.bind("/ws");
    supervisor.ensureIndexed();
    supervisor.ensureIndexed();
    supervisor.ensureIndexed();
    await flush();
    expect(clock.pendingCount()).toBe(1); // only the last timer survives
    clock.fireAll();
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("is single-in-flight: no second analyze while one is running", async () => {
    const { supervisor, calls, children, clock } = makeSupervisor();
    supervisor.bind("/ws");
    await flush();
    clock.fireAll();
    await flush();
    expect(calls).toHaveLength(1);

    supervisor.ensureIndexed(); // while running
    await flush();
    clock.fireAll();
    await flush();
    expect(calls).toHaveLength(1); // still one — guarded by `running`

    children[0]!.emitExit(0);
    await flush();
    expect(supervisor.getStatus().status).toBe("idle"); // readMeta→null default
  });

  it("becomes ready with symbolCount after a successful analyze", async () => {
    let indexed = false;
    const { supervisor, children, clock } = makeSupervisor({
      readMeta: async () =>
        indexed ? { indexedAt: "2026-07-19T00:00:00.000Z", lastCommit: "HEADSHA", stats: { nodes: 42 } } : null,
    });
    supervisor.bind("/ws");
    await flush();
    clock.fireAll();
    await flush();
    indexed = true; // analyze "wrote" meta.json
    children[0]!.emitExit(0);
    await flush();
    expect(supervisor.getStatus()).toMatchObject({ status: "ready", symbolCount: 42, indexedCommit: "HEADSHA" });
  });

  it("goes to error (not throw) on a non-zero analyze exit", async () => {
    const { supervisor, children, clock } = makeSupervisor();
    supervisor.bind("/ws");
    await flush();
    clock.fireAll();
    await flush();
    expect(() => children[0]!.emitExit(1)).not.toThrow();
    await flush();
    expect(supervisor.getStatus().status).toBe("error");
    expect(supervisor.getStatus().note).toMatch(/code 1/);
  });

  it("never spawns and stays unknown when the CLI cannot be resolved", async () => {
    const { supervisor, calls, clock } = makeSupervisor({ resolveCli: () => null });
    supervisor.bind("/ws");
    await flush();
    clock.fireAll();
    await flush();
    expect(calls).toHaveLength(0);
    expect(supervisor.getStatus().status).toBe("unknown");
  });

  it("does not throw when spawn itself throws", async () => {
    const throwingSpawn = (() => {
      throw new Error("EACCES");
    }) as unknown as typeof import("node:child_process").spawn;
    const supervisor = new GitNexusIndexSupervisor({
      spawn: throwingSpawn,
      resolveTargets: (root) => [root],
      acquireIndexLock: fakeLockStore().acquire,
      resolveCli: () => CLI,
      readMeta: async () => null,
      readHead: async () => "HEADSHA",
      now: () => 0,
      setTimer: (fn) => {
        fn();
        return 1;
      },
      clearTimer: () => undefined,
      debounceMs: 0,
    });
    expect(() => supervisor.bind("/ws")).not.toThrow();
    await flush();
    expect(supervisor.getStatus().status).toBe("error");
  });

  it("stop() clears timers and releases the child without blocking", async () => {
    const { supervisor, children, clock } = makeSupervisor();
    supervisor.bind("/ws");
    await flush();
    clock.fireAll();
    await flush();
    const child = children[0]!;
    supervisor.stop(); // synchronous
    expect(child.kill).toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
    supervisor.ensureIndexed(); // no-op after stop
    await flush();
    expect(clock.pendingCount()).toBe(0);
  });

  it("emits an immutable snapshot on each transition", async () => {
    const seen: Array<{ status: string }> = [];
    const { supervisor, children, clock } = makeSupervisor({
      onChange: (s) => seen.push(s as { status: string }),
    });
    supervisor.bind("/ws");
    await flush();
    clock.fireAll();
    await flush();
    children[0]!.emitExit(0);
    await flush();
    expect(seen.map((s) => s.status)).toContain("indexing");
    const snap = supervisor.getStatus();
    (snap as { status: string }).status = "MUTATED";
    expect(supervisor.getStatus().status).not.toBe("MUTATED");
  });

  it("rate-limits re-index of a stale workspace to minIntervalMs", async () => {
    const { supervisor, calls, children, clock } = makeSupervisor({
      readMeta: async () => ({ lastCommit: "OLD", stats: { nodes: 1 } }),
      readHead: async () => "NEW", // permanently stale
      minIntervalMs: 300_000,
    });
    supervisor.bind("/ws");
    await flush();
    clock.fireAll();
    await flush();
    expect(calls).toHaveLength(1); // first (lastAnalyzeAt reset on bind)
    children[0]!.emitExit(0);
    await flush();

    clock.advance(1000); // within the interval
    supervisor.ensureIndexed();
    clock.fireAll();
    await flush();
    expect(calls).toHaveLength(1); // rate-limited, no second spawn

    clock.advance(300_000); // interval elapsed
    supervisor.ensureIndexed();
    clock.fireAll();
    await flush();
    expect(calls).toHaveLength(2);
  });
});

describe("GitNexusIndexSupervisor debounce starvation (the founder's bug)", () => {
  it("still fires when main re-binds faster than the debounce window", async () => {
    // Reproduction: main re-binds the workspace on EVERY 2s `muon:state` poll,
    // and bind(sameRoot) nudges ensureIndexed. A re-arming trailing debounce was
    // cleared and re-armed every 2s and its 3s timer NEVER fired — maybeSpawn
    // never ran, nothing was re-indexed, and the masthead froze at "not indexed".
    const { supervisor, calls, clock } = makeSupervisor();
    supervisor.bind("/ws");
    await flush();
    for (let poll = 0; poll < 5; poll++) {
      clock.advance(2000); // the 2s state poll…
      supervisor.bind("/ws"); // …rebinds the same workspace
      await flush();
    }
    expect(clock.pendingCount()).toBe(1); // one scheduled check, not a moving one
    clock.fireAll();
    await flush();
    expect(calls).toHaveLength(1); // it actually ran
  });

  it("keeps ONE pending check across a burst of triggers", async () => {
    const { supervisor, clock } = makeSupervisor();
    supervisor.bind("/ws");
    for (let i = 0; i < 50; i++) supervisor.ensureIndexed();
    await flush();
    expect(clock.pendingCount()).toBe(1);
  });
});

describe("planGitWatch (git layouts)", () => {
  it("watches the git dir, refs/heads and logs of a normal clone", () => {
    const { fs } = fakeWatchFs(NORMAL_REPO.tree, NORMAL_REPO.files);
    expect(planGitWatch("/ws", fs)).toEqual({
      headDirs: ["/ws/.git"],
      refDirs: ["/ws/.git/refs/heads", "/ws/.git/logs"],
    });
  });

  it("follows a LINKED WORKTREE's `.git` FILE to its git dir + common dir", () => {
    // MUON's own agents commit inside linked worktrees: `.git` is a file holding
    // `gitdir: …`, HEAD lives in the private dir, refs live in the common dir.
    const { fs } = fakeWatchFs(
      {
        "/wt/.git": "file",
        "/repo/.git/worktrees/wt": "dir",
        "/repo/.git": "dir",
        "/repo/.git/refs/heads": "dir",
        "/repo/.git/refs/heads/feat": "dir",
        "/repo/.git/worktrees/wt/logs": "dir",
      },
      {
        "/wt/.git": "gitdir: /repo/.git/worktrees/wt\n",
        "/repo/.git/worktrees/wt/commondir": "../..\n",
        "/repo/.git/worktrees/wt/HEAD": "ref: refs/heads/feat/x\n",
      }
    );
    expect(planGitWatch("/wt", fs)).toEqual({
      headDirs: ["/repo/.git/worktrees/wt", "/repo/.git"],
      refDirs: [
        "/repo/.git/refs/heads",
        "/repo/.git/refs/heads/feat",
        "/repo/.git/worktrees/wt/logs",
      ],
    });
  });

  it("resolves a RELATIVE gitdir pointer (submodule-style)", () => {
    const { fs } = fakeWatchFs(
      { "/repo/sub/.git": "file", "/repo/.git/modules/sub": "dir" },
      { "/repo/sub/.git": "gitdir: ../.git/modules/sub" }
    );
    expect(planGitWatch("/repo/sub", fs).headDirs).toEqual([
      "/repo/.git/modules/sub",
    ]);
  });

  it("plans NOTHING for a folder with no .git (never throws)", () => {
    const { fs } = fakeWatchFs();
    expect(planGitWatch("/not-a-repo", fs)).toEqual({
      headDirs: [],
      refDirs: [],
    });
  });
});

describe("GitNexusIndexSupervisor HEAD watching", () => {
  /** A bound supervisor whose repo is already indexed at HEAD (nothing to do). */
  const makeWatched = (over: { minIntervalMs?: number } = {}) => {
    const watch = fakeWatchFs(NORMAL_REPO.tree, NORMAL_REPO.files);
    let head = "HEAD1";
    const harness = makeSupervisor({
      watchFs: watch.fs,
      readMeta: async () => ({ lastCommit: "HEAD1", stats: { nodes: 9 } }),
      readHead: async () => head,
      minIntervalMs: over.minIntervalMs ?? 0,
    });
    return { ...harness, watch, moveHead: (sha: string) => (head = sha) };
  };

  it("watches the resolved repo on bind and reports ready with no spawn", async () => {
    const { supervisor, calls, clock, watch } = makeWatched();
    supervisor.bind("/ws");
    await flush();
    clock.fireAll();
    await flush();
    expect(watch.live().map((w) => w.path)).toEqual([
      "/ws/.git",
      "/ws/.git/refs/heads",
      "/ws/.git/logs",
    ]);
    expect(calls).toHaveLength(0); // index already at HEAD
    expect(supervisor.getStatus().status).toBe("ready");
  });

  it("a commit (loose-ref write) triggers exactly ONE debounced re-index", async () => {
    const { supervisor, calls, clock, watch, moveHead } = makeWatched();
    supervisor.bind("/ws");
    await flush();
    clock.fireAll();
    await flush();
    expect(calls).toHaveLength(0);

    moveHead("HEAD2"); // the commit lands…
    const refs = watch.live().find((w) => w.path === "/ws/.git/refs/heads")!;
    refs.fire("main"); // …git rewrites refs/heads/main
    await flush();
    expect(calls).toHaveLength(0); // still debounced — never spawned inline
    clock.fireAll();
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain("analyze");
  });

  it("a HEAD burst (rebase) collapses into ONE analyze and cannot spin", async () => {
    const { supervisor, calls, clock, watch, moveHead } = makeWatched({
      minIntervalMs: 300_000,
    });
    supervisor.bind("/ws");
    await flush();
    clock.fireAll();
    await flush();

    moveHead("HEAD2");
    const gitDir = watch.live().find((w) => w.path === "/ws/.git")!;
    const refs = watch.live().find((w) => w.path === "/ws/.git/refs/heads")!;
    for (let i = 0; i < 40; i++) {
      gitDir.fire("HEAD");
      gitDir.fire("ORIG_HEAD");
      refs.fire("main");
    }
    await flush();
    clock.fireAll();
    await flush();
    expect(calls).toHaveLength(1);

    // Post-burst chatter while still stale: the per-target cooldown holds.
    for (let i = 0; i < 20; i++) refs.fire("main");
    await flush();
    clock.fireAll();
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("ignores routine git-dir churn (index/COMMIT_EDITMSG/FETCH_HEAD)", async () => {
    const { supervisor, clock, watch } = makeWatched();
    supervisor.bind("/ws");
    await flush();
    clock.fireAll();
    await flush();
    expect(clock.pendingCount()).toBe(0);

    const gitDir = watch.live().find((w) => w.path === "/ws/.git")!;
    for (const noisy of ["index", "COMMIT_EDITMSG", "FETCH_HEAD", "index.lock"]) {
      gitDir.fire(noisy);
    }
    expect(clock.pendingCount()).toBe(0); // nothing scheduled
  });

  it("stop() closes EVERY watcher and no event survives it", async () => {
    const { supervisor, calls, clock, watch, moveHead } = makeWatched();
    supervisor.bind("/ws");
    await flush();
    clock.fireAll();
    await flush();
    const all = [...watch.watches];
    expect(all).toHaveLength(3);

    supervisor.stop();
    expect(all.every((w) => w.closed)).toBe(true);
    expect(watch.live()).toHaveLength(0);
    expect(supervisor.getWatchedPathCount()).toBe(0);
    expect(clock.pendingCount()).toBe(0);

    moveHead("HEAD2");
    all[1]!.fire("main"); // a late event from an fd already released
    await flush();
    clock.fireAll();
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("re-binding a new workspace tears the old watchers down", async () => {
    const watch = fakeWatchFs(
      {
        ...NORMAL_REPO.tree,
        "/other/.git": "dir",
        "/other/.git/refs/heads": "dir",
      },
      { ...NORMAL_REPO.files, "/other/.git/HEAD": "ref: refs/heads/main\n" }
    );
    const { supervisor } = makeSupervisor({
      watchFs: watch.fs,
      resolveTargets: (root) => [root],
    });
    supervisor.bind("/ws");
    await flush();
    expect(watch.live().map((w) => w.path)).toEqual([
      "/ws/.git",
      "/ws/.git/refs/heads",
      "/ws/.git/logs",
    ]);
    supervisor.bind("/other");
    await flush();
    expect(watch.live().map((w) => w.path)).toEqual([
      "/other/.git",
      "/other/.git/refs/heads",
    ]);
    supervisor.stop();
    expect(watch.live()).toHaveLength(0);
  });

  it("degrades (never throws) when a watcher errors — deleted dir/permission", async () => {
    const { supervisor, clock, watch } = makeWatched();
    supervisor.bind("/ws");
    await flush();
    clock.fireAll();
    await flush();
    const logs = watch.live().find((w) => w.path === "/ws/.git/logs")!;
    expect(() => logs.fail(new Error("EPERM"))).not.toThrow();
    expect(supervisor.getWatchedPathCount()).toBe(2); // the other two survive
    // The bind/focus nudges still work — this is the pre-watching behaviour.
    supervisor.ensureIndexed();
    await flush();
    expect(() => clock.fireAll()).not.toThrow();
  });

  it("watches NOTHING for a non-git folder and says so cleanly", async () => {
    const watch = fakeWatchFs(); // empty tree: no .git anywhere
    const { supervisor, calls, clock } = makeSupervisor({
      watchFs: watch.fs,
      resolveTargets: () => [], // Auto Repository Detection found no repo
    });
    supervisor.bind("/not-a-repo");
    await flush();
    clock.fireAll();
    await flush();
    expect(watch.watches).toHaveLength(0);
    expect(calls).toHaveLength(0); // NEVER analyze a non-git folder
    expect(supervisor.getStatus()).toMatchObject({
      status: "idle",
      reason: "no-repo",
    });
    supervisor.stop();
  });

  it("throttles routine nudges but never the real triggers", async () => {
    let reads = 0;
    const watch = fakeWatchFs(NORMAL_REPO.tree, NORMAL_REPO.files);
    const clock = makeClock();
    const { supervisor } = makeSupervisor({
      clock,
      watchFs: watch.fs,
      statusRefreshMs: 15_000,
      readMeta: async () => {
        reads += 1;
        return { lastCommit: "HEAD1", stats: { nodes: 9 } };
      },
      readHead: async () => "HEAD1",
    });
    supervisor.bind("/ws"); // a real trigger → reads
    await flush();
    clock.fireAll();
    await flush();
    const afterBind = reads;

    for (let poll = 0; poll < 4; poll++) {
      clock.advance(2000);
      supervisor.bind("/ws"); // routine 2s rebind
      await flush();
      clock.fireAll();
      await flush();
    }
    expect(reads).toBe(afterBind); // floor held: no meta.json re-read storm

    watch.live()[1]!.fire("main"); // a REAL movement signal
    await flush();
    clock.fireAll();
    await flush();
    expect(reads).toBeGreaterThan(afterBind);
    supervisor.stop();
  });
});

describe("aggregateTargetStatus (multi-repo workspace)", () => {
  const repo = (over: Partial<GitNexusRepoStatus>): GitNexusRepoStatus => ({
    path: "/r",
    name: "r",
    status: "ready",
    ...over,
  });

  it("0 repos → a CLEAN idle 'nothing to index', never an error", () => {
    const s = aggregateTargetStatus([], {
      workspacePath: "/q",
      running: false,
      cliMissing: false,
    });
    expect(s.status).toBe("idle");
    expect(s.note).toMatch(/No git repository/i);
  });

  it("all repos ready → ready, symbols summed, 'N repos' note, per-repo list carried", () => {
    const s = aggregateTargetStatus(
      [
        repo({ path: "/q/a", name: "a", symbolCount: 100 }),
        repo({ path: "/q/b", name: "b", symbolCount: 250 }),
      ],
      { workspacePath: "/q", running: false, cliMissing: false }
    );
    expect(s.status).toBe("ready");
    expect(s.symbolCount).toBe(350);
    expect(s.note).toBe("2 repos");
    expect(s.repos?.map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("some still pending → idle with an 'x/N indexed' progress note", () => {
    const s = aggregateTargetStatus(
      [repo({ status: "ready" }), repo({ status: "idle" })],
      { workspacePath: "/q", running: false, cliMissing: false }
    );
    expect(s.status).toBe("idle");
    expect(s.note).toMatch(/1\/2 repos indexed/);
  });

  it("one repo fails but others index → ready, with a 'x of N · 1 failed' note", () => {
    const s = aggregateTargetStatus(
      [repo({ status: "ready" }), repo({ status: "error", note: "boom" })],
      { workspacePath: "/q", running: false, cliMissing: false }
    );
    expect(s.status).toBe("ready");
    expect(s.note).toMatch(/1 of 2 repos · 1 failed/);
  });

  it("ALL repos fail → error", () => {
    const s = aggregateTargetStatus(
      [repo({ status: "error", note: "boom" })],
      { workspacePath: "/q", running: false, cliMissing: false }
    );
    expect(s.status).toBe("error");
  });
});

describe("GitNexusIndexSupervisor multi-repo (Auto Repository Detection)", () => {
  it("indexes EVERY repo of a monorepo, one at a time, then reports N repos ready", async () => {
    const analyzed = new Set<string>();
    const children: FakeChild[] = [];
    const calls: SpawnCall[] = [];
    const spawn = ((command: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({
        command,
        args,
        env: {},
        detached: opts.detached as boolean,
        stdio: opts.stdio,
        cwd: opts.cwd as string,
      });
      const child = fakeChild();
      children.push(child);
      return child;
    }) as unknown as typeof import("node:child_process").spawn;

    const supervisor = new GitNexusIndexSupervisor({
      spawn,
      resolveTargets: () => ["/mono/a", "/mono/b", "/mono/c"],
      acquireIndexLock: fakeLockStore().acquire,
      resolveCli: () => CLI,
      // A target reads back a real meta only once it has been analyzed.
      readMeta: async (ws) =>
        analyzed.has(ws)
          ? { indexedAt: "t", lastCommit: "HEADSHA", stats: { nodes: 7 } }
          : null,
      readHead: async () => "HEADSHA",
      now: () => 0,
      setTimer: (fn) => {
        fn(); // synchronous debounce/watchdog for a deterministic loop
        return 1;
      },
      clearTimer: () => undefined,
      debounceMs: 0,
    });

    const settle = async () => {
      for (let i = 0; i < 12; i++) await Promise.resolve();
    };
    supervisor.bind("/mono");
    // Drive the sequential loop: settle, then exit the newest un-exited analyze
    // child (marking its repo analyzed) so the supervisor advances to the next
    // target. Repeats enough to cover all three members.
    const exited = new Set<number>();
    for (let guard = 0; guard < 12; guard++) {
      await settle();
      const idx = children.length - 1;
      if (idx >= 0 && !exited.has(idx)) {
        exited.add(idx);
        const target = calls[idx]?.cwd;
        if (target) analyzed.add(target);
        children[idx]!.emitExit(0);
      }
    }
    await settle();

    // Every member repo was analyzed exactly once, at its own root.
    expect(calls.map((c) => c.cwd).sort()).toEqual([
      "/mono/a",
      "/mono/b",
      "/mono/c",
    ]);
    // analyze arg is the repo root, not the non-git parent.
    expect(calls.every((c) => c.args.includes(c.cwd))).toBe(true);
    const status = supervisor.getStatus();
    expect(status.status).toBe("ready");
    expect(status.symbolCount).toBe(21); // 3 × 7
    expect(status.repos?.map((r) => r.name).sort()).toEqual(["a", "b", "c"]);
    supervisor.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Operator-triggered re-index.
//
// The gap this closes, live: GitNexus indexing failed, and the app offered the
// operator nothing but "will retry" behind a five-minute cooldown. Meanwhile
// every governed child querying the graph runs blind and MUON reports lower
// confidence with no way for the human to act.
// ─────────────────────────────────────────────────────────────────────────────

describe("needsForceReindex — when an operator's re-index must rebuild", () => {
  const repo = (over: Partial<GitNexusRepoStatus>): GitNexusRepoStatus => ({
    path: "/r",
    name: "r",
    status: "ready",
    ...over,
  });

  it("no per-repo status at all → force (we know nothing, trust nothing)", () => {
    expect(needsForceReindex(undefined)).toBe(true);
  });

  it("the last analyze FAILED → force: a half-written store only a rebuild fixes", () => {
    expect(needsForceReindex(repo({ status: "error", note: "boom" }))).toBe(true);
  });

  it("ready and NOT stale → force, or GitNexus early-returns and the button lies", () => {
    // This is the "it says ready but I don't believe it" click. Without
    // --force, `analyze` sees lastCommit === HEAD and does nothing at all.
    expect(needsForceReindex(repo({ status: "ready", stale: false }))).toBe(true);
    expect(needsForceReindex(repo({ status: "ready" }))).toBe(true);
  });

  it("merely STALE → no force: an incremental has real work and is far cheaper", () => {
    expect(needsForceReindex(repo({ status: "ready", stale: true }))).toBe(false);
  });

  it("never indexed / mid-flight → no force: nothing to rebuild from", () => {
    expect(needsForceReindex(repo({ status: "idle" }))).toBe(false);
    expect(needsForceReindex(repo({ status: "indexing" }))).toBe(false);
  });
});

describe("GitNexusIndexSupervisor.reindexNow", () => {
  /** Bind + let the first automatic analyze finish, leaving a READY index. */
  const settled = async (over: Parameters<typeof makeSupervisor>[0] = {}) => {
    const harness = makeSupervisor({
      readMeta: async () => ({
        indexedAt: "2026-07-27T00:00:00.000Z",
        lastCommit: "HEADSHA",
        stats: { nodes: 25398 },
      }),
      readHead: async () => "HEADSHA",
      ...over,
    });
    harness.supervisor.bind("/ws");
    await flush();
    harness.clock.fireAll();
    await flush();
    // A fresh index needs no automatic analyze — nothing should have spawned.
    return harness;
  };

  it("spawns analyze IMMEDIATELY — no debounce, the human already waited", async () => {
    const { supervisor, calls, clock } = await settled();
    expect(calls).toHaveLength(0); // fresh index: the background loop stayed quiet

    const result = supervisor.reindexNow();
    expect(result.accepted).toBe(true);
    // Spawned on this tick, without anyone firing the debounce timer.
    expect(calls).toHaveLength(1);
    expect(clock.pendingCount()).toBeLessThanOrEqual(1); // only the watchdog
    supervisor.stop();
  });

  it("passes --force so a 'ready' index is actually rebuilt, not no-op'd", async () => {
    const { supervisor, calls } = await settled();
    const result = supervisor.reindexNow();
    expect(result).toMatchObject({ accepted: true, forced: true });
    expect(calls[0]!.args).toEqual([
      "/repo/packages/mcp/node_modules/gitnexus/dist/cli/index.js",
      "analyze",
      "/ws",
      "--index-only",
      "--force",
    ]);
    // Still the same hardened spawn shape as the background path.
    expect(calls[0]!.detached).toBe(true);
    expect(calls[0]!.env.GITNEXUS_LBUG_EXTENSION_INSTALL).toBe("load-only");
    supervisor.stop();
  });

  it("a merely STALE index re-indexes incrementally — no --force", async () => {
    const { supervisor, calls, children } = await settled({
      readHead: async () => "MOVEDSHA", // HEAD moved past the indexed commit
    });
    // The background loop already caught the staleness and spawned its own
    // incremental. Let it finish; the cooldown then blocks a background retry,
    // which is exactly the state an operator clicks Re-index from.
    expect(calls).toHaveLength(1);
    // It exits CLEANLY but the store is still behind HEAD (a commit landed
    // while it ran). No failure to recover from — just drift.
    children[0]!.emitExit(0);
    await flush();
    expect(supervisor.getStatus()).toMatchObject({
      status: "ready",
      stale: true,
    });
    calls.length = 0;

    const result = supervisor.reindexNow();
    expect(result).toMatchObject({ accepted: true, forced: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).not.toContain("--force");
    supervisor.stop();
  });

  it("re-indexes a repo the heuristic considers CURRENT (bypasses needsIndex)", async () => {
    // ready + fresh: `needsIndex` is false, so the background loop would never
    // touch it. The operator's judgement has to outrank that or the button is
    // dead exactly when someone stops trusting a green READY.
    const { supervisor, calls } = await settled();
    supervisor.ensureIndexed();
    await flush();
    expect(calls).toHaveLength(0);

    supervisor.reindexNow();
    expect(calls).toHaveLength(1);
    supervisor.stop();
  });

  it("NO DOUBLE RUN: a second request while one is in flight is refused", async () => {
    const { supervisor, calls, children } = await settled();
    expect(supervisor.reindexNow().accepted).toBe(true);
    expect(calls).toHaveLength(1);

    for (let i = 0; i < 5; i++) {
      const again = supervisor.reindexNow();
      expect(again).toMatchObject({
        accepted: false,
        reason: "already-running",
      });
      expect(again.accepted === false && again.note).toMatch(/already/i);
    }
    // Mashing the button spawned exactly one analyze child. Two concurrent
    // runs would race on the same .gitnexus store; the full-rebuild path wipes
    // the DB files, so this guard is correctness, not politeness.
    expect(calls).toHaveLength(1);

    children[0]!.emitExit(0);
    await flush();
    expect(supervisor.reindexNow().accepted).toBe(true); // free again after exit
    supervisor.stop();
  });

  it("ignores the per-target cooldown that made the founder wait", async () => {
    const { supervisor, calls, children } = await settled({
      minIntervalMs: 300_000,
    });
    supervisor.reindexNow();
    children[0]!.emitExit(1); // it failed again
    await flush();
    expect(calls).toHaveLength(1);
    expect(supervisor.getStatus().status).toBe("error");

    // The clock has NOT advanced: the background loop would refuse for another
    // five minutes. The operator's retry must not be held behind that.
    const retry = supervisor.reindexNow();
    expect(retry.accepted).toBe(true);
    expect(calls).toHaveLength(2);
    supervisor.stop();
  });

  it("marks the run as the operator's, so the UI can confirm their own click", async () => {
    const seen: GitNexusIndexStatus[] = [];
    const { supervisor } = await settled({
      onChange: (s) => seen.push(s as GitNexusIndexStatus),
    });
    seen.length = 0;
    supervisor.reindexNow();
    await flush();
    const indexing = seen.find((s) => s.status === "indexing");
    expect(indexing?.trigger).toBe("manual");
    supervisor.stop();
  });

  it("a FAILED manual run stays failed and keeps the manual attribution", async () => {
    const { supervisor, children } = await settled();
    supervisor.reindexNow();
    children[0]!.emitExit(1);
    await flush();
    const status = supervisor.getStatus();
    // Never "ready" — a failed index must not be rendered as a working one.
    expect(status.status).toBe("error");
    expect(status.trigger).toBe("manual");
    expect(status.note).toMatch(/code 1/);
    supervisor.stop();
  });

  it("does not loop forever on a repo that keeps failing", async () => {
    const { supervisor, calls, children } = await settled({
      minIntervalMs: 300_000,
    });
    supervisor.reindexNow();
    children[0]!.emitExit(1);
    await flush();
    // The exit re-nudges the loop. The forced flag must be cleared by then, or
    // the cooldown-exempt target would respawn on every single nudge.
    for (let i = 0; i < 10; i++) {
      supervisor.ensureIndexed();
      await flush();
    }
    expect(calls).toHaveLength(1);
    supervisor.stop();
  });

  it("refuses when the CLI is missing, and hands over the exact command", async () => {
    const { supervisor, calls } = await settled({ resolveCli: () => null });
    const result = supervisor.reindexNow();
    expect(result).toMatchObject({ accepted: false, reason: "cli-missing" });
    expect(result.accepted === false && result.note).toContain(
      GITNEXUS_MANUAL_REINDEX_COMMAND
    );
    expect(calls).toHaveLength(0); // never pretend
    supervisor.stop();
  });

  it("refuses a repoPath that is not part of this workspace", async () => {
    const { supervisor, calls } = await settled();
    // The renderer is untrusted: it must not be able to aim `analyze` at an
    // arbitrary directory by passing a path of its choosing.
    const result = supervisor.reindexNow("/etc");
    expect(result).toMatchObject({ accepted: false, reason: "unknown-repo" });
    expect(calls).toHaveLength(0);
    supervisor.stop();
  });

  it("refuses before any workspace is bound, and after stop()", async () => {
    const { supervisor: unbound } = makeSupervisor();
    expect(unbound.reindexNow()).toMatchObject({
      accepted: false,
      reason: "no-repo",
    });

    const { supervisor } = await settled();
    supervisor.stop();
    expect(supervisor.reindexNow()).toMatchObject({
      accepted: false,
      reason: "stopped",
    });
  });

  it("refuses when the folder resolves to no git repo at all", async () => {
    const { supervisor, calls } = makeSupervisor({ resolveTargets: () => [] });
    supervisor.bind("/not-a-repo");
    await flush();
    expect(supervisor.reindexNow()).toMatchObject({
      accepted: false,
      reason: "no-repo",
    });
    expect(calls).toHaveLength(0);
    supervisor.stop();
  });

  it("multi-repo: queues every member, still one analyze at a time", async () => {
    const { supervisor, calls } = makeSupervisor({
      resolveTargets: () => ["/mono/a", "/mono/b"],
      readMeta: async () => ({ lastCommit: "HEADSHA", stats: { nodes: 3 } }),
      readHead: async () => "HEADSHA",
    });
    supervisor.bind("/mono");
    await flush();
    const result = supervisor.reindexNow();
    expect(result).toMatchObject({
      accepted: true,
      targets: ["/mono/a", "/mono/b"],
    });
    expect(calls).toHaveLength(1); // only the first is in flight
    expect(calls[0]!.cwd).toBe("/mono/a");
    supervisor.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-process exclusion. MUON runs the indexer from TWO processes against ONE
// store: this supervisor and the MCP server's freshness refresh. The in-process
// `running` flag cannot see the other one, and the forced rebuild path DELETES
// the store's DB files — so this is data loss, not a scheduling nicety.

describe("two MUON processes must never index one store at once", () => {
  /** Bind + let the first automatic analyze finish, leaving a READY index. */
  const settled = async (over: Parameters<typeof makeSupervisor>[0] = {}) => {
    const harness = makeSupervisor({
      readMeta: async () => ({
        indexedAt: "2026-07-27T00:00:00.000Z",
        lastCommit: "HEADSHA",
        stats: { nodes: 25398 },
      }),
      readHead: async () => "HEADSHA",
      ...over,
    });
    harness.supervisor.bind("/ws");
    await flush();
    harness.clock.fireAll();
    await flush();
    return harness;
  };

  it("REFUSES the operator's re-index while another process holds the store", async () => {
    const locks = fakeLockStore(); // ONE store, two MUON processes
    const other = locks.acquire("/ws"); // stand-in for the MCP server's analyze
    expect(other.acquired).toBe(true);

    const { supervisor, calls } = await settled({ locks });
    const result = supervisor.reindexNow();
    // A refusal VALUE in the vocabulary the masthead already renders — never a
    // throw, never a second analyze, never a silent nothing.
    expect(result).toMatchObject({
      accepted: false,
      reason: "already-running",
    });
    expect(result.accepted === false && result.note).toMatch(/already/i);
    expect(calls).toHaveLength(0);

    // Once the other process is done, the same click works.
    if (other.acquired) other.lock.release();
    expect(supervisor.reindexNow().accepted).toBe(true);
    expect(calls).toHaveLength(1);
    supervisor.stop();
  });

  it("the BACKGROUND loop skips a locked store and retries later, silently", async () => {
    const locks = fakeLockStore();
    const other = locks.acquire("/ws");
    const { supervisor, calls, clock } = makeSupervisor({
      locks,
      readMeta: async () => null, // never indexed: the loop wants to analyze
    });
    supervisor.bind("/ws");
    await flush();
    clock.fireAll();
    await flush();
    // Nothing spawned, and nothing pretended: a lock held by MUON's other
    // process is not this repo's failure, so the status must NOT go to error.
    expect(calls).toHaveLength(0);
    expect(supervisor.getStatus().status).not.toBe("error");

    if (other.acquired) other.lock.release();
    supervisor.ensureIndexed();
    clock.fireAll();
    await flush();
    expect(calls).toHaveLength(1); // picked up on the next nudge, no cooldown burn
    supervisor.stop();
  });

  it("releases on a clean exit, a failed exit, and a KILLED child", async () => {
    const endings: Array<(child: FakeChild) => void> = [
      (child) => child.emitExit(0),
      (child) => child.emitExit(1),
      (child) => child.emitExit(null, "SIGKILL"),
    ];
    for (const ending of endings) {
      const locks = fakeLockStore();
      const { supervisor, children } = await settled({ locks });
      expect(supervisor.reindexNow().accepted).toBe(true);
      expect(locks.held.size).toBe(1); // held for the whole life of the child
      ending(children[0]!);
      await flush();
      expect(locks.held.size).toBe(0); // …and handed back however it died
      supervisor.stop();
    }
  });

  it("releases the lock when the spawn itself throws", async () => {
    const locks = fakeLockStore();
    const { supervisor } = await settled({
      locks,
      childFactory: () => {
        throw new Error("EACCES");
      },
    });
    const result = supervisor.reindexNow();
    expect(result.accepted).toBe(true); // the decision stands; the run failed
    await flush();
    expect(supervisor.getStatus().status).toBe("error");
    // A store nobody is indexing must never stay locked.
    expect(locks.held.size).toBe(0);
    supervisor.stop();
  });

  it("refuses (never guesses) when the lock cannot be created at all", async () => {
    const { supervisor, calls } = await settled({
      locks: {
        held: new Map<string, number>(),
        acquire: () => ({
          acquired: false,
          reason: "unavailable",
          note: "MUON could not open the index lock: EACCES",
        }),
      },
    });
    const result = supervisor.reindexNow();
    expect(result).toMatchObject({
      accepted: false,
      reason: "lock-unavailable",
    });
    expect(calls).toHaveLength(0);
    supervisor.stop();
  });
});

describe("aggregateTargetStatus — trigger attribution", () => {
  const repo = (over: Partial<GitNexusRepoStatus>): GitNexusRepoStatus => ({
    path: "/r",
    name: "r",
    status: "ready",
    ...over,
  });

  it("carries the trigger on indexing and error, the phases an analyze produces", () => {
    expect(
      aggregateTargetStatus([repo({ status: "indexing" })], {
        workspacePath: "/q",
        running: true,
        cliMissing: false,
        trigger: "manual",
      }).trigger
    ).toBe("manual");
    expect(
      aggregateTargetStatus([repo({ status: "error", note: "boom" })], {
        workspacePath: "/q",
        running: false,
        cliMissing: false,
        trigger: "manual",
      }).trigger
    ).toBe("manual");
  });

  it("drops it once the index settles — 'whose run was it' is then meaningless", () => {
    expect(
      aggregateTargetStatus([repo({ status: "ready", symbolCount: 5 })], {
        workspacePath: "/q",
        running: false,
        cliMissing: false,
        trigger: "manual",
      }).trigger
    ).toBeUndefined();
  });
});
