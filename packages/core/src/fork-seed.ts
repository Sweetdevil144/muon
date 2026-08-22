import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveDataDir } from "@muon/client/paths";
import {
  discardCreatedWorktree,
  isOwnedLinkedWorktree,
  locateTaskWorktreePath,
  sanitizeTaskId,
} from "./worktree.js";
import {
  prepareWorktreeDependencies,
  type WorktreePreparation,
} from "./worktree-prep.js";

// ── ADR-0044/0071 D5 — the fork-seed protocol, in one focused module ─────────
//
// A fork materialises from a RECORDED state: base commit + tracked diff +
// untracked files, snapshotted from the source task's worktree AT THE FORK
// GESTURE (capture) and replayed into the fork task's freshly created
// worktree (apply). The stash between the two halves is derived, disposable
// materialisation input — never a second ledger. Extracted from worktree.ts
// (review finding: the snapshot protocol deserves its own typed seam beside,
// not inside, the already-broad worktree utility).

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 45_000;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/** An untracked symlink travels VERBATIM — the link, never its dereferenced
 *  target (review finding: `copyFile` follows links, so a worker-planted
 *  symlink would smuggle arbitrary readable host content across the
 *  worktree boundary at the operator's fork gesture). */
type ForkSeedSymlink = { path: string; target: string };

type ForkSeedMeta = {
  version: number;
  baseCommit: string;
  hasDiff: boolean;
  untrackedCount: number;
  symlinks: ForkSeedSymlink[];
  sourceTaskId: string;
  /** The recorded step this capture claims — audit metadata only. */
  sourceJobId?: string;
};

export type ForkSeedCapture = {
  /** The SOURCE worktree's base commit at CAPTURE time — the fork detaches
   *  here, not at today's HEAD, so a mainline that moved cannot shift the
   *  recorded state under the diff. */
  baseCommit: string;
  hasDiff: boolean;
  untrackedCount: number;
  symlinkCount: number;
  seedDir: string;
};

/** The ONE spelling of the stash root — the GC sweep enumerates it, so it
 *  must be derived here beside `forkSeedDir`, never re-spelled elsewhere. */
export function forkSeedsRoot(): string {
  return join(resolve(resolveDataDir()), "fork-seeds");
}

/** The durable stash for one fork's recorded state, keyed by the FORK task. */
export function forkSeedDir(forkTaskId: string): string {
  return join(forkSeedsRoot(), sanitizeTaskId(forkTaskId));
}

/**
 * Capture half — snapshot a source task's worktree state INTO the fork's
 * seed stash AT THE FORK GESTURE. Review finding: seeding from the live
 * source tree at claim time read MUTABLE state — any later dispatch on the
 * source task would silently change what an older step forked to.
 * FAIL-CLOSED: any error throws and the fork is refused before its mission
 * is minted — including an untracked entry that is neither a regular file
 * nor a symlink (silently dropping it would understate the recorded state).
 * The source tree is read, never written.
 */
