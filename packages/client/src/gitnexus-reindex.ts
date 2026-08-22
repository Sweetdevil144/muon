import { execFile, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import {
  acquireGitNexusIndexLock,
  type GitNexusIndexLockAttempt,
} from "./gitnexus-index-lock.js";
import {
  probeGitNexusIndexFreshness,
  type GitNexusIndexFreshness,
} from "./gitnexus-freshness.js";

const execFileAsync = promisify(execFile);

// ADR-0054 — ONE headless, one-shot reindex of a local GitNexus store.
//
// The desktop already owns a long-lived index supervisor (debounce, HEAD
// watching, multi-repo queue, an operator button). This is deliberately NOT
// that: it is the single bounded decision-and-run that a surface WITHOUT an
// event loop needs — the CLI today, the TUI next — so a headless operator is
// not the only one whose graph goes stale and stays stale.
//
// Nothing here is new authority and nothing here is a second guard. The
// cross-process index lock (`gitnexus-index-lock.ts`) is the SAME one the
// desktop and the MCP server take, so all three exclude each other; the drift
// check is the SAME `.gitnexus/meta.json` + HEAD read the dispatch-time probe
// uses (D9). What this module adds is the composition, plus the one fence
// neither caller had: never index a governed worktree.

/**
 * Why nothing was spawned. Every arm is a VALUE the caller renders — the
 * coordinator never throws a decision, because a surface that cannot say why
 * nothing happened renders it as progress.
 */
export type GitNexusReindexSkip =
  /** The path is not a git work-tree (or git could not be reached). */
  | "no-repo"
  /**
   * The path is a LINKED worktree, not the primary checkout. Refused, never
   * silently redirected: see {@link classifyCheckout}.
   */
  | "governed-worktree"
  /** Another MUON process (or this one) holds the cross-process index lock. */
  | "already-running"
  /** The lock could not be created at all — we must not pretend we hold it. */
  | "lock-unavailable"
  /** No GitNexus CLI to spawn. */
  | "cli-missing"
  /** `auto` only: the graph's indexed commit already matches HEAD. */
  | "already-fresh"
  /** `auto` only: the store was indexed more recently than the floor allows. */
  | "cooling-down";

/**
 * WHO asked. The same two words the desktop supervisor uses, with the same
 * meaning, because they select the same two policies:
 *
 *  - `auto`   — a background trigger. Honours the drift check and the interval
 *               floor; does nothing when the graph is already current.
 *  - `manual` — a human asked. Skips both, and forces a full rebuild when the
 *               store *claims* to be current, because "it says ready and I do
 *               not believe it" is exactly the click this serves and an
 *               incremental run would early-return and make the gesture a lie.
 */
export type GitNexusReindexTrigger = "auto" | "manual";

export type GitNexusReindexOutcome =
  | {
      status: "skipped";
      skip: GitNexusReindexSkip;
      /** The primary checkout, when we got far enough to resolve one. */
      repoRoot?: string;
      /** What the store said, when we got far enough to read it. */
      before?: GitNexusIndexFreshness;
      note: string;
    }
  | {
      status: "reindexed";
      repoRoot: string;
      /** `analyze --force` (a full rebuild) rather than an incremental pass. */
      forced: boolean;
      before: GitNexusIndexFreshness;
      /**
       * Re-read from the store AFTER the run. This is the honest proof and the
       * reason the outcome carries it: the run exiting clean is what `analyze`
       * reported, `after` is what the store now says. A surface quotes `after`,
       * never our own optimism.
       */
      after: GitNexusIndexFreshness;
      elapsedMs: number;
      note: string;
    }
  | {
      status: "failed";
      repoRoot: string;
      forced: boolean;
      before: GitNexusIndexFreshness;
      /** Re-read after the FAILURE too — a failed run must never be reported
       *  as fresh, and only the store can say what survived. */
      after: GitNexusIndexFreshness;
      elapsedMs: number;
      /** Bounded failure text. Never a token, never a path we did not resolve. */
      reason: string;
      note: string;
    };

/**
 * Run `gitnexus analyze <repoRoot> --index-only [--force]`. Resolves on a clean
 * exit, rejects otherwise. Injected rather than resolved here: `@muon/client`
 * does not depend on the `gitnexus` package, and three copies of that
 * resolution already exist — a fourth is how they drift.
 */
export type GitNexusAnalyzeRunner = (input: {
  repoRoot: string;
  force: boolean;
}) => Promise<void>;

/**
 * The minimum gap between AUTOMATIC runs against one store. Five minutes, the
 * same floor the desktop supervisor uses, because it is the same cost being
 * bounded: a full index of this repository measures ~27s of CPU, and a trigger
 * that fires per commit would spend a rebase rebuilding the graph. `manual`
 * bypasses it — a human clicking a button is not a hot loop.
 */
export const GITNEXUS_REINDEX_MIN_INTERVAL_MS = 300_000;

/** The command an operator runs when MUON cannot spawn the indexer itself. */
export const GITNEXUS_MANUAL_ANALYZE_COMMAND =
  "npx gitnexus analyze . --index-only --force";

export type CheckoutClassification = {
  /** The primary checkout root, when git named one. */
  primary?: string;
  /**
   * `path` is a linked worktree, not the primary checkout. Git's own test:
   * a linked worktree's `--git-dir` is `<primary>/.git/worktrees/<name>` while
   * its `--git-common-dir` stays `<primary>/.git`. Subdirectory-safe, unlike
   * comparing the path to the root.
   */
  linkedWorktree: boolean;
  /** The path carries MUON's own governed-worktree shape (`.muon/worktrees/`). */
  governedShape: boolean;
};

/**
 * Is this path the primary checkout, or a worktree that must never be indexed?
 *
 * PURE over facts the caller already gathered, so the RULE lives once and both
 * a sync caller (the desktop resolves targets synchronously) and an async one
 * (this module) reach the same verdict. Two independent arms, on purpose:
 *
 *  1. **Git's answer** — `--git-dir` !== `--git-common-dir`. This is the only
 *     arm that catches MUON's real layout, because governed worktrees live at
 *     `~/.muon/worktrees/<profile>/<repo>-<hash>`, entirely OUTSIDE the
 *     checkout (`packages/core/src/worktree.ts`). A path-shape test alone would
 *     miss every worktree MUON creates today.
 *  2. **MUON's path shape** — a `.muon/worktrees` path SEGMENT. This catches
 *     the pre-5.14 in-repo layout that older trees still hold, and it survives
 *     git being unavailable or answering wrongly. Segment-matched, not
 *     substring-matched, so `my.muon/worktreesish` is not a worktree.
 *
 * Indexing a worktree is not merely wasteful: a governed worktree is a full
 * copy of the repository, so it would build a SECOND `.gitnexus/` store for
 * the same code, at a commit no other surface reads, while the primary store
 * that every brain tool actually queries stays stale.
 */
export function classifyCheckout(input: {
  /** The path asked about. */
  path: string;
  /** `git rev-parse --path-format=absolute --git-dir`, trimmed. */
  gitDir?: string;
  /** `git rev-parse --path-format=absolute --git-common-dir`, trimmed. */
  gitCommonDir?: string;
}): CheckoutClassification {
  const gitDir = input.gitDir?.trim();
  const commonDir = input.gitCommonDir?.trim();
  const primary =
    commonDir && isAbsolute(commonDir) ? resolve(commonDir, "..") : undefined;
  return {
    ...(primary ? { primary } : {}),
    linkedWorktree: Boolean(gitDir && commonDir && gitDir !== commonDir),
    governedShape: hasGovernedWorktreeSegment(input.path),
  };
}

/** `.muon` followed by `worktrees` as adjacent path SEGMENTS, anywhere. */
function hasGovernedWorktreeSegment(path: string): boolean {
  const segments = path.split(/[/\\]/);
  return segments.some(
    (segment, index) => segment === ".muon" && segments[index + 1] === "worktrees"
  );
}

export type GitNexusReindexDeps = {
  /**
   * `null` ⇒ the GitNexus CLI could not be resolved, so nothing is ever
   * spawned. Required rather than optional: an absent runner would make the
   * whole coordinator a silent no-op that reports success.
   */
  runAnalyze: GitNexusAnalyzeRunner | null;
  /** `git <args>` in `cwd`, resolving to stdout. Rejects → the fact is unknown. */
  runGit?: (args: string[], cwd: string) => Promise<string>;
  readFreshness?: (repoRoot: string) => Promise<GitNexusIndexFreshness>;
  acquireLock?: (repoRoot: string) => GitNexusIndexLockAttempt;
  now?: () => number;
  minIntervalMs?: number;
};

export type GitNexusReindexInput = {
  /** Where the operator is standing. Resolved to the primary checkout. */
  workspacePath: string;
  trigger: GitNexusReindexTrigger;
  /** Force a full rebuild regardless of what the store claims. */
  force?: boolean;
};

async function defaultRunGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    encoding: "utf8",
    windowsHide: true,
  });
  return String(stdout);
}

