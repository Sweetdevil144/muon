import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { resolveDataDir } from "@muon/client/paths";
import {
  prepareWorktreeDependencies,
  type WorktreePreparation,
} from "./worktree-prep.js";

const execFileAsync = promisify(execFile);
const MAX_DIFF_STDERR_BYTES = 64 * 1024;
const GIT_MERGE_COMMAND_TIMEOUT_MS = 45_000;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: GIT_MERGE_COMMAND_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

export async function resolveRepoRoot(cwd: string): Promise<string> {
  try {
    const output = await git(cwd, "rev-parse", "--show-toplevel");
    return output.trim();
  } catch {
    throw new Error(
      `'${cwd}' is not inside a git repository. --worktree needs a git repo.`
    );
  }
}

export async function isLinkedWorktree(cwd: string): Promise<boolean> {
  try {
    const [gitDir, commonGitDir] = await Promise.all([
      git(cwd, "rev-parse", "--absolute-git-dir"),
      git(
        cwd,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir"
      ),
    ]);
    const [canonicalGitDir, canonicalCommonGitDir] = await Promise.all([
      realpath(gitDir.trim()),
      realpath(commonGitDir.trim()),
    ]);
    return canonicalGitDir !== canonicalCommonGitDir;
  } catch {
    return false;
  }
}

function sanitizeTaskId(taskId: string): string {
  const sanitized = taskId.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/\.+/g, ".");
  if (sanitized.length === 0 || /^[.-]+$/.test(sanitized)) {
    throw new Error(`Task id '${taskId}' cannot be mapped to a worktree name.`);
  }
  return sanitized;
}

export type TaskWorktree = {
  path: string;
  created: boolean;
  /** What {@link prepareWorktreeDependencies} linked into this worktree. */
  preparation: WorktreePreparation;
};

