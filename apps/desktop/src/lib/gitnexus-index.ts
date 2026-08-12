import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { execFile, spawnSync } from "node:child_process";
import { readFileSync, statSync, watch as nodeWatch } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  acquireGitNexusIndexLock,
  type GitNexusIndexLockAttempt,
  type GitNexusIndexLockHandle,
} from "@muon/client/gitnexus-index-lock";
import { resolveIndexTargets } from "./gitnexus-repos.js";

const execFileAsync = promisify(execFile);
const localRequire = createRequire(__filename);

// Best-effort, fire-and-forget background index supervisor for the workspace's
// LOCAL GitNexus graph (`<ws>/.gitnexus/`). It NEVER blocks startup or quit:
// every path fails safe to `unknown`, no method throws, the analyze child is
// detached + unref'd, and stop() clears timers without awaiting the child.
// Status is read straight from meta.json (no `gnx status` subprocess).

export type GitNexusIndexPhase =
  | "unknown"
  | "idle"
  | "indexing"
  | "ready"
  | "error";

/**
 * WHY the phase is what it is, when the phase alone is ambiguous.
 *
 * `idle` used to render ONE generic line ("will index this workspace") for four
 * very different situations — no git repo here, no index yet, cooling down after
 * an attempt, or a partially-indexed monorepo — so a user staring at
 * "NOT INDEXED" could not tell whether to wait, open a repo, or report a bug.
 * This is the machine-readable answer the masthead renders copy from.
 */
export type GitNexusStatusReason =
  /** resolveTargets → []: the opened folder is not (and contains no) git repo. */
  | "no-repo"
  /** A git repo with no local graph yet; the first index is queued. */
  | "never-indexed"
  /** Multi-repo: some members indexed, the rest are queued behind them. */
  | "queued"
  /** Needs (re)indexing, but the per-repo cooldown has not elapsed — retrying. */
  | "rate-limited"
  /** The last analyze failed; `note` carries the reason. A retry is scheduled. */
  | "last-attempt-failed"
  /** The bundled GitNexus CLI could not be resolved — indexing is unavailable. */
  | "cli-missing";

/**
 * WHO asked for the analyze that is running (or that just failed).
 *
 * The operator needs to tell "MUON noticed HEAD moved and is catching up" from
 * "the re-index I clicked 20 seconds ago is running" — otherwise a manual retry
 * looks identical to background noise and they click it again.
 */
export type GitNexusIndexTrigger = "auto" | "manual";

/** Why an operator-triggered re-index was NOT accepted. Never silently dropped. */
export type GitNexusReindexRefusal =
  /**
   * An analyze is already in flight — the no-double-run guard. Covers BOTH the
   * in-supervisor guard and the cross-process index lock (the MCP server can be
   * indexing this same store from another OS process, which this supervisor
   * cannot see any other way).
   */
  | "already-running"
  /**
   * The cross-process index lock could not be created at all (the store dir is
   * unwritable). We refuse rather than spawn: without the lock we cannot
   * promise MUON is not already rebuilding this store from another process.
   */
  | "lock-unavailable"
  /** Nothing here resolves to a git repo, or no workspace is bound. */
  | "no-repo"
  /** The bundled GitNexus CLI could not be resolved — we cannot spawn anything. */
  | "cli-missing"
  /** The supervisor was stopped (workspace closed / app quitting). */
  | "stopped"
  /** The requested repoPath is not one of THIS workspace's resolved targets. */
  | "unknown-repo";

/**
 * The answer to "re-index this now". Deliberately a value, not a throw: the UI
 * must be able to render WHY nothing happened. `accepted:false` never leaves the
 * caller guessing, and never renders as progress.
 */
export type GitNexusReindexResult =
  | { accepted: true; targets: string[]; forced: boolean; note: string }
  | { accepted: false; reason: GitNexusReindexRefusal; note: string };

/**
 * The command an operator runs by hand when MUON cannot spawn the indexer
 * itself (the CLI is missing from the install). Kept in one place so the UI, the
 * refusal note and the docs cannot drift apart.
 */
export const GITNEXUS_MANUAL_REINDEX_COMMAND =
  "npx gitnexus analyze . --index-only --force";

export type GitNexusIndexStatus = {
  status: GitNexusIndexPhase;
  /** The bound workspace/repo root. Token- and coordinate-free. */
  workspacePath?: string;
  /** meta.stats.nodes — the symbol count the navbar renders. */
  symbolCount?: number;
  /** meta.indexedAt (ISO). */
  lastIndexedAt?: string;
  /** meta.lastCommit — the commit the index was built at. */
  indexedCommit?: string;
  /** HEAD !== indexedCommit (best-effort; omitted when git/HEAD is unavailable). */
  stale?: boolean;
  /** Why this phase — lets the UI say WHICH "not indexed" this is. */
  reason?: GitNexusStatusReason;
  /** Human-readable, token-free (repo basename, degradation reason, …). */
  note?: string;
  /**
   * Who asked for the analyze behind this phase. Only meaningful while
   * `indexing` (or on the `error` that analyze left behind) — the UI reads it
   * to confirm the operator's own click, and ignores it otherwise.
   */
  trigger?: GitNexusIndexTrigger;
  /**
   * Auto Repository Detection: the git repos this workspace resolved to. One
   * entry for a normal repo; several when the opened folder was a monorepo of
   * separate repos (each indexed on its own). Drives the multi-repo graph tabs.
   */
  repos?: GitNexusRepoStatus[];
};

/** Per-repo index status inside a (possibly multi-repo) workspace. */
export type GitNexusRepoStatus = {
  /** Absolute repo root (a target of `analyze`). */
  path: string;
  /** Repo basename, for tab labels. */
  name: string;
  status: GitNexusIndexPhase;
  symbolCount?: number;
  lastIndexedAt?: string;
  indexedCommit?: string;
  stale?: boolean;
  reason?: GitNexusStatusReason;
  note?: string;
};

/** Subset of gitnexus meta.json we read (repo-manager.js / run-analyze.js). */
export type GitNexusMeta = {
  indexedAt?: string;
  lastCommit?: string;
  stats?: { nodes?: number; files?: number; edges?: number };
};

/** How to invoke the bundled CLI: `binary [...commandPrefix] analyze …`. */
export type ResolvedGitNexusCli = {
  binary: string;
  commandPrefix: string[];
};

type TimerHandle = unknown;