/** Where a start directory's code graph lives, or why there is no answer. */
export type PrimaryCheckoutResolution =
  | { ok: true; repoRoot: string }
  | {
      ok: false;
      skip: Extract<GitNexusReindexSkip, "no-repo" | "governed-worktree">;
      /** The primary checkout to use instead, when git named one. */
      repoRoot?: string;
      note: string;
    };

/**
 * Resolve a start directory to the PRIMARY checkout whose store every brain tool
 * reads, or refuse.
 *
 * One implementation, because two callers need the same verdict for different
 * jobs — the reindex before it spawns anything, and a read surface before it
 * quotes a store. Two copies of "which checkout is this" is how one command
 * reports on a store another command never touches.
 */
export async function resolvePrimaryCheckout(
  workspacePath: string,
  deps: { runGit?: (args: string[], cwd: string) => Promise<string> } = {}
): Promise<PrimaryCheckoutResolution> {
  const runGit = deps.runGit ?? defaultRunGit;
  const asked = resolve(workspacePath);
  const readFlag = (flag: string): Promise<string | undefined> =>
    runGit(["rev-parse", "--path-format=absolute", flag], asked)
      .then((out) => out.trim() || undefined)
      .catch(() => undefined);
  const [gitDir, gitCommonDir] = await Promise.all([
    readFlag("--git-dir"),
    readFlag("--git-common-dir"),
  ]);
  const checkout = classifyCheckout({
    path: asked,
    ...(gitDir ? { gitDir } : {}),
    ...(gitCommonDir ? { gitCommonDir } : {}),
  });
  if (checkout.linkedWorktree || checkout.governedShape) {
    // REFUSED, not redirected. Silently indexing the primary instead would make
    // one command mean two different things depending on where it was run, and
    // a governed child asking about "this workspace" would quietly get an
    // answer about a repository it has no business rebuilding. Naming the
    // primary keeps the refusal actionable.
    return {
      ok: false,
      skip: "governed-worktree",
      ...(checkout.primary ? { repoRoot: checkout.primary } : {}),
      note: checkout.primary
        ? `That path is a governed worktree, not the primary checkout. A worktree is a full copy of the repository, so its graph would be a second store nothing reads. Use the primary checkout instead: ${checkout.primary}`
        : "That path is a governed worktree, not the primary checkout, so MUON will not index it.",
    };
  }
  if (!checkout.primary) {
    return {
      ok: false,
      skip: "no-repo",
      note: "No git repository here to index.",
    };
  }
  return { ok: true, repoRoot: checkout.primary };
}