function realpathOfNearestExisting(input: string): string {
  let cursor = resolve(input);
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return resolve(input);
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

function gitDirFromFile(markerPath: string): string | undefined {
  try {
    const marker = lstatSync(markerPath);
    if (!marker.isFile() || marker.isSymbolicLink()) return undefined;
    const match = /^gitdir:\s*(.+)\s*$/i.exec(readFileSync(markerPath, "utf8"));
    if (!match?.[1]) return undefined;
    return realpathOfNearestExisting(resolve(dirname(markerPath), match[1]));
  } catch {
    return undefined;
  }
}

function commonGitDir(repoRoot: string): string | undefined {
  const markerPath = join(realpathOfNearestExisting(repoRoot), ".git");
  try {
    const marker = lstatSync(markerPath);
    if (marker.isDirectory() && !marker.isSymbolicLink()) {
      return realpathSync(markerPath);
    }
  } catch {
    return undefined;
  }

  const gitDir = gitDirFromFile(markerPath);
  if (!gitDir) return undefined;
  try {
    const relativeCommon = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    if (relativeCommon) {
      return realpathOfNearestExisting(resolve(gitDir, relativeCommon));
    }
  } catch {
    // A checkout made with --separate-git-dir has no commondir; its gitdir is
    // itself the common directory used by `git worktree add`.
  }
  return gitDir;
}

/** Prove that a candidate is a linked worktree owned by this repository. */
export function isOwnedLinkedWorktree(repoRoot: string, candidate: string): boolean {
  try {
    const directory = lstatSync(candidate);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
  } catch {
    return false;
  }

  const markerPath = join(candidate, ".git");
  const gitDir = gitDirFromFile(markerPath);
  const common = commonGitDir(repoRoot);
  if (!gitDir || !common) return false;
  const worktrees = realpathOfNearestExisting(join(common, "worktrees"));
  if (!gitDir.startsWith(`${worktrees}${sep}`)) return false;

  try {
    const backlink = readFileSync(join(gitDir, "gitdir"), "utf8").trim();
    if (!backlink) return false;
    return (
      realpathOfNearestExisting(resolve(gitDir, backlink)) ===
      realpathOfNearestExisting(markerPath)
    );
  } catch {
    return false;
  }
}

/**
 * Default worktree storage. Three constraints, all learned the hard way:
 *
 *  1. OUTSIDE the source repository (TODO 5.14) — otherwise recursive tooling
 *     and agents mistake a task tree for the repo's own source.
 *  2. OUTSIDE the data dir — the sandboxed runner is Seatbelt-blinded to that
 *     entire subpath (deny file-read* and file-write*, re-asserted last,
 *     ADR-0010 F2), so a root under it is a directory the very process that
 *     must CREATE the trees cannot read.
 *  3. **NO SPACES.** This is the one that bit a real run. Both previous
 *     defaults lived under `~/Library/Application Support/…`, and a huge
 *     amount of ordinary repo tooling mishandles a space in an absolute path.
 *     MUON's own `vitest.config.ts` aliased `@` via `new URL(...).pathname`,
 *     which percent-encodes — so inside a governed worktree every aliased
 *     import resolved to `…/Application%20Support/…` and the agent's test run
 *     failed for a reason it did not cause and could not fix. The loop then
 *     burned iterations re-running a suite that could never pass (2026-08-05).
 *     MUON chooses where governed work happens, so MUON owns that failure.
 *
 * `~/.muon/worktrees` satisfies all three. The per-profile hash keeps two data
 * profiles (a dev desktop and a packaged app) from sharing a tree.
 *
 * HONEST LIMIT: this guarantees MUON does not ADD a space. It cannot promise a
 * space-free path if the user's own home directory contains one.
 */
function defaultWorktreesStorage(): string {
  const dataDir = resolve(resolveDataDir());
  const profile = createHash("sha256").update(dataDir).digest("hex").slice(0, 12);
  return join(homedir(), ".muon", "worktrees", profile);
}

/**
 * Storage roots a tree created by an EARLIER MUON may still live under, newest
 * first. Never used to create anything — only so in-flight work stays
 * locatable, reviewable and landable across an upgrade, exactly as the
 * pre-5.14 nested layout is.
 */
function legacyWorktreesStorages(): string[] {
  const dataDir = resolve(resolveDataDir());
  return [
    // 2026-08-04: sibling of the data dir. Correct about the sandbox, wrong
    // about spaces.
    join(dirname(dataDir), `${basename(dataDir)}-worktrees`),
    // 5.14's original: inside the data dir, which the runner cannot read.
    join(dataDir, "worktrees"),
  ];
}

/**
 * The durable, per-repository directory for NEW governed worktrees. It lives
 * outside the checkout so recursive tooling cannot mistake a task tree for
 * source owned by the primary repository, and outside the sandbox-denied data
 * dir so the confined runner can create and edit it (see
 * {@link defaultWorktreesStorage}). The readable repository basename is
 * paired with a path hash so two checkouts named `app` never share a crew.
 *
 * `MUON_WORKTREE_ROOT` is an operator/test override. It must itself resolve
 * outside the repository AND outside the Seatbelt-denied data dir; an override
 * that points into either fails closed instead of silently recreating a bug
 * this layout removes (constraint 1 or 2 above). The data-dir check applies
 * ONLY to the override: the defaults satisfy it by construction, and the
 * read-only legacy candidates below deliberately include the old in-data-dir
 * layout so pre-5.14 work stays locatable.
 *
 * Every process serving one profile MUST resolve the same root: the desktop
 * supervisor passes `MUON_DATA_DIR` to BOTH the brain and the runner children
 * precisely so this function cannot split-brain between the process that
 * creates a tree and the process that validates it.
 */
export function managedWorktreesRoot(repoRoot: string): string {
  const configuredRoot = process.env.MUON_WORKTREE_ROOT?.trim();
  if (configuredRoot) {
    assertOverrideOutsideDataDir(configuredRoot);
  }
  return repoScopedRoot(
    repoRoot,
    configuredRoot || defaultWorktreesStorage()
  );
}

/**
 * Constraint 2, enforced for the operator override: the sandboxed runner is
 * blinded to the whole data dir (deny file-read* and file-write*, ADR-0010
 * F2), so a configured root under it names a directory the very process that
 * must create the trees cannot read — every governed dispatch would then fail
 * with an unrelated-looking permissions error deep inside `git worktree add`.
 */
function assertOverrideOutsideDataDir(configuredRoot: string): void {
  const dataDir = realpathOfNearestExisting(resolve(resolveDataDir()));
  const storage = realpathOfNearestExisting(configuredRoot);
  if (storage === dataDir || storage.startsWith(`${dataDir}${sep}`)) {
    throw new Error(
      `MUON_WORKTREE_ROOT '${storage}' is inside the MUON data dir '${dataDir}', ` +
        "which the sandboxed runner cannot read (ADR-0010). " +
        "Set it to a directory outside the data dir."
    );
  }
}

/**
 * Every root a task tree for this repo may live under, current first. Only
 * `managedWorktreesRoot` (index 0) is ever created; the rest exist so an
 * upgrade never strands work an earlier layout owns.
 */
export function managedWorktreesRootCandidates(repoRoot: string): string[] {
  const configuredRoot = process.env.MUON_WORKTREE_ROOT?.trim();
  if (configuredRoot) {
    // An explicit operator root is the whole answer: MUON must not go hunting
    // through defaults the operator deliberately overrode.
    assertOverrideOutsideDataDir(configuredRoot);
    return [repoScopedRoot(repoRoot, configuredRoot)];
  }
  const roots = [defaultWorktreesStorage(), ...legacyWorktreesStorages()];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const storage of roots) {
    let scoped: string;
    try {
      scoped = repoScopedRoot(repoRoot, storage);
    } catch {
      continue; // a legacy root that would now resolve inside the repo
    }
    if (!seen.has(scoped)) {
      seen.add(scoped);
      out.push(scoped);
    }
  }
  return out;
}

/** `<storage>/<readable repo name>-<hash of its canonical path>`. */
function repoScopedRoot(repoRoot: string, storageRoot: string): string {
  const repo = realpathOfNearestExisting(repoRoot);
  const storage = realpathOfNearestExisting(storageRoot);
  if (storage === repo || storage.startsWith(`${repo}${sep}`)) {
    throw new Error(
      `MUON worktree storage '${storage}' is inside repository '${repo}'. ` +
        "Set MUON_WORKTREE_ROOT to a directory outside the repository."
    );
  }
  const readable =
    basename(repo).replace(/[^a-zA-Z0-9._-]/g, "-").replace(/\.+/g, ".") ||
    "repo";
  const identity = createHash("sha256").update(repo).digest("hex").slice(0, 12);
  return join(storage, `${readable}-${identity}`);
}

/** The pre-5.14 layout, retained only to find and finish already-running jobs. */
export function legacyTaskWorktreePath(repoRoot: string, taskId: string): string {
  return join(repoRoot, ".muon", "worktrees", sanitizeTaskId(taskId));
}

/**
 * PURE path computation for a NEW task's governed worktree. Promoted out of
 * {@link ensureTaskWorktree} (P0.1 checkpoint+resume, Slice C3) so resume
 * verification can LOCATE a worktree to re-hash packet diff evidence
 * WITHOUT ever creating or checking one out.
 */
export function taskWorktreePath(repoRoot: string, taskId: string): string {
  return join(managedWorktreesRoot(repoRoot), sanitizeTaskId(taskId));
}