export type GitNexusIndexSupervisorOptions = {
  /** Fired on every status transition, so main can push `muon:gitnexus`. */
  onChange?: (status: GitNexusIndexStatus) => void;
  onLog?: (line: string) => void;
  // ---- injectable seams (tests / packaging) ----
  spawn?: typeof nodeSpawn;
  execPath?: string;
  /** Base dir for CLI resolution (defaults to this module's dir). */
  moduleDir?: string;
  /** Override the whole CLI resolver. Returns null → never spawn (fail-safe). */
  resolveCli?: () => ResolvedGitNexusCli | null;
  readMeta?: (workspacePath: string) => Promise<GitNexusMeta | null>;
  readHead?: (workspacePath: string) => Promise<string | null>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** Debounce window that coalesces bursty triggers (anchored to the FIRST). */
  debounceMs?: number;
  /** Minimum gap between analyze spawns for the SAME workspace. */
  minIntervalMs?: number;
  /**
   * Minimum gap between status re-reads driven by ROUTINE nudges (main rebinds
   * the workspace on every 2s state poll). Real triggers — bind, a HEAD move, an
   * analyze exit — always refresh immediately, bypassing this floor.
   */
  statusRefreshMs?: number;
  /** Filesystem seam for HEAD watching (tests inject a fake). */
  watchFs?: GitWatchFs;
  /** Watchdog: SIGTERM a stuck analyze child after this long. */
  analyzeTimeoutMs?: number;
  /** Extra analyze args (e.g. ["--skip-git"]). `--index-only` is always added. */
  extraAnalyzeArgs?: string[];
  /**
   * Auto Repository Detection: resolve an opened folder to the repo root(s) to
   * index. Default probes git + walks for sub-repos (gitnexus-repos.ts). Return
   * [] to index nothing (a clean, non-error state — never spawn analyze on a
   * non-git folder). Injectable for tests.
   */
  resolveTargets?: (root: string) => string[];
  /**
   * Take the CROSS-PROCESS index lock for a repo's `.gitnexus` store. Defaults
   * to the shared `@muon/client` lock — the SAME one `packages/mcp` uses, so
   * the desktop and the MCP server exclude each other. Injectable so unit tests
   * stay hermetic (no real store, no real lock file).
   */
  acquireIndexLock?: (target: string) => GitNexusIndexLockAttempt;
};

const defaultReadMeta = async (
  workspacePath: string
): Promise<GitNexusMeta | null> => {
  try {
    const raw = await readFile(
      join(workspacePath, ".gitnexus", "meta.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as GitNexusMeta;
    return null;
  } catch {
    return null; // absent / unreadable / corrupt → "not indexed"
  }
};

const defaultReadHead = async (
  workspacePath: string
): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: workspacePath,
      timeout: 3000,
      windowsHide: true,
      encoding: "utf8",
    });
    const head = String(stdout).trim();
    return head.length > 0 ? head : null;
  } catch {
    return null; // non-git / git missing → staleness unknown (never an error)
  }
};

/**
 * The runtime GitNexus children execute under. A REAL node binary when one is
 * resolvable, Electron-as-node only as the packaged fallback.
 *
 * Why this matters (observed 2026-08-05, macOS crash dialog): GitNexus loads
 * tree-sitter language grammars as native modules built for NODE. Under
 * `ELECTRON_RUN_AS_NODE`, `tree-sitter-ruby.node` threw a C++ exception in
 * `napi_register_module_v1` and the whole child died SIGABRT — and because
 * the crashing binary is Electron.app, macOS popped "Electron quit
 * unexpectedly" at the operator for a background indexer. Under real node
 * the grammars load as built, and even a genuine crash of a plain CLI binary
 * never raises the app-crash dialog.
 *
 * Resolution order: MUON_NODE_BIN override → `node` on PATH (dev launches
 * inherit the terminal's PATH) → null (caller falls back to Electron-as-node
 * — a Finder-launched packaged app has no PATH node, a documented residual
 * until GitNexus ships Electron-ABI grammar builds).
 */
let cachedPathNode: string | null | undefined;

export function resolveNodeBinary(): string | null {
  const override = process.env.MUON_NODE_BIN?.trim();
  if (override) return override;
  // The PATH lookup is cached for the process lifetime: this resolver sits on
  // hot evidence paths (review-diff, recon, graph export) and a sync spawn
  // per call would be pure waste.
  if (cachedPathNode !== undefined) return cachedPathNode;
  try {
    const found = spawnSync("/usr/bin/which", ["node"], {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
    });
    const path = found.status === 0 ? found.stdout.trim() : "";
    cachedPathNode = path.length > 0 ? path : null;
  } catch {
    cachedPathNode = null;
  }
  return cachedPathNode;
}

/**
 * Resolve the bundled `gitnexus` CLI. The desktop app does NOT depend on
 * `@muon/mcp`/`gitnexus`, so a bare `require.resolve('gitnexus/...')` fails —
 * we probe monorepo-relative `packages/mcp` locations and honor the same
 * `MUON_GITNEXUS_BIN` override gitnexus-tools.ts uses. Null ⇒ never spawn.
 * Shared by the index supervisor, the on-demand graph export (main), and the
 * review/recon/data-boundary evidence readers.
 */