/**
 * Reindex the code graph for `workspacePath`'s primary checkout, or say why not.
 *
 * The order of the checks is the whole design, and it is cheapest-and-most-
 * refusable first:
 *
 *  1. **Fence** the target to the primary checkout. A worktree is refused
 *     before anything is read, because the answer does not depend on the store.
 *  2. **Read** the store's freshness (one fs read + one `git rev-parse`).
 *  3. **Decide** — `auto` stops here when the graph is current or the floor has
 *     not elapsed. No lock is taken and no subprocess is spawned for a no-op.
 *  4. **Lock**, cross-process, before any work. Contention REFUSES; it never
 *     queues, because the caller is a command a human is waiting on and a
 *     rebuild takes minutes.
 *  5. **Run**, then re-read the store and report what IT says.
 *
 * Never throws. Idempotent under concurrency by the lock, so two callers at
 * once produce exactly one subprocess and one `already-running`.
 */
export async function reindexCodeGraph(
  input: GitNexusReindexInput,
  deps: GitNexusReindexDeps
): Promise<GitNexusReindexOutcome> {
  const runGit = deps.runGit ?? defaultRunGit;
  // MUST resolve HEAD. `readGitNexusIndexFreshness` without a `headCommit`
  // returns `missing` for a perfectly good store ("indexed, but not PROVABLY
  // fresh"), which would break both halves of the decision below: the drift
  // check could never see `fresh`, and the force rule treats `missing` as "know
  // nothing, trust nothing" — so every automatic run would do a full ~27s
  // rebuild instead of an incremental pass. Caught by running the real command,
  // not by the suite: every unit test injects this seam.
  const readFreshness = deps.readFreshness ?? probeGitNexusIndexFreshness;
  const acquireLock =
    deps.acquireLock ??
    ((repoRoot: string) => acquireGitNexusIndexLock(repoRoot, { owner: "cli" }));
  const now = deps.now ?? Date.now;
  const minIntervalMs = Math.max(
    0,
    deps.minIntervalMs ?? GITNEXUS_REINDEX_MIN_INTERVAL_MS
  );

  // ─── 1. fence ───────────────────────────────────────────────────────────
  const checkout = await resolvePrimaryCheckout(input.workspacePath, { runGit });
  if (!checkout.ok) {
    return {
      status: "skipped",
      skip: checkout.skip,
      ...(checkout.repoRoot ? { repoRoot: checkout.repoRoot } : {}),
      note: checkout.note,
    };
  }
  const repoRoot = checkout.repoRoot;

  // ─── 2. read ────────────────────────────────────────────────────────────
  let before: GitNexusIndexFreshness;
  try {
    before = await readFreshness(repoRoot);
  } catch {
    // An unreadable store is the case a reindex exists to fix, so a probe
    // failure must not refuse the reindex — it only means we know nothing.
    before = { status: "missing" };
  }

  // ─── 3. decide ──────────────────────────────────────────────────────────
  if (input.trigger === "auto" && !input.force) {
    if (before.status === "fresh") {
      return {
        status: "skipped",
        skip: "already-fresh",
        repoRoot,
        before,
        note: "The code graph is already at the current commit.",
      };
    }
    const indexedAtMs = before.indexedAt ? Date.parse(before.indexedAt) : NaN;
    if (
      Number.isFinite(indexedAtMs) &&
      now() - indexedAtMs < minIntervalMs
    ) {
      // The floor reads the store's OWN `indexedAt` rather than a stamp file
      // this module would have to keep: the last successful index time is
      // already recorded, by the process that did the work, and a one-shot
      // command has no memory of its previous run to consult.
      //
      // HONEST LIMIT, accepted: `indexedAt` records the last SUCCESS, so a repo
      // whose analyze keeps failing is never rate-limited here — a caller
      // looping `--if-stale` would re-run it every time. Bounded by the lock
      // (never two at once) and loud rather than silent (`failed` + exit 1 on
      // every attempt), so the cadence stays the caller's to fix. The desktop
      // supervisor, which owns its own loop and therefore cannot delegate that
      // judgement, keys its floor on the last ATTEMPT instead.
      return {
        status: "skipped",
        skip: "cooling-down",
        repoRoot,
        before,
        note: `The code graph was indexed less than ${Math.round(
          minIntervalMs / 1000
        )}s ago; not re-indexing automatically. Ask for it explicitly to override.`,
      };
    }
  }

  if (!deps.runAnalyze) {
    return {
      status: "skipped",
      skip: "cli-missing",
      repoRoot,
      before,
      note: `GitNexus CLI not found, so MUON cannot re-index for you. Run \`${GITNEXUS_MANUAL_ANALYZE_COMMAND}\` in the repository yourself.`,
    };
  }

  // ─── 4. lock ────────────────────────────────────────────────────────────
  let attempt: GitNexusIndexLockAttempt;
  try {
    attempt = acquireLock(repoRoot);
  } catch (error) {
    attempt = {
      acquired: false,
      reason: "unavailable",
      note: `MUON could not open the index lock: ${bounded(error)}`,
    };
  }
  if (!attempt.acquired) {
    return {
      status: "skipped",
      skip: attempt.reason === "held" ? "already-running" : "lock-unavailable",
      repoRoot,
      before,
      note:
        attempt.reason === "held"
          ? `${attempt.note} Waiting for it to finish is the only correct move — a second run would race it.`
          : attempt.note,
    };
  }

  // ─── 5. run ─────────────────────────────────────────────────────────────
  // Force when an incremental pass would be wrong or would do nothing at all.
  // The same rule the desktop's `needsForceReindex` applies, in freshness
  // vocabulary: `missing` (we know nothing about the store, so trust nothing)
  // and a `manual` run against a store that claims to be current (GitNexus
  // early-returns "already up to date", so the gesture must rebuild or lie).
  // `stale` has real incremental work and gets the cheap path.
  let forced =
    input.force === true ||
    before.status === "missing" ||
    (input.trigger === "manual" && before.status === "fresh");
  const startedAt = now();
  let failure: string | undefined;
  try {
    try {
      await deps.runAnalyze({ repoRoot, force: forced });
    } catch (error) {
      if (forced) throw error;
      // ONE bounded force retry, inside the SAME lock. GitNexus marks an
      // interrupted incremental in its meta and a full rebuild is the
      // documented way back; the retry is the destructive one, so it must
      // never overlap another MUON process. Never spin past this.
      forced = true;
      try {
        await deps.runAnalyze({ repoRoot, force: true });
      } catch {
        throw error; // report the FIRST cause; the retry is the remedy, not the news
      }
    }
  } catch (error) {
    failure = bounded(error);
  } finally {
    attempt.lock.release();
  }
  const elapsedMs = Math.max(0, now() - startedAt);

  // Re-read on BOTH paths. The store is the only witness that can say what the
  // run actually left behind, and a failed run that happened to complete its
  // write is genuinely fresh while a "clean" exit that wrote nothing is not.
  let after: GitNexusIndexFreshness;
  try {
    after = await readFreshness(repoRoot);
  } catch {
    after = { status: "missing" };
  }

  if (failure !== undefined) {
    return {
      status: "failed",
      repoRoot,
      forced,
      before,
      after,
      elapsedMs,
      reason: failure,
      note: `The index run failed (${failure}). The code graph is ${describeStatus(
        after
      )} — treat graph-backed answers as UNKNOWN risk, never clear.`,
    };
  }
  return {
    status: "reindexed",
    repoRoot,
    forced,
    before,
    after,
    elapsedMs,
    // Quotes `after`, never "done". An analyze that exits clean without
    // bringing the store to HEAD has still not made the graph current, and
    // saying so is the whole point of re-reading.
    note: `${forced ? "Rebuilt" : "Updated"} the code graph in ${Math.round(
      elapsedMs / 1000
    )}s. It is now ${describeStatus(after)}.`,
  };
}