/** Current path first, then the one legacy path an upgraded install may own. */
export function taskWorktreeCandidates(
  repoRoot: string,
  taskId: string
): string[] {
  const task = sanitizeTaskId(taskId);
  return [
    // Current root first, then every earlier EXTERNAL root (a tree created by
    // a previous MUON must stay locatable), then the pre-5.14 nested layout.
    ...managedWorktreesRootCandidates(repoRoot).map((root) => join(root, task)),
    legacyTaskWorktreePath(repoRoot, taskId),
  ];
}

/**
 * Locate a task tree without creating it. New external trees win; the nested
 * path is a bounded compatibility read so in-flight pre-5.14 work remains
 * reviewable, resumable, and landable after an upgrade.
 */
export function locateTaskWorktreePath(
  repoRoot: string,
  taskId: string
): string {
  const candidates = taskWorktreeCandidates(repoRoot, taskId);
  const current = candidates[0]!;
  // First candidate that is genuinely a linked worktree OF THIS REPO wins; an
  // existing tree from an earlier layout is finished where it lives rather
  // than stranded. Nothing here creates anything.
  for (const candidate of candidates) {
    if (isOwnedLinkedWorktree(repoRoot, candidate)) return candidate;
  }
  return current;
}

/**
 * Creates a detached git worktree outside the source repository so a lane can
 * edit files without touching or nesting beneath the primary tree. During the
 * upgrade window it may reuse an already-existing same-repository legacy tree;
 * it never creates a new nested tree.
 *
 * A bare `git worktree add` leaves a tree that cannot run a single test:
 * `node_modules` is gitignored, so nothing — not the workspace packages, not
 * a test runner — resolves inside it. Preparation runs on BOTH the created and
 * the reused path (it is idempotent) and FAILS CLOSED, because a worker only
 * discovers an unprepared tree after burning its entire run on it.
 */
export async function ensureTaskWorktree(input: {
  repoRoot: string;
  taskId: string;
}): Promise<TaskWorktree> {
  const path = locateTaskWorktreePath(input.repoRoot, input.taskId);
  let created = false;

  if (existsSync(path)) {
    if (!isOwnedLinkedWorktree(input.repoRoot, path)) {
      throw new Error(
        `'${path}' exists but is not a linked worktree owned by this repository. Remove it and retry.`
      );
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    try {
      await git(input.repoRoot, "worktree", "add", "--detach", path);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "git worktree add failed";
      throw new Error(
        `Could not create worktree at '${path}': ${message.trim()}`
      );
    }
    created = true;
  }

  const preparation = await prepareWorktreeDependencies({
    sourceRoot: input.repoRoot,
    worktreePath: path,
  });
  if (preparation.problems.length > 0) {
    throw new Error(
      `this worktree is not test-capable: ${preparation.problems.join("; ")}`
    );
  }

  return { path, created, preparation };
}

/**
 * All files a worktree has touched relative to its base: tracked
 * modifications plus untracked new files, sorted and deduped.
 */
export async function worktreeChangedFiles(
  worktreePath: string
): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    git(worktreePath, "diff", "--name-only", "HEAD"),
    git(worktreePath, "ls-files", "--others", "--exclude-standard"),
  ]);

  const files = new Set(
    [...tracked.split("\n"), ...untracked.split("\n")].filter(
      (line) => line.length > 0
    )
  );
  return [...files].sort();
}

export type WorktreeCollision = {
  taskId: string;
  files: string[];
};

/**
 * Compares this task's changed files against every sibling in both the current
 * external store and the legacy nested store. The two-root scan is temporary
 * compatibility, but prevents an upgraded lane overlooking an older sibling.
 */