export function resolveGitNexusCli(
  moduleDir: string = __dirname
): ResolvedGitNexusCli | null {
  const override = process.env.MUON_GITNEXUS_BIN?.trim();
  if (override) return { binary: override, commandPrefix: [] };
  // apps/desktop/dist/lib → repo root is up 4; also try up 3 (dist/lib flat).
  const candidateBases = [
    moduleDir,
    join(moduleDir, "..", "..", "..", "..", "packages", "mcp"),
    join(moduleDir, "..", "..", "..", "packages", "mcp"),
  ];
  for (const base of candidateBases) {
    try {
      const pkg = localRequire.resolve("gitnexus/package.json", {
        paths: [base],
      });
      return {
        // Real node first (see resolveNodeBinary): the CLI's native
        // tree-sitter grammars are node builds, and a grammar abort under
        // Electron-as-node surfaced a macOS app-crash dialog for a
        // background index run.
        binary: resolveNodeBinary() ?? process.execPath,
        commandPrefix: [join(dirname(pkg), "dist", "cli", "index.js")],
      };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const defaultResolveCli = (
  moduleDir: string
): (() => ResolvedGitNexusCli | null) => {
  return () => resolveGitNexusCli(moduleDir);
};

// ─── HEAD watching ─────────────────────────────────────────────────────────
// A commit made while the window stays focused used to be invisible: the only
// nudges were bind() and `window.on("focus")`. So a commit the user lands in a
// terminal, a commit MUON's own merge executor lands, or an agent's commit in a
// worktree left the graph stale for as long as the window kept focus — and
// `code_query`/`code_impact`/`review_diff` silently answered from a stale graph.
//
// We watch each resolved repo's git dir READ-ONLY (no locks, nothing written
// into .git) and feed every hit into the SAME debounce + per-target rate limit
// the rest of the supervisor uses. The watcher is only a HINT: the decision to
// re-index is still `refreshStatus()` comparing HEAD against meta.lastCommit.

/** One live filesystem watch. `close()` must never throw. */
export type GitWatchHandle = { close: () => void };

/** Injectable fs seam for HEAD watching (real `node:fs` by default). */
export type GitWatchFs = {
  /** "dir" | "file" | null (absent / unreadable). Never throws. */
  kind: (path: string) => "dir" | "file" | null;
  /** File contents, or null when absent / unreadable. Never throws. */
  read: (path: string) => string | null;
  /** Start a non-persistent, non-recursive watch. null ⇒ could not watch. */
  watch: (
    path: string,
    onEvent: (filename: string | null) => void,
    onError: (error: unknown) => void
  ) => GitWatchHandle | null;
};

export const defaultGitWatchFs: GitWatchFs = {
  kind: (path) => {
    try {
      const stat = statSync(path);
      if (stat.isDirectory()) return "dir";
      if (stat.isFile()) return "file";
      return null;
    } catch {
      return null;
    }
  },
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  watch: (path, onEvent, onError) => {
    try {
      // persistent:false — a watcher must never hold the app open (same
      // discipline as the unref'd timers). recursive:false — bounded cost.
      const watcher = nodeWatch(
        path,
        { persistent: false, recursive: false },
        (_event, filename) =>
          onEvent(typeof filename === "string" ? filename : null)
      );
      watcher.on("error", (error) => onError(error));
      return {
        close: () => {
          try {
            watcher.close();
          } catch {
            // already closed / fd reaped — nothing to release
          }
        },
      };
    } catch (error) {
      onError(error);
      return null;
    }
  },
};

/**
 * Top-of-git-dir files whose change means HEAD may have MOVED. Everything else
 * up there (`index`, `COMMIT_EDITMSG`, `FETCH_HEAD`, lock files) is rewritten by
 * routine `git status`/`git add` traffic and must NOT wake us.
 */
const HEAD_FILES = new Set([
  "HEAD",
  "ORIG_HEAD",
  "packed-refs",
  "MERGE_HEAD",
  "REBASE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
]);

/** The directories to watch for one repo. Bounded: ≤ 4 per repo. */
export type GitWatchPlan = {
  /** Git-dir tops — watched WITH the `HEAD_FILES` filename filter. */
  headDirs: string[];
  /** Loose-ref + reflog dirs — any write in them moved a ref. Unfiltered. */
  refDirs: string[];
};

/**
 * Resolve a repo work-tree to the git directories worth watching. Handles the
 * three layouts we actually meet:
 *  - a normal clone: `<repo>/.git` is a DIRECTORY;
 *  - a linked worktree or submodule: `<repo>/.git` is a FILE holding
 *    `gitdir: <path>` — HEAD lives in that private dir while refs/packed-refs
 *    live in the COMMON dir named by `<gitdir>/commondir` (MUON's own agents run
 *    in linked worktrees, so this is the common case, not an edge case);
 *  - anything else (no `.git`) → an empty plan: we watch nothing and never throw.
 *
 * Pure over the injected fs seam, so every layout is unit-testable.
 */
export function planGitWatch(target: string, fs: GitWatchFs): GitWatchPlan {
  const empty: GitWatchPlan = { headDirs: [], refDirs: [] };
  const dotGit = join(target, ".git");
  const kind = fs.kind(dotGit);
  let gitDir: string | null = null;
  if (kind === "dir") {
    gitDir = dotGit;
  } else if (kind === "file") {
    const pointer = fs.read(dotGit) ?? "";
    const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(pointer);
    if (match?.[1]) {
      gitDir = isAbsolute(match[1]) ? match[1] : resolve(target, match[1]);
    }
  }
  if (!gitDir || fs.kind(gitDir) !== "dir") return empty;

  // A linked worktree's refs/packed-refs live in the common dir.
  let commonDir = gitDir;
  const commonRaw = fs.read(join(gitDir, "commondir"))?.trim();
  if (commonRaw) {
    commonDir = isAbsolute(commonRaw) ? commonRaw : resolve(gitDir, commonRaw);
  }

  const headDirs = [gitDir];
  if (commonDir !== gitDir && fs.kind(commonDir) === "dir") {
    headDirs.push(commonDir);
  }

  const refDirs: string[] = [];
  const pushDir = (dir: string): void => {
    if (!refDirs.includes(dir) && fs.kind(dir) === "dir") refDirs.push(dir);
  };
  // Loose branch refs — `git commit` rewrites `<commonDir>/refs/heads/<branch>`.
  const headsDir = join(commonDir, "refs", "heads");
  pushDir(headsDir);
  // A nested branch name (`feat/x`) lives one dir deeper; watch that dir too so
  // platforms with non-recursive watches (inotify) still see the commit.
  const headRef = /^\s*ref:\s*(.+?)\s*$/m.exec(fs.read(join(gitDir, "HEAD")) ?? "");
  if (headRef?.[1]) {
    const refDir = dirname(join(commonDir, ...headRef[1].split("/")));
    pushDir(refDir);
  }
  // The reflog is appended on EVERY ref update in this work-tree (commit,
  // checkout, reset, rebase step) — the single most reliable movement signal.
  pushDir(join(gitDir, "logs"));

  return { headDirs, refDirs };
}

/** Hard cap on live watchers, whatever a workspace resolves to. */
const MAX_WATCHED_DIRS = 64;

export class GitNexusIndexSupervisor {
  private status: GitNexusIndexStatus = { status: "unknown" };
  private root: string | null = null; // the opened folder (status.workspacePath)
  private targets: string[] = []; // resolved repo roots to analyze
  private currentTarget: string | null = null; // target the running child indexes
  private child: ChildProcess | null = null;
  /** The cross-process index lock the running analyze holds. Released on exit. */
  private indexLock: GitNexusIndexLockHandle | null = null;
  private running = false;
  private stopped = false;
  private readonly lastAnalyzeAt = new Map<string, number>(); // per-target
  private readonly targetError = new Map<string, string>(); // per-target error note
  /**
   * Targets an OPERATOR explicitly asked to re-index. They bypass `needsIndex`
   * (a `ready`+fresh repo is exactly the case a human re-indexes when they no
   * longer trust the store) and are cleared when that target's analyze exits.
   */
  private readonly forced = new Set<string>();
  /** Who asked for the analyze that is running / that last failed. */
  private lastTrigger: GitNexusIndexTrigger | undefined;
  private perTarget: GitNexusRepoStatus[] = []; // last per-target projections
  private debounceHandle: TimerHandle | null = null;
  private watchdogHandle: TimerHandle | null = null;
  // The "already scheduled" guards are BOOLEANS set BEFORE `setTimer`, never the
  // handles: a setTimer that runs its callback synchronously (the test clock
  // does) assigns the handle AFTER the callback already cleared it, so a
  // handle-based guard would latch on a stale id and never schedule again.
  private debouncePending = false;
  private rewatchPending = false;
  // ---- HEAD watching ----
  private watchers: GitWatchHandle[] = [];
  private watchedPaths: string[] = []; // keyed plan, for idempotent re-watching
  private rewatchHandle: TimerHandle | null = null;
  private lastWatchPlanAt = Number.NEGATIVE_INFINITY;
  private lastRefreshAt = Number.NEGATIVE_INFINITY;
  /** A REAL trigger (bind / HEAD moved / analyze exited) — refresh now. */
  private forceRefresh = false;

  private readonly resolveTargets: (root: string) => string[];
  private readonly acquireIndexLock: (
    target: string
  ) => GitNexusIndexLockAttempt;
  private readonly spawn: typeof nodeSpawn;
  private readonly execPath: string;
  private readonly resolveCli: () => ResolvedGitNexusCli | null;
  private readonly readMeta: (ws: string) => Promise<GitNexusMeta | null>;
  private readonly readHead: (ws: string) => Promise<string | null>;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly debounceMs: number;
  private readonly minIntervalMs: number;
  private readonly statusRefreshMs: number;
  private readonly analyzeTimeoutMs: number;
  private readonly extraAnalyzeArgs: string[];
  private readonly watchFs: GitWatchFs;

  constructor(private readonly options: GitNexusIndexSupervisorOptions = {}) {
    this.resolveTargets =
      options.resolveTargets ?? ((root) => safeResolveTargets(root));
    this.acquireIndexLock =
      options.acquireIndexLock ??
      ((target) => acquireGitNexusIndexLock(target, { owner: "desktop" }));
    this.spawn = options.spawn ?? nodeSpawn;
    this.execPath = options.execPath ?? process.execPath;
    const moduleDir = options.moduleDir ?? __dirname;
    this.resolveCli = options.resolveCli ?? defaultResolveCli(moduleDir);
    this.readMeta = options.readMeta ?? defaultReadMeta;
    this.readHead = options.readHead ?? defaultReadHead;
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const h = setTimeout(fn, ms);
        (h as { unref?: () => void }).unref?.();
        return h;
      });
    this.clearTimer =
      options.clearTimer ??
      ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.debounceMs = Math.max(0, options.debounceMs ?? 3000);
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? 300_000);
    this.statusRefreshMs = Math.max(0, options.statusRefreshMs ?? 15_000);
    this.analyzeTimeoutMs = Math.max(
      10_000,
      options.analyzeTimeoutMs ?? 600_000
    );
    this.extraAnalyzeArgs = options.extraAnalyzeArgs ?? [];
    this.watchFs = options.watchFs ?? defaultGitWatchFs;
  }

  /** Immutable snapshot for IPC/state projection. */
  getStatus(): GitNexusIndexStatus {
    return { ...this.status };
  }

  /**
   * Point the supervisor at a workspace (idempotent). Switching workspaces
   * forces a fresh check; re-binding the same one just nudges ensureIndexed.
   */
  bind(workspacePath: string): void {
    if (this.stopped) return;
    if (typeof workspacePath !== "string" || workspacePath.length === 0) return;
    if (workspacePath === this.root) {
      // main re-binds on EVERY 2s state poll. Do the cheap things only: nudge,
      // and (throttled) retry watching if we have no live watchers yet — e.g.
      // the repo was cloned/`git init`ed after we bound the folder.
      this.maybeRewatch();
      this.ensureIndexed();
      return;
    }
    this.root = workspacePath;
    // Auto Repository Detection: resolve the opened folder to the git repo(s) to
    // index — a single repo, or the members of a monorepo of separate repos.
    // We NEVER analyze a non-git parent (which is what exited code 1). [] = a
    // clean "nothing to index" state, not an error.
    try {
      this.targets = this.resolveTargets(workspacePath) ?? [];
    } catch {
      this.targets = [];
    }
    // A new workspace is never rate-limited; per-target maps start empty.
    this.lastAnalyzeAt.clear();
    this.targetError.clear();
    this.forced.clear();
    this.lastTrigger = undefined;
    this.perTarget = [];
    this.lastRefreshAt = Number.NEGATIVE_INFINITY;
    this.lastWatchPlanAt = Number.NEGATIVE_INFINITY;
    this.forceRefresh = true;
    this.setStatus({ status: "unknown", workspacePath });
    // Watch the new targets' HEADs so a commit re-indexes without a focus event.
    this.syncWatchers();
    void this.refreshStatus().catch(() => undefined);
    this.ensureIndexed();
  }

  /**
   * Debounced request to make the active workspace's index current.
   *
   * The window is anchored to the FIRST trigger of a burst: once a check is
   * scheduled, later triggers ride the same timer instead of pushing it out.
   *
   * A re-arming trailing debounce is STARVABLE, and was actually starved in
   * production: main re-binds the workspace on every 2s `muon:state` poll, and
   * `bind(sameRoot)` calls this — so a 3s timer was cleared and re-created every
   * 2s and `maybeSpawn()` NEVER ran. Nothing was ever re-indexed and the masthead
   * froze at whatever the last workspace switch happened to read. HEAD watching
   * would have been starved through the exact same door, so this is load-bearing.
   */
  ensureIndexed(): void {
    if (this.stopped || !this.root) return;
    if (this.debouncePending) return; // already scheduled — ride that timer
    this.debouncePending = true;
    this.debounceHandle = this.setTimer(() => {
      this.debouncePending = false;
      this.debounceHandle = null;
      void this.maybeSpawn().catch((error) => this.log(error));
    }, this.debounceMs);
  }

  /**
   * OPERATOR-triggered re-index. The escape hatch for the case the background
   * loop cannot serve: an index that FAILED, or one that looks fine and is not.
   *
   * It differs from `ensureIndexed()` in four ways, all deliberate:
   *  1. **No debounce.** The human already waited; we spawn on this tick.
   *  2. **No cooldown.** `minIntervalMs` exists to stop a hot loop re-analyzing
   *     on every nudge. A human clicking a button is not a hot loop, so the
   *     per-target `lastAnalyzeAt` is cleared for exactly the requested targets.
   *  3. **Bypasses `needsIndex`.** A `ready`+fresh repo is precisely what an
   *     operator re-indexes when they stopped trusting the store.
   *  4. **May pass `--force`** (see `needsForceReindex`) — without it, GitNexus
   *     early-returns "already up to date" and the button would be a lie.
   *
   * SINGLE-IN-FLIGHT: if an analyze is already running this REFUSES with
   * `already-running` rather than spawning a second one. Two concurrent analyze
   * runs against one `.gitnexus/` store race on the same DB files, and the
   * full-rebuild path wipes them — so the guard is a correctness guard, not
   * politeness. Mashing the button is therefore idempotent.
   *
   * That guard is per-supervisor and therefore blind to MUON's OTHER indexer:
   * the MCP server refreshes the same store from its own OS process. So the
   * cross-process lock is taken HERE, before any state is touched, and the same
   * `already-running` refusal covers both — one vocabulary, one meaning.
   *
   * Synchronous and non-blocking: it returns the DECISION, the analyze runs in a
   * detached child. Never throws — every failure is an `accepted:false` value
   * the UI can render.
   *
   * @param repoPath Optional single target (a `path` from `status.repos`). It
   * MUST be one of this workspace's resolved targets — an unrecognized path is
   * refused, never analyzed, so the untrusted renderer cannot aim the indexer at
   * an arbitrary directory.
   */
  reindexNow(repoPath?: string): GitNexusReindexResult {
    if (this.stopped) {
      return {
        accepted: false,
        reason: "stopped",
        note: "No workspace is bound to the code graph right now.",
      };
    }
    if (!this.root) {
      return {
        accepted: false,
        reason: "no-repo",
        note: "No workspace is bound to the code graph right now.",
      };
    }
    const requested = repoPath?.trim();
    let targets: string[];
    if (requested) {
      if (!this.targets.includes(requested)) {
        return {
          accepted: false,
          reason: "unknown-repo",
          note: "That repository is not part of the open workspace.",
        };
      }
      targets = [requested];
    } else {
      targets = [...this.targets];
    }
    if (targets.length === 0) {
      return {
        accepted: false,
        reason: "no-repo",
        note: "No git repository found here to index.",
      };
    }
    const cli = this.resolveCliSafe();
    if (!cli) {
      return {
        accepted: false,
        reason: "cli-missing",
        note: `GitNexus CLI not found, so MUON cannot re-index for you. Run \`${GITNEXUS_MANUAL_REINDEX_COMMAND}\` in the repository yourself.`,
      };
    }
    if (this.running) {
      return {
        accepted: false,
        reason: "already-running",
        note: "An index run is already in progress — waiting for it to finish.",
      };
    }
    const first = targets[0]!;
    const attempt = this.takeIndexLock(first);
    if (!attempt.acquired) {
      // Another MUON process holds this store. Refuse — never queue, never
      // spawn alongside it — and say so in the vocabulary the UI already renders.
      return {
        accepted: false,
        reason:
          attempt.reason === "held" ? "already-running" : "lock-unavailable",
        note:
          attempt.reason === "held"
            ? `${attempt.note} Waiting for it to finish.`
            : attempt.note,
      };
    }

    for (const target of targets) {
      this.lastAnalyzeAt.delete(target); // the cooldown does not apply to a human
      this.targetError.delete(target); // clear the old failure; this run decides
      this.forced.add(target);
    }
    this.forceRefresh = true;
    const force = needsForceReindex(
      this.perTarget.find((per) => per.path === first)
    );
    // Only the FIRST target is spawned here; each analyze exit nudges the loop,
    // which picks up the remaining forced targets one at a time (single-in-flight).
    this.spawnAnalyze(cli, first, {
      force,
      trigger: "manual",
      lock: attempt.lock,
    });
    return {
      accepted: true,
      targets,
      forced: force,
      note:
        targets.length > 1
          ? `Re-indexing ${targets.length} repositories.`
          : force
            ? "Rebuilding the code graph from scratch."
            : "Updating the code graph to the current commit.",
    };
  }

  /**
   * Clear timers and release the analyze child WITHOUT awaiting it. Idempotent.
   * The child is detached + unref'd; a killed mid-run leaves
   * `incrementalInProgress`, which the NEXT analyze auto-recovers.
   *
   * The index lock is deliberately NOT released here: the SIGTERM'd child is
   * detached and may still be writing the store for a moment. Its `exit`
   * handler releases (that fires even after stop), and if this process dies
   * first the lock's recorded child pid keeps the store protected until the
   * analyze itself is gone.
   */
  stop(): void {
    this.stopped = true;
    this.debouncePending = false;
    this.rewatchPending = false;
    if (this.debounceHandle !== null) {
      this.clearTimer(this.debounceHandle);
      this.debounceHandle = null;
    }
    if (this.watchdogHandle !== null) {
      this.clearTimer(this.watchdogHandle);
      this.watchdogHandle = null;
    }
    if (this.rewatchHandle !== null) {
      this.clearTimer(this.rewatchHandle);
      this.rewatchHandle = null;
    }
    this.closeWatchers(); // every fd released; nothing survives a rebind
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill("SIGTERM"); // best-effort, non-blocking
      } catch {
        // detached + unref'd: dropping the reference is enough
      }
    }
  }

  // ─── HEAD watching lifecycle ────────────────────────────────────────────

  /**
   * (Re)establish the HEAD watchers for the resolved targets. Idempotent: an
   * unchanged plan keeps the live watchers. Never throws — a repo we cannot
   * resolve or watch is simply skipped and we degrade to the bind + window-focus
   * nudges, which still work.
   */
  private syncWatchers(): void {
    if (this.stopped || !this.root) {
      this.closeWatchers();
      return;
    }
    this.lastWatchPlanAt = this.now();
    const plan = new Map<string, boolean>(); // dir → filter to HEAD_FILES?
    for (const target of this.targets) {
      if (plan.size >= MAX_WATCHED_DIRS) break;
      let dirs: GitWatchPlan;
      try {
        dirs = planGitWatch(target, this.watchFs);
      } catch (error) {
        this.log(error); // an unresolvable repo is just not watched
        continue;
      }
      for (const dir of dirs.headDirs) if (!plan.has(dir)) plan.set(dir, true);
      for (const dir of dirs.refDirs) if (!plan.has(dir)) plan.set(dir, false);
    }
    const entries = [...plan.entries()].slice(0, MAX_WATCHED_DIRS);
    const keyed = entries.map(([dir, filtered]) => `${filtered ? "H" : "R"}:${dir}`);
    if (this.watchers.length > 0 && sameList(keyed, this.watchedPaths)) return;
    this.closeWatchers();
    this.watchedPaths = keyed;
    for (const [dir, filtered] of entries) this.openWatch(dir, filtered);
  }

  /** Retry watching (throttled) when we have targets but no live watchers. */
  private maybeRewatch(): void {
    if (this.stopped || this.targets.length === 0) return;
    if (this.watchers.length > 0) return;
    if (this.now() - this.lastWatchPlanAt < this.statusRefreshMs) return;
    this.syncWatchers();
  }

  private openWatch(dir: string, headFilesOnly: boolean): void {
    let handle: GitWatchHandle | null = null;
    try {
      handle = this.watchFs.watch(
        dir,
        (filename) => this.onGitDirEvent(filename, headFilesOnly),
        (error) => {
          // Deleted dir / permission change: drop THIS watcher and carry on —
          // never throw, never take the other repos down with it.
          if (handle) this.removeWatcher(handle);
          this.log(error);
        }
      );
    } catch (error) {
      this.log(error);
      handle = null;
    }
    if (handle) this.watchers.push(handle);
  }

  /**
   * A write landed in a watched git dir. This is only a HINT: it feeds the same
   * debounce, and `refreshStatus()` still compares HEAD to `meta.lastCommit`
   * before anything is spawned. A rebase can move HEAD dozens of times a second
   * — they all collapse into one scheduled check, then the per-target rate limit.
   */
  private onGitDirEvent(filename: string | null, headFilesOnly: boolean): void {
    if (this.stopped) return;
    if (headFilesOnly && filename !== null && !HEAD_FILES.has(filename)) return;
    // HEAD itself changed ⇒ possibly a different branch ⇒ a different loose-ref
    // file to watch. Re-plan, debounced (at most one pending re-plan).
    if (filename === null || filename === "HEAD") this.scheduleRewatch();
    this.forceRefresh = true; // a real movement signal, not a routine poll
    this.ensureIndexed();
  }

  private scheduleRewatch(): void {
    if (this.stopped || this.rewatchPending) return;
    this.rewatchPending = true;
    this.rewatchHandle = this.setTimer(() => {
      this.rewatchPending = false;
      this.rewatchHandle = null;
      if (!this.stopped) this.syncWatchers();
    }, this.debounceMs);
  }

  private removeWatcher(handle: GitWatchHandle): void {
    const index = this.watchers.indexOf(handle);
    if (index >= 0) this.watchers.splice(index, 1);
    try {
      handle.close();
    } catch {
      // best-effort
    }
    // Force a fresh plan on the next opportunity (the dir may be gone).
    this.watchedPaths = [];
    this.lastWatchPlanAt = Number.NEGATIVE_INFINITY;
  }

  private closeWatchers(): void {
    const open = this.watchers;
    this.watchers = [];
    this.watchedPaths = [];
    for (const handle of open) {
      try {
        handle.close();
      } catch {
        // best-effort — dropping the reference is enough
      }
    }
  }

  /** Live watcher count (tests / diagnostics). */
  getWatchedPathCount(): number {
    return this.watchers.length;
  }

  private async maybeSpawn(): Promise<void> {
    if (this.stopped || this.running || !this.root) return;
    // Routine nudges (main rebinds every 2s) must not re-read meta.json + shell
    // out to `git rev-parse` every debounce window. Real triggers set
    // forceRefresh and bypass the floor.
    const force = this.forceRefresh;
    this.forceRefresh = false;
    if (!force && this.now() - this.lastRefreshAt < this.statusRefreshMs) return;
    const cli = this.resolveCliSafe();
    if (!cli) {
      // No CLI: we can still surface existing indexes read-only, never spawn.
      await this.refreshStatus();
      return;
    }
    await this.refreshStatus(); // refresh per-target statuses
    const target = this.nextTargetToIndex();
    if (!target) return;
    this.spawnAnalyze(cli, target);
  }

  /** Has this target's cooldown elapsed? (A never-attempted target: yes.) */
  private rateOk(target: string): boolean {
    return (
      this.now() -
        (this.lastAnalyzeAt.get(target) ?? Number.NEGATIVE_INFINITY) >=
      this.minIntervalMs
    );
  }

  /** Does this repo need (re)indexing at all, rate limit aside? */
  private needsIndex(per: GitNexusRepoStatus): boolean {
    // An operator asked for THIS repo: their judgement outranks our heuristic.
    if (this.forced.has(per.path)) return true;
    const neverIndexed = per.status === "idle" || per.status === "unknown";
    const stale = per.stale === true;
    const headUnknown = per.stale === undefined && per.status === "ready";
    return neverIndexed || stale || headUnknown || per.status === "error";
  }

  /**
   * The first repo target that needs (re)indexing AND is past its per-target
   * cooldown. null when all are current (or cooling down). Returning ONE at a
   * time keeps analyze single-in-flight; each exit re-nudges, so a monorepo
   * indexes sequentially.
   *
   * The cooldown covers the never-indexed case too: an analyze that exits 0
   * without writing meta.json would otherwise leave the repo "never indexed"
   * forever and be respawned on every single nudge — an unbounded spin. A fresh
   * bind() clears `lastAnalyzeAt`, so a newly opened workspace still indexes now.
   */
  private nextTargetToIndex(): string | null {
    for (const per of this.perTarget) {
      if (this.needsIndex(per) && this.rateOk(per.path)) return per.path;
    }
    return null;
  }

  /** Take the cross-process lock for `target`. Never throws — always a value. */
  private takeIndexLock(target: string): GitNexusIndexLockAttempt {
    try {
      return this.acquireIndexLock(target);
    } catch (error) {
      return {
        acquired: false,
        reason: "unavailable",
        note: `MUON could not open the index lock: ${this.reason(error)}`,
      };
    }
  }

  /**
   * Spawn one analyze against `target`, holding the cross-process index lock
   * for the whole life of the child. Returns false when nothing was spawned
   * because another MUON process owns this store — the caller decides what that
   * means (the operator gets a refusal, the background loop just tries later).
   *
   * `options.lock` is an ALREADY-held lock (reindexNow takes it before it
   * mutates any state, so it can refuse cleanly); otherwise we take it here.
   */
  private spawnAnalyze(
    cli: ResolvedGitNexusCli,
    target: string,
    options: {
      force?: boolean;
      trigger?: GitNexusIndexTrigger;
      lock?: GitNexusIndexLockHandle;
    } = {}
  ): boolean {
    const root = this.root;
    if (!root) {
      options.lock?.release(); // never strand a lock the caller took for us
      return false;
    }
    let lock = options.lock ?? null;
    if (!lock) {
      const attempt = this.takeIndexLock(target);
      if (!attempt.acquired) {
        // MUON is already indexing this store from another process. Do not
        // spawn, do not burn the cooldown, do not mark an error — the next
        // nudge re-checks and picks it up once the store is free again.
        this.log(`skipping analyze for ${basename(target)}: ${attempt.note}`);
        return false;
      }
      lock = attempt.lock;
    }
    const trigger: GitNexusIndexTrigger = options.trigger ?? "auto";
    this.indexLock = lock;
    this.lastAnalyzeAt.set(target, this.now());
    this.currentTarget = target;
    this.running = true;
    this.lastTrigger = trigger;
    // Immediate "indexing" on the workspace; refreshStatus fills in per-repo.
    this.setStatus({
      ...this.status,
      status: "indexing",
      workspacePath: root,
      trigger,
    });

    let child: ChildProcess;
    try {
      child = this.spawn(
        cli.binary,
        [
          ...cli.commandPrefix,
          "analyze",
          target, // the RESOLVED repo root — always a git work-tree
          "--index-only",
          // Operator-triggered recovery only. A full rebuild is the ONLY way
          // back from a half-written store, and without it GitNexus short-
          // circuits an up-to-date repo and the retry would silently no-op.
          ...(options.force ? ["--force"] : []),
          ...this.extraAnalyzeArgs,
        ],
        {
          cwd: target,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: {
            ...process.env,
            // Electron-as-node so the bundled CLI runs under process.execPath.
            ELECTRON_RUN_AS_NODE: "1",
            // Hard rule: no new egress — never install an extension over the net.
            GITNEXUS_LBUG_EXTENSION_INSTALL: "load-only",
          },
        }
      );
    } catch (error) {
      this.running = false;
      this.currentTarget = null;
      this.releaseIndexLock(); // nothing is indexing: never hold the store hostage
      this.forced.delete(target); // the request was served (badly) — do not loop
      const note = `GitNexus analyze failed to spawn: ${this.reason(error)}`;
      this.targetError.set(target, note);
      // A failed spawn is the CLI itself failing (affects every repo) — surface
      // it synchronously so a single-repo workspace shows error immediately;
      // refreshStatus then reconciles the per-repo detail.
      this.setStatus({
        ...this.status,
        status: "error",
        workspacePath: root,
        reason: "last-attempt-failed",
        note,
      });
      this.forceRefresh = true;
      void this.refreshStatus().catch((err) => this.log(err));
      return false;
    }

    this.child = child;
    // The child is DETACHED: it outlives a killed supervisor. Recording its pid
    // in the lock keeps the store protected until the ANALYZE is gone, not just
    // until we are — otherwise a crashed desktop would free a store that is
    // still being rewritten.
    if (typeof child.pid === "number") lock.adoptChild(child.pid);
    child.unref();
    child.on("error", (error) => this.log(error)); // not exit evidence
    this.watchdogHandle = this.setTimer(() => {
      this.watchdogHandle = null;
      if (this.child === child) {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    }, this.analyzeTimeoutMs);

    child.on("exit", (code, signal) => {
      if (this.watchdogHandle !== null) {
        this.clearTimer(this.watchdogHandle);
        this.watchdogHandle = null;
      }
      if (this.child === child) this.child = null;
      this.running = false;
      this.currentTarget = null;
      // The store is free the moment the child is gone — clean exit, non-zero
      // exit, or a signal. Released BEFORE the stopped-guard below, so quitting
      // mid-analyze still hands the lock back instead of leaving MUON's other
      // process to wait out the stale-lock timeout.
      if (this.indexLock === lock) this.indexLock = null;
      lock.release();
      // The operator's request for THIS repo is served, pass or fail. Leaving it
      // set would make the loop re-spawn forever on a repo that keeps failing.
      this.forced.delete(target);
      if (this.stopped) return;
      if (code !== 0) {
        // Record this repo's failure; other repos still index. The next nudge
        // re-reads status and moves on to the next target that needs work.
        this.targetError.set(
          target,
          `GitNexus analyze exited (${
            code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`
          })`
        );
      } else {
        this.targetError.delete(target);
      }
      // An analyze exit is a real transition — never let the refresh floor
      // swallow it, or the masthead would lag a whole window behind the graph.
      this.forceRefresh = true;
      // Re-project status, then nudge to index the NEXT target needing it.
      void this.refreshStatus()
        .catch((error) => this.log(error))
        .finally(() => this.ensureIndexed());
    });
    return true;
  }

  /**
   * Hand the store back. Idempotent (the handle's own release is too) and it
   * never touches store data — only MUON's own lock file.
   */
  private releaseIndexLock(): void {
    const lock = this.indexLock;
    this.indexLock = null;
    lock?.release();
  }

  /** Read each target's meta.json + HEAD (best-effort) and aggregate the status. */
  private async refreshStatus(): Promise<void> {
    const root = this.root;
    if (!root || this.stopped) return;
    this.lastRefreshAt = this.now();
    const cliMissing = this.resolveCliSafe() === null;
    const perTarget: GitNexusRepoStatus[] = [];
    for (const target of this.targets) {
      let meta: GitNexusMeta | null = null;
      let head: string | null = null;
      try {
        meta = await this.readMeta(target);
      } catch {
        meta = null;
      }
      try {
        head = await this.readHead(target);
      } catch {
        head = null;
      }
      if (this.root !== root || this.stopped) return; // superseded
      const running = this.running && this.currentTarget === target;
      const projected = projectGitNexusStatus(meta, {
        workspacePath: target,
        head,
        running,
        cliMissing,
        // "not indexed" splits into "queued now" vs "cooling down, will retry".
        retryBlocked: !this.rateOk(target),
      });
      const errNote = this.targetError.get(target);
      const failed = Boolean(errNote) && !running;
      perTarget.push({
        path: target,
        name: basename(target),
        status: failed ? "error" : projected.status,
        symbolCount: projected.symbolCount,
        lastIndexedAt: projected.lastIndexedAt,
        indexedCommit: projected.indexedCommit,
        stale: projected.stale,
        reason: failed ? "last-attempt-failed" : projected.reason,
        note: failed ? errNote : projected.note,
      });
    }
    this.perTarget = perTarget;
    this.setStatus(
      aggregateTargetStatus(perTarget, {
        workspacePath: root,
        running: this.running,
        cliMissing,
        trigger: this.lastTrigger,
      })
    );
  }

  private resolveCliSafe(): ResolvedGitNexusCli | null {
    try {
      return this.resolveCli();
    } catch {
      return null;
    }
  }

  private setStatus(next: GitNexusIndexStatus): void {
    if (statusEqual(this.status, next)) return;
    this.status = next;
    try {
      this.options.onChange?.({ ...next });
    } catch {
      // a renderer-push failure must never break the supervisor
    }
  }

  private log(error: unknown): void {
    this.options.onLog?.(`gitnexus-index: ${this.reason(error)}`);
  }

  private reason(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(
      0,
      300
    );
  }
}

/** Pure status projection — the unit-testable heart of the state model. */
export function projectGitNexusStatus(
  meta: GitNexusMeta | null,
  context: {
    workspacePath: string;
    head: string | null;
    running: boolean;
    cliMissing: boolean;
    /** The per-repo cooldown has NOT elapsed — a needed index must wait. */
    retryBlocked?: boolean;
  }
): GitNexusIndexStatus {
  const base: GitNexusIndexStatus = {
    status: "unknown",
    workspacePath: context.workspacePath,
  };
  if (context.running) {
    return { ...base, status: "indexing" };
  }
  if (!meta) {
    return context.cliMissing
      ? {
          ...base,
          status: "unknown",
          reason: "cli-missing",
          note: "GitNexus CLI not found; indexing unavailable",
        }
      : {
          ...base,
          status: "idle",
          reason: context.retryBlocked ? "rate-limited" : "never-indexed",
        };
  }
  const indexedCommit =
    typeof meta.lastCommit === "string" ? meta.lastCommit : undefined;
  const stale =
    context.head && indexedCommit ? context.head !== indexedCommit : undefined;
  return {
    ...base,
    status: "ready",
    symbolCount:
      typeof meta.stats?.nodes === "number" ? meta.stats.nodes : undefined,
    lastIndexedAt:
      typeof meta.indexedAt === "string" ? meta.indexedAt : undefined,
    indexedCommit,
    ...(stale === undefined ? {} : { stale }),
    ...(context.cliMissing
      ? {
          reason: "cli-missing" as const,
          note: "read-only: GitNexus CLI not found (cannot re-index)",
        }
      : {}),
  };
}

/**
 * Does an OPERATOR-triggered re-index of this repo need `analyze --force`?
 *
 * Pure, so the rule is testable without spawning anything. `--force` wipes the
 * store and rebuilds from scratch — correct but expensive, so we only reach for
 * it when an incremental run would be wrong or would do nothing at all:
 *
 *  - **no per-repo status** — we know nothing about the store, trust nothing;
 *  - **`error`** — the last analyze failed, so the store may be half-written.
 *    A full rebuild is the only documented way back to a known-good index;
 *  - **`ready` and NOT stale** — HEAD matches the indexed commit, so GitNexus
 *    early-returns "already up to date" and an incremental re-index is a no-op.
 *    This is the "it says ready but I don't believe it" click, and it MUST do
 *    real work or the button lies.
 *
 * Everything else (stale, never-indexed, mid-flight) has real incremental work
 * to do and gets the cheap path.
 */
export function needsForceReindex(
  per: GitNexusRepoStatus | undefined
): boolean {
  if (!per) return true;
  if (per.status === "error") return true;
  if (per.status === "ready") return per.stale !== true;
  return false;
}

/** Fail-safe target resolution for the supervisor default: never throws. */
function safeResolveTargets(root: string): string[] {
  try {
    return resolveIndexTargets(root);
  } catch {
    return [];
  }
}

/**
 * Aggregate per-repo statuses into the single workspace status the navbar
 * renders. Pure + unit-testable. Semantics: 0 repos → a CLEAN idle "nothing to
 * index" (never error); any indexing → indexing; any still-pending → idle (the
 * loop keeps going); all failed → error; otherwise ready with summed symbols and
 * a "N repos" note. The per-repo list rides along for the multi-repo graph tabs.
 */
export function aggregateTargetStatus(
  perTarget: GitNexusRepoStatus[],
  context: {
    workspacePath: string;
    running: boolean;
    cliMissing: boolean;
    /** Who asked for the analyze in flight / the one that just failed. */
    trigger?: GitNexusIndexTrigger;
  }
): GitNexusIndexStatus {
  // `trigger` answers "is this MY re-index?" — meaningless for a settled phase,
  // so it rides only the two phases an analyze run actually produces.
  const withTrigger = <T extends GitNexusIndexStatus>(status: T): T =>
    (status.status === "indexing" || status.status === "error") &&
    context.trigger
      ? { ...status, trigger: context.trigger }
      : status;
  const base: GitNexusIndexStatus = {
    status: "unknown",
    workspacePath: context.workspacePath,
  };
  const count = perTarget.length;
  if (count === 0) {
    return context.cliMissing
      ? {
          ...base,
          reason: "cli-missing",
          note: "GitNexus CLI not found; indexing unavailable",
        }
      : {
          ...base,
          status: "idle",
          reason: "no-repo",
          note: "No git repository found here to index",
        };
  }
  const repos = perTarget;
  if (count === 1) {
    // Single repo: behave EXACTLY like the one per-repo projection (preserving
    // every ready/idle/stale/cli-missing nuance), just at the workspace root.
    const r = perTarget[0]!;
    return withTrigger({
      status: r.status,
      workspacePath: context.workspacePath,
      ...(r.symbolCount !== undefined ? { symbolCount: r.symbolCount } : {}),
      ...(r.lastIndexedAt !== undefined ? { lastIndexedAt: r.lastIndexedAt } : {}),
      ...(r.indexedCommit !== undefined
        ? { indexedCommit: r.indexedCommit }
        : {}),
      ...(r.stale !== undefined ? { stale: r.stale } : {}),
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
      ...(r.note !== undefined ? { note: r.note } : {}),
      repos,
    });
  }
  const ready = perTarget.filter((r) => r.status === "ready").length;
  const errored = perTarget.filter((r) => r.status === "error").length;
  const pendingRepos = perTarget.filter(
    (r) => r.status === "idle" || r.status === "unknown"
  );
  const pending = pendingRepos.length;
  const indexing =
    context.running || perTarget.some((r) => r.status === "indexing");
  const symbolCount =
    perTarget.reduce((n, r) => n + (r.symbolCount ?? 0), 0) || undefined;
  const stale = perTarget.some((r) => r.stale === true) ? true : undefined;
  const lastIndexedAt = perTarget
    .map((r) => r.lastIndexedAt)
    .filter((t): t is string => typeof t === "string")
    .sort()
    .pop();

  if (indexing) {
    return withTrigger({
      ...base,
      status: "indexing",
      repos,
      ...(count > 1
        ? { note: `Indexing ${Math.min(ready + 1, count)}/${count} repos` }
        : {}),
    });
  }
  if (pending > 0) {
    // More repos still to index — the loop will pick them up on the next nudge,
    // unless every one of them is cooling down (then say THAT, not "queued").
    const allCoolingDown = pendingRepos.every(
      (r) => r.reason === "rate-limited"
    );
    return {
      ...base,
      status: "idle",
      reason: allCoolingDown ? "rate-limited" : "queued",
      repos,
      ...(count > 1 ? { note: `${ready}/${count} repos indexed` } : {}),
    };
  }
  if (ready === 0 && errored > 0) {
    return withTrigger({
      ...base,
      status: "error",
      reason: "last-attempt-failed",
      repos,
      note:
        perTarget.find((r) => r.status === "error")?.note ??
        "GitNexus analyze failed",
    });
  }
  return {
    ...base,
    status: "ready",
    symbolCount,
    repos,
    ...(stale ? { stale } : {}),
    ...(lastIndexedAt ? { lastIndexedAt } : {}),
    ...(count > 1
      ? {
          note:
            errored > 0
              ? `${ready} of ${count} repos · ${errored} failed`
              : `${count} repos`,
        }
      : {}),
  };
}

function reposEqual(
  a: GitNexusRepoStatus[] | undefined,
  b: GitNexusRepoStatus[] | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((r, i) => {
    const o = b[i]!;
    return (
      r.path === o.path &&
      r.status === o.status &&
      r.symbolCount === o.symbolCount &&
      r.lastIndexedAt === o.lastIndexedAt &&
      r.stale === o.stale &&
      r.reason === o.reason &&
      r.note === o.note
    );
  });
}

/** Order-sensitive string-list equality (the watcher plan key). */
function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function statusEqual(
  a: GitNexusIndexStatus,
  b: GitNexusIndexStatus
): boolean {
  return (
    a.status === b.status &&
    a.workspacePath === b.workspacePath &&
    a.symbolCount === b.symbolCount &&
    a.lastIndexedAt === b.lastIndexedAt &&
    a.indexedCommit === b.indexedCommit &&
    a.stale === b.stale &&
    a.reason === b.reason &&
    a.note === b.note &&
    a.trigger === b.trigger &&
    reposEqual(a.repos, b.repos)
  );
}