/** One honest phrase for a freshness value. Never the word "fresh" alone for
 *  a store that could not prove it. */
function describeStatus(freshness: GitNexusIndexFreshness): string {
  if (freshness.status === "fresh") return "at the current commit";
  if (freshness.status === "stale") {
    return `still BEHIND the current commit (indexed ${
      freshness.indexedCommit?.slice(0, 8) ?? "unknown"
    }, HEAD is ${freshness.headCommit?.slice(0, 8) ?? "unknown"})`;
  }
  return "not readable — no usable index is present";
}

function bounded(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

// ── Where an INSTALLED machine keeps its gitnexus ───────────────────────────
//
// Founder acceptance testing (2026-08-19) found that NO installed channel had a
// code graph: both the CLI's and the desktop's resolvers probed only
// monorepo-relative `packages/mcp` paths — which exist in a dev checkout and
// nowhere else — so every packaged desktop and every tarball install reported
// "GitNexus CLI not found", refused RE-INDEX, and could not read the graph.
//
// The fix has two halves. The release tarball now DEPENDS on `gitnexus`
// (bundle-release.mjs), so an installed `muon-cli` carries it in its own
// node_modules — reachable from the installed entry with the resolvers'
// existing `paths: [moduleDir]` probe. This helper is the OTHER half: the
// desktop app (a DMG has no npm install of its own) and a DMG-linked CLI shim
// find the MACHINE's copy — the global `muon-cli` install, or a standalone
// `npm i -g gitnexus`. One implementation, shared by both resolvers, because
// two resolvers disagreeing about which GitNexus is this machine's is how a
// status line reports a store that a re-index never touches.

/** Runs `npm root -g` (bounded); injectable for tests. */
export type NpmGlobalRootProbe = () => string | null;

/** `npm root -g`, ONCE per process, shared. This probe used to exist as four
 *  independent copies (CLI resolver, desktop supervisor, muon-mcp, desktop
 *  cli-refresh), each with its own caching semantics — the exact
 *  two-answers-to-one-question drift the resolvers themselves warn about.
 *  Sync by design: every caller sits inside a synchronous resolve path.
 *  (The desktop's post-update CLI refresh keeps its own ASYNC probe — it runs
 *  on Electron's main thread, where a spawnSync is never acceptable.) */
let cachedNpmGlobalRoot: string | null | undefined;

export function resolveNpmGlobalRootSync(): string | null {
  if (cachedNpmGlobalRoot !== undefined) return cachedNpmGlobalRoot;
  try {
    const found = spawnSync("npm", ["root", "-g"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    const root = found.status === 0 ? String(found.stdout).trim() : "";
    cachedNpmGlobalRoot = root.length > 0 ? root : null;
  } catch {
    cachedNpmGlobalRoot = null;
  }
  return cachedNpmGlobalRoot;
}

/**
 * Base directories to hand to `require.resolve("gitnexus/package.json",
 * {paths: [base]})`, in order. Resolution semantics matter here: a base of
 * `<root>/muon-cli` finds `<root>/muon-cli/node_modules/gitnexus` (the tarball
 * dependency), and a base of `dirname(<root>)` finds `<root>/gitnexus` (a
 * standalone global install), because require.resolve probes each base's OWN
 * `node_modules` child.
 */
export function globalGitNexusResolveBases(input: {
  readonly npmGlobalRoot: NpmGlobalRootProbe;
  /** `os.homedir()`; injectable for tests. */
  readonly home: string;
}): readonly string[] {
  const roots: string[] = [];
  const fromNpm = input.npmGlobalRoot();
  if (fromNpm) roots.push(fromNpm);
  // Static fallbacks for a machine where `npm` itself is not spawnable from
  // this process (Finder-launched app before PATH fix, npm-less shells): the
  // two conventional prefixes plus the user-writable one our docs recommend
  // for EACCES-free global installs.
  roots.push(
    "/opt/homebrew/lib/node_modules",
    "/usr/local/lib/node_modules",
    `${input.home}/.npm-global/lib/node_modules`
  );
  const bases: string[] = [];
  for (const root of roots) {
    const normalized = root.replace(/\/+$/, "");
    if (!normalized) continue;
    // The muon-cli install's own dependency first — that is the copy pinned to
    // the version this machine's MUON was tested with.
    const muonCliBase = `${normalized}/muon-cli`;
    if (!bases.includes(muonCliBase)) bases.push(muonCliBase);
    // Then a standalone `npm i -g gitnexus`: resolving with the PARENT of the
    // global root as base makes `<root>/gitnexus` itself the probe target.
    const parent = normalized.split("/").slice(0, -1).join("/");
    if (parent && !bases.includes(parent)) bases.push(parent);
  }
  return bases;
}

// ── Which gitnexus on this machine can READ this machine's store ────────────
//
// Measured on a real 0.4.8 install (2026-08-20): every code-graph tool failed
// with
//   LadybugDB unavailable for muon … Database file version: 42,
//   Current build storage version: 40
// because the machine's global `gitnexus` (1.6.9) had written the store and
// MUON's own exact pin (1.6.5) could not read it. The store format moves
// forward; a NEWER reader opens an older store, an older reader cannot open a
// newer one. First-found resolution therefore picks exactly the wrong copy
// whenever the install's pin lags what indexed the repo — and the pin lagging
// is the normal case, since `.gitnexus/run.cjs analyze` deliberately selects
// the newest runner available.
//
// The exact pin stays (a caret would drift the SHIPPED reader to builds no
// test in this repo has run against). What changes is that the reader stops
// assuming it also wrote the store.

export type GitNexusCandidate = {
  /** Absolute path to the resolved `gitnexus/package.json`. */
  readonly manifestPath: string;
  /** That manifest's `version`, when it could be read. */
  readonly version: string | null;
};

/** Numeric-segment version compare. Returns >0 when `a` is newer. Unparseable
 *  input sorts LAST (a version we cannot read is not evidence of newness). */
export function compareGitNexusVersions(a: string | null, b: string | null): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, "")
      .split("-")[0]!
      .split(".")
      .map((part) => Number.parseInt(part, 10));
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i];
    const r = right[i];
    // A non-numeric segment makes the whole comparison unreliable; treat the
    // pair as equal rather than inventing an order.
    if (!Number.isFinite(l ?? Number.NaN) && !Number.isFinite(r ?? Number.NaN)) {
      return 0;
    }
    const li = Number.isFinite(l ?? Number.NaN) ? (l as number) : 0;
    const ri = Number.isFinite(r ?? Number.NaN) ? (r as number) : 0;
    if (li !== ri) return li - ri;
  }
  return 0;
}