export async function detectWorktreeCollisions(input: {
  repoRoot: string;
  taskId: string;
}): Promise<WorktreeCollision[]> {
  const taskName = sanitizeTaskId(input.taskId);
  const ownPath = locateTaskWorktreePath(input.repoRoot, input.taskId);
  if (!existsSync(join(ownPath, ".git"))) {
    return [];
  }

  const ownFiles = new Set(await worktreeChangedFiles(ownPath));
  if (ownFiles.size === 0) {
    return [];
  }

  const collisions = new Map<string, Set<string>>();
  const roots = [
    managedWorktreesRoot(input.repoRoot),
    dirname(legacyTaskWorktreePath(input.repoRoot, input.taskId)),
  ];
  for (const worktreesRoot of roots) {
    if (!existsSync(worktreesRoot)) continue;
    const entries = await readdir(worktreesRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === taskName) continue;
      const siblingPath = join(worktreesRoot, entry.name);
      if (!isOwnedLinkedWorktree(input.repoRoot, siblingPath)) continue;
      const overlap = (await worktreeChangedFiles(siblingPath)).filter((file) =>
        ownFiles.has(file)
      );
      if (overlap.length > 0) {
        const files = collisions.get(entry.name) ?? new Set<string>();
        overlap.forEach((file) => files.add(file));
        collisions.set(entry.name, files);
      }
    }
  }

  return [...collisions.entries()]
    .map(([taskId, files]) => ({ taskId, files: [...files].sort() }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
}

async function withUntrackedIntentToAdd<T>(
  worktreePath: string,
  operation: () => Promise<T>
): Promise<T> {
  const untracked = (
    await git(
      worktreePath,
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard"
    )
  )
    .split("\0")
    .filter((path) => path.length > 0);

  try {
    if (untracked.length > 0) {
      await git(
        worktreePath,
        "--literal-pathspecs",
        "add",
        "--intent-to-add",
        "--",
        ...untracked
      );
    }
    return await operation();
  } finally {
    if (untracked.length > 0) {
      await git(
        worktreePath,
        "--literal-pathspecs",
        "reset",
        "--quiet",
        "--",
        ...untracked
      );
    }
  }
}

function utf8Prefix(bytes: Buffer, maxBytes: number): string {
  const decoder = new StringDecoder("utf8");
  return decoder.write(bytes.subarray(0, maxBytes));
}

export type WorktreeDiff = {
  text: string;
  truncated: boolean;
  totalBytes: number;
};

function streamWorktreeDiff(
  worktreePath: string,
  maxBytes: number,
  onChunk?: (chunk: Buffer) => void
): Promise<WorktreeDiff> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["diff", "--no-ext-diff", "--no-textconv", "HEAD"],
      {
        cwd: worktreePath,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    let retainedBytes = 0;
    let stderrBytes = 0;
    let stderrTotalBytes = 0;
    let settled = false;

    const onStdoutData = (chunk: Buffer) => {
      if (settled) {
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      // The sink sees EVERY stdout byte before the retention cap, so a
      // full-stream hash stays honest even when the retained text truncates.
      onChunk?.(bytes);
      totalBytes += bytes.length;
      const remaining = maxBytes - retainedBytes;
      if (remaining > 0) {
        const retained = bytes.subarray(0, remaining);
        stdoutChunks.push(Buffer.from(retained));
        retainedBytes += retained.length;
      }
    };

    const onStderrData = (chunk: Buffer) => {
      if (settled) {
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrTotalBytes += bytes.length;
      const remaining = MAX_DIFF_STDERR_BYTES - stderrBytes;
      if (remaining > 0) {
        const retained = bytes.subarray(0, remaining);
        stderrChunks.push(Buffer.from(retained));
        stderrBytes += retained.length;
      }
    };

    const detachDataAndCloseListeners = () => {
      child.stdout.off("data", onStdoutData);
      child.stderr.off("data", onStderrData);
      child.off("close", onClose);
    };

    const terminateChild = () => {
      try {
        child.stdout.destroy();
      } catch {}
      try {
        child.stderr.destroy();
      } catch {}
      try {
        child.kill("SIGKILL");
      } catch {}
    };

    const rejectOnce = (error: Error, terminate: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      detachDataAndCloseListeners();
      if (terminate) {
        terminateChild();
      }
      reject(error);
    };

    const resolveOnce = (result: WorktreeDiff) => {
      if (settled) {
        return;
      }
      settled = true;
      detachDataAndCloseListeners();
      resolve(result);
    };

    const onClose = (
      code: number | null,
      signal: NodeJS.Signals | null
    ) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks, stderrBytes)
          .toString("utf8")
          .trim();
        const status =
          code === null
            ? `terminated by ${signal ?? "an unknown signal"}`
            : `exited with code ${code}`;
        const truncated =
          stderrTotalBytes > stderrBytes ? "\n[stderr truncated]" : "";
        rejectOnce(
          new Error(
            `git diff ${status}${stderr.length > 0 ? `: ${stderr}${truncated}` : ""}`
          ),
          false
        );
        return;
      }

      const retained = Buffer.concat(stdoutChunks, retainedBytes);
      resolveOnce({
        text: utf8Prefix(retained, retained.length),
        truncated: totalBytes > maxBytes,
        totalBytes,
      });
    };

    child.stdout.on("data", onStdoutData);
    child.stderr.on("data", onStderrData);
    child.stdout.on("error", (error) =>
      rejectOnce(
        new Error(`Could not read git diff stdout: ${error.message}`),
        true
      )
    );
    child.stderr.on("error", (error) =>
      rejectOnce(
        new Error(`Could not read git diff stderr: ${error.message}`),
        true
      )
    );
    child.on("error", (error) =>
      rejectOnce(new Error(`Could not run git diff: ${error.message}`), true)
    );
    child.on("close", onClose);
  });
}

export async function worktreeDiff(
  worktreePath: string,
  options: { maxBytes: number; onChunk?: (chunk: Buffer) => void }
): Promise<WorktreeDiff> {
  if (!Number.isInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive integer.");
  }

  return withUntrackedIntentToAdd(worktreePath, () =>
    streamWorktreeDiff(worktreePath, options.maxBytes, options.onChunk)
  );
}

/**
 * The commit a task worktree's diff is measured AGAINST — its detached
 * checkout base. A cross-task diff reader (the review lane) needs this to
 * judge whether its own graph/index was built at the same commit the diff
 * applies to.
 */
export async function worktreeBaseCommit(
  worktreePath: string
): Promise<string> {
  return (await git(worktreePath, "rev-parse", "HEAD")).trim();
}

/**
 * Diff of the worktree against its checkout base (HEAD), staged and
 * unstaged combined, the "what did this run touch" summary. Newly created
 * files are included via a temporary intent-to-add that is rolled back, so
 * the worktree state is left exactly as the lane produced it.
 */
export async function worktreeDiffStat(worktreePath: string): Promise<string> {
  return withUntrackedIntentToAdd(worktreePath, async () => {
    const output = await git(worktreePath, "diff", "--stat", "HEAD");
    return output.trim();
  });
}

/** Per-file added/removed line counts for a worktree vs HEAD. */
export type WorktreeFileStat = {
  path: string;
  additions: number;
  deletions: number;
  /** A binary file reports `-`/`-` from git; counts are 0 and this is true. */
  binary: boolean;
};

/**
 * A rename in `git diff --numstat` renders its path as `old => new` or
 * `dir/{old => new}/file`. Collapse both to the NEW path so the per-file
 * stat joins to the same path `worktreeChangedFiles` reports.
 */