export async function captureForkSeed(input: {
  repoRoot: string;
  sourceTaskId: string;
  forkTaskId: string;
  /** The recorded step whose state this capture claims — audit metadata. */
  sourceJobId?: string;
}): Promise<ForkSeedCapture> {
  const sourcePath = locateTaskWorktreePath(input.repoRoot, input.sourceTaskId);
  if (
    !existsSync(sourcePath) ||
    !isOwnedLinkedWorktree(input.repoRoot, sourcePath)
  ) {
    throw new Error(
      `the fork's recorded state is gone: no owned worktree for task '${input.sourceTaskId}' at '${sourcePath}'`
    );
  }
  const seedDir = forkSeedDir(input.forkTaskId);
  await rm(seedDir, { recursive: true, force: true });
  await mkdir(seedDir, { recursive: true });
  try {
    const baseCommit = (await git(sourcePath, "rev-parse", "HEAD")).trim();
    const diff = await git(sourcePath, "diff", "--binary", "HEAD");
    const hasDiff = diff.trim().length > 0;
    if (hasDiff) {
      await writeFile(join(seedDir, "tracked.patch"), diff, "utf8");
    }
    const untrackedRaw = await git(
      sourcePath,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z"
    );
    const untracked = untrackedRaw
      .split("\0")
      .filter((line) => line.length > 0);
    const symlinks: ForkSeedSymlink[] = [];
    let fileCount = 0;
    for (const file of untracked) {
      const from = join(sourcePath, file);
      const entry = await lstat(from);
      if (entry.isSymbolicLink()) {
        symlinks.push({ path: file, target: await readlink(from) });
      } else if (entry.isFile()) {
        const to = join(seedDir, "untracked", file);
        await mkdir(dirname(to), { recursive: true });
        await copyFile(from, to);
        fileCount += 1;
      } else {
        throw new Error(
          `the recorded state holds an unsupported untracked entry: '${file}' is neither a regular file nor a symlink`
        );
      }
    }
    const meta: ForkSeedMeta = {
      version: 1,
      baseCommit,
      hasDiff,
      untrackedCount: fileCount,
      symlinks,
      sourceTaskId: input.sourceTaskId,
      ...(input.sourceJobId ? { sourceJobId: input.sourceJobId } : {}),
    };
    await writeFile(
      join(seedDir, "meta.json"),
      JSON.stringify(meta, null, 2),
      "utf8"
    );
    return {
      baseCommit,
      hasDiff,
      untrackedCount: fileCount,
      symlinkCount: symlinks.length,
      seedDir,
    };
  } catch (error) {
    // A refused capture must not strand a partially populated stash under
    // the data dir (review finding: it holds copied worktree content with
    // no task row or identifier through which to reclaim it).
    await rm(seedDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export type ForkSeedCopy = {
  fromDir: string;
  toDir: string;
  /** The ORIGINAL source task the copied stash records — the value the new
   *  task's provenance stamp must carry so `applyForkSeed`'s stash/column
   *  agreement check keeps holding on the inherited copy. */
  sourceTaskId: string;
};

/**
 * ADR-0084 D1 — stash inheritance at task creation under a fork mission.
 *
 * Copy a fork task's captured seed stash under a NEW task's key, so the
 * runner's existing gate (`hasForkSeed` → `materializeForkWorktree`) seeds
 * the new task's tree from the SAME recorded state with zero new runner
 * logic. The copy is verbatim EXCEPT `applied.json`: that marker records
 * that the SOURCE task's tree was materialised, and carrying it would make
 * a never-materialised tree read as healthy across the crash-window check.
 *
 * FAIL-CLOSED both ways: a missing source stash throws (a crew task minted
 * without the recorded state would stand on today's HEAD — the exact lie
 * the fork exists to prevent), and a failed copy removes the partial
 * destination before rethrowing, exactly as capture does.
 */
export async function copyForkSeed(input: {
  fromTaskId: string;
  toTaskId: string;
}): Promise<ForkSeedCopy> {
  const fromDir = forkSeedDir(input.fromTaskId);
  const metaPath = join(fromDir, "meta.json");
  if (!existsSync(metaPath)) {
    throw new Error(
      `the fork mission's recorded state is gone: no seed stash for task '${input.fromTaskId}' at '${fromDir}'`
    );
  }
  // Structural completeness at the MINT, not the claim: a stash declaring
  // a diff it does not hold would copy clean, mint a task, and fail only
  // when a runner materialises it. Same reader, same rules as apply.
  const meta = readForkSeedMeta(fromDir);
  const toDir = forkSeedDir(input.toTaskId);
  await rm(toDir, { recursive: true, force: true });
  await mkdir(toDir, { recursive: true });
  try {
    const copyTree = async (from: string, to: string): Promise<void> => {
      for (const entry of await readdir(from, { withFileTypes: true })) {
        const fromPath = join(from, entry.name);
        const toPath = join(to, entry.name);
        if (entry.isDirectory()) {
          await mkdir(toPath, { recursive: true });
          await copyTree(fromPath, toPath);
        } else if (entry.isFile() && !entry.isSymbolicLink()) {
          await copyFile(fromPath, toPath);
        } else {
          // The stash holds only regular files by construction (untracked
          // symlinks travel as meta entries, never as links on disk); an
          // unexpected entry means the stash is not what capture wrote —
          // refuse rather than understate the recorded state.
          throw new Error(
            `the fork's seed stash holds an unsupported entry: '${fromPath}'`
          );
        }
      }
    };
    for (const entry of await readdir(fromDir, { withFileTypes: true })) {
      if (entry.name === "applied.json") continue;
      const fromPath = join(fromDir, entry.name);
      const toPath = join(toDir, entry.name);
      if (entry.isDirectory()) {
        await mkdir(toPath, { recursive: true });
        await copyTree(fromPath, toPath);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        await copyFile(fromPath, toPath);
      } else {
        throw new Error(
          `the fork's seed stash holds an unsupported entry: '${fromPath}'`
        );
      }
    }
    return { fromDir, toDir, sourceTaskId: meta.sourceTaskId };
  } catch (error) {
    await rm(toDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Discard a fork's seed stash (compensation when minting the fork fails). */
export async function discardForkSeed(forkTaskId: string): Promise<void> {
  await rm(forkSeedDir(forkTaskId), { recursive: true, force: true });
}

/**
 * THE one stash-meta reader (review finding: copy and apply each parsed and
 * validated `meta.json` with different rules, so a contract change could
 * make copying accept a stash materialisation rejects). Validates the full
 * structural contract capture writes: version, a non-empty base commit, the
 * source task, and hasDiff ↔ tracked.patch consistency. Throws — every
 * consumer is fail-closed.
 */
function readForkSeedMeta(seedDir: string): ForkSeedMeta {
  const metaPath = join(seedDir, "meta.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as ForkSeedMeta;
  if (
    meta.version !== 1 ||
    typeof meta.baseCommit !== "string" ||
    meta.baseCommit.length === 0 ||
    typeof meta.sourceTaskId !== "string" ||
    meta.sourceTaskId.length === 0
  ) {
    throw new Error(`the fork's seed stash at '${seedDir}' is unreadable`);
  }
  if (meta.hasDiff && !existsSync(join(seedDir, "tracked.patch"))) {
    throw new Error(
      `the fork's seed stash at '${seedDir}' declares a tracked diff but holds no patch`
    );
  }
  return meta;
}

/** Whether a captured seed stash exists for this task — the runner's ONLY
 *  signal that a freshly created worktree must be materialised from a
 *  recorded state (keyed on the stash, not on which job created the tree —
 *  review finding: a harness-less fork root never creates a worktree, so
 *  whichever job DOES create it must seed it). */
export function hasForkSeed(forkTaskId: string): boolean {
  return existsSync(join(forkSeedDir(forkTaskId), "meta.json"));
}

/** Whether the stash was ever successfully applied to a created worktree.
 *  Written by {@link applyForkSeed} as its LAST act, so a crash anywhere
 *  between `git worktree add` and the end of the apply leaves NO marker —
 *  and the next claim can tell a half-materialised tree from a healthy one
 *  instead of running an unseeded default-HEAD tree (review finding). */
export function forkSeedApplied(forkTaskId: string): boolean {
  return existsSync(join(forkSeedDir(forkTaskId), "applied.json"));
}

export type ForkSeedResult = {
  baseCommit: string;
  appliedDiff: boolean;
  untrackedCopied: number;
  symlinksRestored: number;
};

/**
 * Apply half — materialise a freshly created worktree from the CAPTURED
 * seed stash. FAIL-CLOSED: a fork that silently starts from today's HEAD
 * instead of the recorded state is the lie the seed exists to prevent — on
 * ANY failure the caller must discard the created tree (so a reclaim
 * re-creates and re-applies rather than seeing `created: false` and
 * skipping — review finding) and refuse the job. When the claiming job
 * carries the fork's persisted provenance (`expectedSourceTaskId`), the
 * stash must agree with it (review finding: the stash and the provenance
 * columns must not be able to drift silently).
 */
export async function applyForkSeed(input: {
  forkTaskId: string;
  targetPath: string;
  expectedSourceTaskId?: string;
}): Promise<ForkSeedResult> {
  const seedDir = forkSeedDir(input.forkTaskId);
  const metaPath = join(seedDir, "meta.json");
  if (!existsSync(metaPath)) {
    throw new Error(
      `the fork's captured seed is gone: no stash at '${seedDir}'`
    );
  }
  const meta = readForkSeedMeta(seedDir);
  if (
    input.expectedSourceTaskId &&
    meta.sourceTaskId !== input.expectedSourceTaskId
  ) {
    throw new Error(
      `the fork's seed stash records source task '${meta.sourceTaskId}' but the claimed job's provenance names '${input.expectedSourceTaskId}' — refusing a mismatched materialization`
    );
  }
  // Clear any PRIOR marker before mutating the tree: a crash mid-way
  // through a RE-apply (the tree was discarded and re-created) must not
  // leave a stale "applied" verdict over a half-materialised tree.
  await rm(join(seedDir, "applied.json"), { force: true });
  await git(input.targetPath, "checkout", "--detach", meta.baseCommit);
  let appliedDiff = false;
  if (meta.hasDiff) {
    await git(
      input.targetPath,
      "apply",
      "--whitespace=nowarn",
      join(seedDir, "tracked.patch")
    );
    appliedDiff = true;
  }
  let untrackedCopied = 0;
  const untrackedRoot = join(seedDir, "untracked");
  if (existsSync(untrackedRoot)) {
    const stack: string[] = [""];
    while (stack.length > 0) {
      const relDir = stack.pop()!;
      const entries = await readdir(join(untrackedRoot, relDir), {
        withFileTypes: true,
      });
      for (const entry of entries) {
        const rel = relDir ? join(relDir, entry.name) : entry.name;
        if (entry.isDirectory()) {
          stack.push(rel);
        } else if (entry.isFile()) {
          const to = join(input.targetPath, rel);
          await mkdir(dirname(to), { recursive: true });
          await copyFile(join(untrackedRoot, rel), to);
          untrackedCopied += 1;
        }
      }
    }
  }
  let symlinksRestored = 0;
  for (const link of meta.symlinks ?? []) {
    const to = join(input.targetPath, link.path);
    await mkdir(dirname(to), { recursive: true });
    await symlink(link.target, to);
    symlinksRestored += 1;
  }
  // The durable "materialisation completed" marker, written LAST: its
  // absence over an existing tree is proof of a half-materialised crash.
  await writeFile(
    join(seedDir, "applied.json"),
    JSON.stringify(
      {
        baseCommit: meta.baseCommit,
        targetPath: input.targetPath,
        appliedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf8"
  );
  return {
    baseCommit: meta.baseCommit,
    appliedDiff,
    untrackedCopied,
    symlinksRestored,
  };
}

export type ForkMaterialization =
  | {
      ok: true;
      seeded: ForkSeedResult | undefined;
      /** Set when THIS call ran the dependency preparation (seed paths
       *  prepare against the RECORDED state, not today's HEAD). */
      preparation?: WorktreePreparation;
    }
  | { ok: false; reason: string };

/**
 * The ONE fork-materialisation authority (review finding: the runner had
 * grown an 80-line conditional owning creation state, seed state, marker
 * state, and cleanup). Given a just-ensured task worktree, decide whether
 * and how the recorded state applies, fail-closed in every direction:
 *
 *  - stash present + tree just created  → apply the seed, then RE-PREPARE
 *    dependencies against the captured checkout (review finding: the
 *    initial preparation ran against today's HEAD before the detach — its
 *    artifacts may not match the recorded state's lockfiles); any failure
 *    discards the created tree so the next claim re-creates and re-seeds;
 *  - stash present + existing tree + no applied-marker → a crash left a
 *    half-materialised tree; discard it and refuse (never run default-HEAD
 *    under the fork's name);
 *  - stash present + existing tree + marker → healthy, nothing to do;
 *  - no stash, but the job's provenance says FORK and no seeded tree
 *    survives → refuse (the recorded state is unrecoverable);
 *  - no stash, no fork provenance → an ordinary task; nothing to do.
 */
export async function materializeForkWorktree(input: {
  repoRoot: string;
  taskId: string;
  worktreePath: string;
  worktreeCreated: boolean;
  expectedSourceTaskId?: string;
}): Promise<ForkMaterialization> {
  const seedPresent = hasForkSeed(input.taskId);
  const seedApplied = forkSeedApplied(input.taskId);
  const discard = () =>
    discardCreatedWorktree({
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
    }).catch(() => undefined);

  if (seedPresent) {
    if (!input.worktreeCreated && !seedApplied) {
      await discard();
      return {
        ok: false,
        reason:
          "fork worktree was half-materialised by an earlier crashed claim (stash present, no applied marker); the tree was discarded so the next claim re-creates and re-seeds",
      };
    }
    if (!input.worktreeCreated) {
      // Existing tree with an applied marker: healthy, already seeded —
      // but preparation is idempotent and re-asserted on every claim
      // (exactly as ensureTaskWorktree does for ordinary tasks, which the
      // seed path skips), so a reused seeded tree cannot silently rot.
      const preparation = await prepareWorktreeDependencies({
        sourceRoot: input.repoRoot,
        worktreePath: input.worktreePath,
      });
      if (preparation.problems.length > 0) {
        return {
          ok: false,
          reason: `the seeded fork worktree is no longer test-capable: ${preparation.problems.join("; ")}`,
        };
      }
      return { ok: true, seeded: undefined, preparation };
    }
    try {
      const seeded = await applyForkSeed({
        forkTaskId: input.taskId,
        targetPath: input.worktreePath,
        expectedSourceTaskId: input.expectedSourceTaskId,
      });
      const preparation = await prepareWorktreeDependencies({
        sourceRoot: input.repoRoot,
        worktreePath: input.worktreePath,
      });
      if (preparation.problems.length > 0) {
        throw new Error(
          `the seeded worktree is not test-capable at the recorded state: ${preparation.problems.join("; ")}`
        );
      }
      return { ok: true, seeded, preparation };
    } catch (error) {
      await discard();
      return {
        ok: false,
        reason: `fork worktree seed failed (fail-closed — the created tree was discarded so the next claim re-seeds): ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  if (
    input.expectedSourceTaskId &&
    (input.worktreeCreated || !seedApplied)
  ) {
    if (input.worktreeCreated) await discard();
    return {
      ok: false,
      reason:
        "the fork's captured seed is gone and its worktree holds no applied materialization; refusing to run the fork from today's HEAD",
    };
  }

  return { ok: true, seeded: undefined };
}