/** Read a gitnexus manifest's version. ONE implementation — the three
 *  resolvers each carried a verbatim copy, which is three places for a future
 *  manifest shape (workspace protocol, BOM, missing field) to drift. */
export function readGitNexusVersion(
  manifestPath: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf8")
): string | null {
  try {
    const parsed = JSON.parse(read(manifestPath)) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Every resolvable candidate, NEWEST FIRST — a ranked list, not a winner.
 *
 * Ranking rather than picking is deliberate. LadybugDB's storage check is an
 * EXACT match, so "newest" is a heuristic and not a compatibility guarantee:
 * a store written at v40 by MUON's own pin is equally unreadable by a newer
 * global copy. The caller walks this list and escalates on a skew failure
 * instead of betting everything on one choice with no fallback.
 *
 * Ties keep the earlier base, so a same-version local copy still beats a
 * global one — locality breaks ties, it never overrides a newer reader.
 */
export function rankGitNexusManifests(
  bases: readonly string[],
  resolveManifest: (base: string) => string | null,
  readVersion: (manifestPath: string) => string | null = (p) =>
    readGitNexusVersion(p)
): readonly GitNexusCandidate[] {
  const seen = new Set<string>();
  const candidates: GitNexusCandidate[] = [];
  for (const base of bases) {
    const manifestPath = resolveManifest(base);
    if (!manifestPath || seen.has(manifestPath)) continue;
    seen.add(manifestPath);
    candidates.push({ manifestPath, version: readVersion(manifestPath) });
  }
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (a, b) =>
        compareGitNexusVersions(b.candidate.version, a.candidate.version) ||
        a.index - b.index
    )
    .map((entry) => entry.candidate);
}


/** True when a failure is the store-format skew above, not a missing install.
 *  The two lead to opposite remedies, so they must never share a message. */
export function isGitNexusStorageSkew(reason: string): boolean {
  return (
    /different version|storage version/i.test(reason) &&
    /database file|build storage/i.test(reason)
  );
}

/** True when the STORE predates the reader — the direction whose only fix is
 *  re-indexing. Exported so the prose remedy and the machine-actionable
 *  `nextActions` beside it cannot disagree about which way the skew runs. */
export function storeOlderThanReader(reason: string): boolean {
  const store = Number(/database file version:\s*(\d+)/i.exec(reason)?.[1]);
  const reader = Number(/build storage version:\s*(\d+)/i.exec(reason)?.[1]);
  return Number.isFinite(store) && Number.isFinite(reader) && store < reader;
}

/**
 * The remedy, which DEPENDS ON THE DIRECTION of the skew — LadybugDB reports
 * both directions with the same "different version" sentence, and they have
 * opposite fixes:
 *   store NEWER than reader → re-analyzing widens the gap; get a newer reader.
 *   store OLDER than reader → re-analyzing IS the fix; nothing else rewrites
 *                             the store into the current format.
 * A blanket "never re-analyze" was wrong for half the cases — and that half
 * became MORE likely the moment resolution started preferring newer readers.
 */
export function gitNexusStorageSkewAction(reason: string): string {
  const store = Number(/database file version:\s*(\d+)/i.exec(reason)?.[1]);
  const reader = Number(/build storage version:\s*(\d+)/i.exec(reason)?.[1]);
  // Named because resolution is memoized per process: an operator who exports
  // the variable and retries in the same session gets the identical failure.
  const restart =
    " Restart this session afterwards — the code-graph resolution is made once per process.";
  if (storeOlderThanReader(reason)) {
    return (
      `This workspace's GitNexus index was written in an OLDER store format (v${store}) than the reader MUON resolved (v${reader}), ` +
      "so the index must be REBUILT, not refreshed: run `gitnexus analyze --index-only --force` in this workspace. " +
      "(`--force` is required — it deletes and rewrites the store files; an incremental run against a store this reader cannot open reproduces the same error.)" +
      restart
    );
  }
  const versions =
    Number.isFinite(store) && Number.isFinite(reader)
      ? ` (store v${store}, reader v${reader})`
      : "";
  return (
    `This machine's GitNexus index was written by a NEWER GitNexus than the one MUON resolved${versions}, ` +
    "so MUON cannot read it. Do NOT re-run `gitnexus analyze` — a newer indexer only widens the gap. " +
    "Update MUON (`muon update`) so it ships a reader at least as new as the indexer, or point MUON at " +
    "the newer copy with MUON_GITNEXUS_BIN=$(command -v gitnexus)." +
    restart
  );
}