function normalizeNumstatPath(raw: string): string {
  const s = raw.trim();
  // git ALWAYS renders a rename with a space-padded ` => ` (`old => new` or
  // `dir/{old => new}/file`). A literal filename that merely contains "=>"
  // (no surrounding spaces) is NOT a rename and must pass through unchanged,
  // so its +/- badge still joins to the `git diff --name-only` file list.
  if (s.includes("{") && s.includes(" => ")) {
    return s.replace(/\{[^}]* => ([^}]*)\}/g, "$1").replace(/\/{2,}/g, "/");
  }
  if (s.includes(" => ")) {
    return s.split(" => ").pop()!.trim();
  }
  return s;
}

/**
 * Machine-readable per-file +/- counts for the worktree vs HEAD (staged +
 * unstaged), so the UI can render addition/deletion badges. Same
 * intent-to-add-then-rollback discipline as {@link worktreeDiffStat}, so
 * untracked files count without mutating the worktree.
 */
export async function worktreeNumstat(
  worktreePath: string
): Promise<WorktreeFileStat[]> {
  return withUntrackedIntentToAdd(worktreePath, async () => {
    const output = await git(worktreePath, "diff", "--numstat", "HEAD");
    const stats: WorktreeFileStat[] = [];
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      // `<additions>\t<deletions>\t<path>` — path may itself contain tabs only
      // when quoted, which numstat never does for the tab separators.
      const firstTab = line.indexOf("\t");
      const secondTab = line.indexOf("\t", firstTab + 1);
      if (firstTab < 0 || secondTab < 0) continue;
      const addRaw = line.slice(0, firstTab);
      const delRaw = line.slice(firstTab + 1, secondTab);
      const path = normalizeNumstatPath(line.slice(secondTab + 1));
      const binary = addRaw === "-" || delRaw === "-";
      stats.push({
        path,
        additions: binary ? 0 : Number.parseInt(addRaw, 10) || 0,
        deletions: binary ? 0 : Number.parseInt(delRaw, 10) || 0,
        binary,
      });
    }
    return stats;
  });
}

// ── The governed MERGE EXECUTOR — close the loop (ROADMAP 4.3) ────────────────
//
// A task worktree is a DETACHED checkout the lane edited. "Merging the winner"
// means landing those changes on the primary checkout's current branch. This
// runs ONLY when a human has approved the merge gate (backend), and is
// FAIL-SAFE: it commits the worktree's changes to its detached HEAD, merges that
// commit into the primary checkout, and on ANY conflict/error aborts so the base
// branch is left EXACTLY as it was. Nothing here is auto-triggered.

export type WorktreeMergeResult =
  | {
      status: "merged";
      sha: string;
      message: string;
      changedFiles: number;
      recovered?: boolean;
      mergeCommit?: string;
    }
  | { status: "no-op"; reason: string }
  | { status: "conflict"; reason: string }
  | { status: "blocked"; reason: string }
  | { status: "failed"; reason: string };

export type MergeGitRunner = (cwd: string, ...args: string[]) => Promise<string>;

export type MergeBaseTarget = {
  /** Full checked-out branch ref, for example `refs/heads/main`. */
  ref: string;
  /** Exact primary commit included in the reviewed artifact digest. */
  head: string;
};

type CommitCoordinate = {
  commit: string;
  parents: string[];
};

function parseCommitCoordinates(output: string): CommitCoordinate[] {
  return output
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [commit = "", ...parents] = line.split(/\s+/);
      return { commit, parents };
    });
}

async function readRefHead(input: {
  repoRoot: string;
  ref: string;
  gitRun: MergeGitRunner;
}): Promise<string> {
  return (
    await input.gitRun(
      input.repoRoot,
      "rev-parse",
      "--verify",
      input.ref
    )
  ).trim();
}

/**
 * Recovery cannot treat mere ancestry as proof of MUON's completed mutation.
 * Find the unique commit on the reviewed ref's ancestry path whose two ordered
 * parents are exactly the reviewed base and durable verified worker commit.
 */
async function findReviewedMergeCommit(input: {
  repoRoot: string;
  expectedBase: MergeBaseTarget;
  expectedWorktreeHead: string;
  targetHead: string;
  gitRun: MergeGitRunner;
}): Promise<string | undefined> {
  const candidates = parseCommitCoordinates(
    await input.gitRun(
      input.repoRoot,
      "rev-list",
      "--parents",
      "--merges",
      "--ancestry-path",
      `${input.expectedBase.head}..${input.targetHead}`
    )
  ).filter(
    ({ parents }) =>
      parents.length === 2 &&
      parents[0] === input.expectedBase.head &&
      parents[1] === input.expectedWorktreeHead
  );
  return candidates.length === 1 ? candidates[0]?.commit : undefined;
}

export type DurableMergeVerification =
  | { ok: true; mergeCommit: string; currentRefHead: string }
  | { ok: false; reason: string };

export type DurableWorktreeArtifactVerification =
  | { ok: true; currentWorktreeHead: string }
  | { ok: false; reason: string };

/**
 * Read-only proof that the governed worktree still names the exact immutable
 * commit captured by a durable execution and has no later filesystem changes.
 * Reading HEAD on both sides of status closes the local read-time drift window.
 */
export async function verifyDurableWorktreeArtifact(input: {
  worktreePath: string;
  verifiedWorktreeHead: string;
  gitRun?: MergeGitRunner;
}): Promise<DurableWorktreeArtifactVerification> {
  const g = input.gitRun ?? git;
  try {
    const headBefore = (
      await g(input.worktreePath, "rev-parse", "HEAD")
    ).trim();
    const status = await g(input.worktreePath, "status", "--porcelain");
    const headAfter = (
      await g(input.worktreePath, "rev-parse", "HEAD")
    ).trim();
    if (
      headBefore !== input.verifiedWorktreeHead ||
      headAfter !== input.verifiedWorktreeHead
    ) {
      return {
        ok: false,
        reason:
          "The governed worktree HEAD no longer matches the durable verified artifact.",
      };
    }
    if (status.trim().length > 0) {
      return {
        ok: false,
        reason:
          "The governed worktree has uncommitted changes after the durable execution outcome.",
      };
    }
    return {
      ok: true,
      currentWorktreeHead: headAfter,
    };
  } catch (error) {
    return {
      ok: false,
      reason: `The durable worktree artifact could not be verified: ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 200),
    };
  }
}

/**
 * Read-only proof for consumers of a durable merge outcome. The stored merge
 * commit must have the exact reviewed ordered parents, remain reachable from
 * the reviewed ref, and the governed worktree must still be clean at the exact
 * verified worker commit.
 */
export async function verifyDurableWorktreeMerge(input: {
  repoRoot: string;
  worktreePath: string;
  expectedBase: MergeBaseTarget;
  verifiedWorktreeHead: string;
  mergeCommit: string;
  gitRun?: MergeGitRunner;
}): Promise<DurableMergeVerification> {
  const g = input.gitRun ?? git;
  try {
    const worktreeHeadBefore = (
      await g(input.worktreePath, "rev-parse", "HEAD")
    ).trim();
    const worktreeStatus = await g(
      input.worktreePath,
      "status",
      "--porcelain"
    );
    const worktreeHeadAfter = (
      await g(input.worktreePath, "rev-parse", "HEAD")
    ).trim();
    if (
      worktreeHeadBefore !== input.verifiedWorktreeHead ||
      worktreeHeadAfter !== input.verifiedWorktreeHead
    ) {
      return {
        ok: false,
        reason:
          "The governed worktree HEAD no longer matches the durable verified artifact.",
      };
    }
    if (worktreeStatus.trim().length > 0) {
      return {
        ok: false,
        reason:
          "The governed worktree has uncommitted changes after the durable merge outcome.",
      };
    }
    const mergeRows = await g(
      input.repoRoot,
      "rev-list",
      "--parents",
      "-n",
      "1",
      input.mergeCommit
    );
    const [merge] = parseCommitCoordinates(mergeRows);
    if (
      merge?.commit !== input.mergeCommit ||
      merge.parents.length !== 2 ||
      merge.parents[0] !== input.expectedBase.head ||
      merge.parents[1] !== input.verifiedWorktreeHead
    ) {
      return {
        ok: false,
        reason:
          "The durable merge commit is not bound to the reviewed base and verified worktree parents.",
      };
    }
    const currentRefHead = await readRefHead({
      repoRoot: input.repoRoot,
      ref: input.expectedBase.ref,
      gitRun: g,
    });
    try {
      await g(
        input.repoRoot,
        "merge-base",
        "--is-ancestor",
        input.mergeCommit,
        currentRefHead
      );
    } catch {
      return {
        ok: false,
        reason:
          "The durable merge commit is no longer reachable from the reviewed primary ref.",
      };
    }
    return {
      ok: true,
      mergeCommit: input.mergeCommit,
      currentRefHead,
    };
  } catch (error) {
    return {
      ok: false,
      reason: `The durable merge outcome could not be verified: ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 200),
    };
  }
}

/**
 * Capture the primary checkout coordinate that a review/merge must bind.
 * Detached checkouts fail closed: MUON must never guess which ref to mutate.
 */
export async function captureMergeBaseTarget(input: {
  repoRoot: string;
  gitRun?: MergeGitRunner;
}): Promise<MergeBaseTarget> {
  const g = input.gitRun ?? git;
  const refBefore = (
    await g(input.repoRoot, "symbolic-ref", "--quiet", "HEAD")
  ).trim();
  const head = (await g(input.repoRoot, "rev-parse", "HEAD")).trim();
  const refAfter = (
    await g(input.repoRoot, "symbolic-ref", "--quiet", "HEAD")
  ).trim();
  if (refBefore !== refAfter) {
    throw new Error(
      "The primary checkout changed branches while its merge target was being captured."
    );
  }
  const normalizedRef = refBefore;
  const normalizedHead = head.trim();
  if (!normalizedRef.startsWith("refs/heads/")) {
    throw new Error(
      "The primary checkout is detached or not on a local branch; refusing to choose a merge target."
    );
  }
  if (!/^[0-9a-f]{7,64}$/i.test(normalizedHead)) {
    throw new Error("The primary checkout HEAD could not be captured.");
  }
  return { ref: normalizedRef, head: normalizedHead };
}

/**
 * Land a task worktree's changes onto the primary checkout, fail-safe. The base
 * branch is only ever modified by a single `git merge` that either succeeds or is
 * aborted — never a half-applied state. `gitRun` is injectable for hermetic tests.
 */
export async function mergeTaskWorktree(input: {
  repoRoot: string;
  worktreePath: string;
  message: string;
  /** Server-captured reviewed primary ref and commit. */
  expectedBase: MergeBaseTarget;
  /**
   * Durable worktree commit captured by an earlier crashed attempt. When
   * supplied, a retry may recognize that exact commit as already landed.
   */
  expectedWorktreeHead?: string;
  gitRun?: MergeGitRunner;
  /**
   * Persist the immutable worktree commit before the primary checkout can
   * mutate. Throwing from this hook fails the merge closed.
   */
  onArtifactCaptured?: (input: {
    worktreeHead: string;
  }) => Promise<void>;
  /**
   * Final authority check for the exact commit captured from the worktree.
   * Runs after MUON stages/commits and records the immutable HEAD, but before
   * the primary checkout is mutated. A failed check leaves the base untouched.
   */
  verifyCapturedArtifact?: (input: {
    worktreeHead: string;
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Persist that final artifact verification succeeded for this immutable
   * commit. Recovery may recognize an already-landed commit only after this
   * hook completed durably.
   */
  onArtifactVerified?: (input: {
    worktreeHead: string;
  }) => Promise<void>;
  /**
   * Last authority/lease checkpoint, invoked after ref+HEAD verification and
   * immediately before Git may mutate the reviewed primary branch.
   */
  beforeBaseMutation?: (input: {
    expectedBase: MergeBaseTarget;
    worktreeHead: string;
  }) => Promise<void>;
}): Promise<WorktreeMergeResult> {
  const g = input.gitRun ?? git;
  try {
    const initialBase = await captureMergeBaseTarget({
      repoRoot: input.repoRoot,
      gitRun: g,
    });
    if (initialBase.ref !== input.expectedBase.ref) {
      return {
        status: "blocked",
        reason:
          "The primary checkout changed branches after review. Refresh review on the intended branch and approve again.",
      };
    }
    if (initialBase.head !== input.expectedBase.head) {
      if (input.expectedWorktreeHead) {
        const currentWorktreeHead = (
          await g(input.worktreePath, "rev-parse", "HEAD")
        ).trim();
        if (currentWorktreeHead !== input.expectedWorktreeHead) {
          return {
            status: "blocked",
            reason:
              "The durable merge attempt no longer matches the task worktree HEAD.",
          };
        }
        const reviewedRefHeadBefore = await readRefHead({
          repoRoot: input.repoRoot,
          ref: input.expectedBase.ref,
          gitRun: g,
        });
        const mergeCommit = await findReviewedMergeCommit({
          repoRoot: input.repoRoot,
          expectedBase: input.expectedBase,
          expectedWorktreeHead: input.expectedWorktreeHead,
          targetHead: reviewedRefHeadBefore,
          gitRun: g,
        });
        const verification = mergeCommit
          ? await verifyDurableWorktreeMerge({
              repoRoot: input.repoRoot,
              worktreePath: input.worktreePath,
              expectedBase: input.expectedBase,
              verifiedWorktreeHead: input.expectedWorktreeHead,
              mergeCommit,
              gitRun: g,
            })
          : undefined;
        if (
          verification?.ok &&
          reviewedRefHeadBefore === verification.currentRefHead &&
          verification.currentRefHead === initialBase.head
        ) {
          return {
            status: "merged",
            sha: input.expectedWorktreeHead,
            message: input.message,
            changedFiles: 0,
            recovered: true,
            mergeCommit,
          };
        }
      }
      return {
        status: "blocked",
        reason:
          "The primary branch advanced after review. Refresh review against the current branch before merging.",
      };
    }

    // The primary checkout must be clean — never merge onto a dirty tree the
    // human is mid-edit on (that would entangle their work with the agent's).
    // MUON's OWN worktree storage (`.muon/`) shows as untracked in the primary
    // repo; it is not a human edit, so it never counts as dirty.
    const baseDirty = (await g(input.repoRoot, "status", "--porcelain"))
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .filter((line) => {
        // Only MUON's untracked storage is internal. A tracked/staged `.muon`
        // path is ordinary repository content and must keep the base fenced.
        if (!line.startsWith("?? ")) return true;
        const path = line.slice(3); // strip the "XY " porcelain status prefix
        return path !== ".muon" && path !== ".muon/" && !path.startsWith(".muon/");
      });
    if (baseDirty.length > 0) {
      return {
        status: "blocked",
        reason:
          "The primary checkout has uncommitted changes — commit or stash them, then re-approve the merge.",
      };
    }

    // Stage + commit whatever the lane produced in its worktree (detached HEAD).
    const working = (await g(input.worktreePath, "status", "--porcelain")).trim();
    const changedFiles = working
      ? working.split("\n").filter((line) => line.trim().length > 0).length
      : 0;
    if (working) {
      await g(input.worktreePath, "add", "-A");
      await g(
        input.worktreePath,
        "commit",
        "-m",
        input.message,
        "--no-gpg-sign",
        "--no-verify"
      );
    }

    const worktreeHead = (await g(input.worktreePath, "rev-parse", "HEAD")).trim();
    if (
      input.expectedWorktreeHead &&
      worktreeHead !== input.expectedWorktreeHead
    ) {
      return {
        status: "blocked",
        reason:
          "The durable merge attempt no longer matches the task worktree HEAD.",
      };
    }
    await input.onArtifactCaptured?.({ worktreeHead });

    if (input.verifyCapturedArtifact) {
      const verification = await input.verifyCapturedArtifact({
        worktreeHead,
      });
      if (!verification.ok) {
        return {
          status: "blocked",
          reason: verification.reason,
        };
      }
      await input.onArtifactVerified?.({ worktreeHead });
    }

    // Nothing to land if the verified worktree HEAD is already reachable from
    // the reviewed base. Verification intentionally precedes this no-op: a
    // reset/replacement must not turn a reviewed change into an unverified
    // successful no-op.
    let alreadyMerged = false;
    try {
      await g(
        input.repoRoot,
        "merge-base",
        "--is-ancestor",
        worktreeHead,
        "HEAD"
      );
      alreadyMerged = true;
    } catch {
      alreadyMerged = false; // non-zero exit = NOT an ancestor = there is work
    }
    if (alreadyMerged) {
      return {
        status: "no-op",
        reason: "The worktree has no changes beyond the base branch.",
      };
    }

    // Re-check the exact reviewed ref+commit after the potentially expensive
    // artifact verification and immediately before Git's ref-locked merge.
    const finalBase = await captureMergeBaseTarget({
      repoRoot: input.repoRoot,
      gitRun: g,
    });
    if (
      finalBase.ref !== input.expectedBase.ref ||
      finalBase.head !== input.expectedBase.head
    ) {
      return {
        status: "blocked",
        reason:
          "The primary branch changed during final merge verification. No reviewed artifact was merged.",
      };
    }
    await input.beforeBaseMutation?.({
      expectedBase: input.expectedBase,
      worktreeHead,
    });
    // Explicit compare-and-swap against the reviewed old OID. This acquires
    // Git's ref lock and refuses a stale/switching primary ref before merge;
    // `git merge` then performs its own locked ref transaction.
    await g(
      input.repoRoot,
      "update-ref",
      input.expectedBase.ref,
      input.expectedBase.head,
      input.expectedBase.head
    );

    // `git merge` updates a branch through Git's ref transaction/lock. The
    // exact expected ref+old HEAD were checked immediately above; the
    // postconditions below prove the transaction landed the reviewed parents.
    try {
      await g(
        input.repoRoot,
        "merge",
        "--no-ff",
        "--no-gpg-sign",
        "--no-verify",
        "-m",
        input.message,
        worktreeHead
      );
    } catch {
      try {
        await g(input.repoRoot, "merge", "--abort");
      } catch (abortError) {
        return {
          status: "failed",
          reason: `Merge failed and Git could not abort it; the repository may remain in a merge state: ${
            abortError instanceof Error ? abortError.message : String(abortError)
          }`.slice(0, 200),
        };
      }
      return {
        status: "conflict",
        reason:
          "Merge conflicts — the base branch was left exactly as it was. Resolve the worktree against the base and re-approve.",
      };
    }

    // Postconditions and rollback are bound to the exact reviewed ref. Never
    // infer the merge target from ambient HEAD: another process may switch the
    // primary checkout after Git releases its merge locks.
    const expectedRefHead = await readRefHead({
      repoRoot: input.repoRoot,
      ref: input.expectedBase.ref,
      gitRun: g,
    });
    if (expectedRefHead === input.expectedBase.head) {
      return {
        status: "failed",
        reason:
          "Git returned merge success but the exact reviewed primary ref did not advance; another checkout may have been mutated and requires inspection.",
      };
    }
    const [landed] = parseCommitCoordinates(
      await g(
        input.repoRoot,
        "rev-list",
        "--parents",
        "-n",
        "1",
        expectedRefHead
      )
    );
    const parents = landed?.parents ?? [];
    const directReviewedMerge =
      landed?.commit === expectedRefHead &&
      parents.length === 2 &&
      parents[0] === input.expectedBase.head &&
      parents[1] === worktreeHead
        ? expectedRefHead
        : undefined;
    const exactMergeCommit =
      directReviewedMerge ??
      (await findReviewedMergeCommit({
        repoRoot: input.repoRoot,
        expectedBase: input.expectedBase,
        expectedWorktreeHead: worktreeHead,
        targetHead: expectedRefHead,
        gitRun: g,
      }));
    if (!exactMergeCommit) {
      // A ref advance/switch in the tiny interval after our preflight CAS can
      // make `git merge` land the verified worker on a different first parent.
      // Roll back ONLY a merge found on the exact reviewed ref, preserving its
      // actual first parent. Never mutate whichever ref ambient HEAD names.
      const isOurUnexpectedMerge =
        landed?.commit === expectedRefHead &&
        parents.length === 2 &&
        parents[1] === worktreeHead;
      if (!isOurUnexpectedMerge) {
        return {
          status: "failed",
          reason:
            "Git returned merge success with an unexpected ref or parent set; automatic rollback is unsafe.",
        };
      }
      try {
        await g(
          input.repoRoot,
          "update-ref",
          input.expectedBase.ref,
          parents[0]!,
          expectedRefHead
        );
      } catch (error) {
        return {
          status: "failed",
          reason: `An unintended merge commit landed after concurrent ref drift and its rollback CAS failed; repository recovery is required: ${
            error instanceof Error ? error.message : String(error)
          }`.slice(0, 200),
        };
      }
      return {
        status: "blocked",
        reason:
          "The primary ref changed immediately before merge. MUON rolled back only the exact unintended merge ref and preserved the concurrent commit; refresh the primary checkout before retrying.",
      };
    }
    try {
      await g(
        input.repoRoot,
        "merge-base",
        "--is-ancestor",
        worktreeHead,
        exactMergeCommit
      );
    } catch {
      return {
        status: "failed",
        reason:
          "Git returned merge success but the reviewed worktree commit is not an ancestor of the primary ref.",
      };
    }
    const currentExpectedRefHead = await readRefHead({
      repoRoot: input.repoRoot,
      ref: input.expectedBase.ref,
      gitRun: g,
    });
    try {
      await g(
        input.repoRoot,
        "merge-base",
        "--is-ancestor",
        exactMergeCommit,
        currentExpectedRefHead
      );
    } catch {
      return {
        status: "failed",
        reason:
          "The exact landed merge commit no longer belongs to the reviewed primary ref.",
      };
    }
    return {
      status: "merged",
      sha: worktreeHead,
      mergeCommit: exactMergeCommit,
      message: input.message,
      changedFiles,
    };
  } catch (error) {
    return {
      status: "failed",
      reason: (error instanceof Error ? error.message : String(error)).slice(
        0,
        200
      ),
    };
  }
}
