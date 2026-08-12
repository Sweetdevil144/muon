import { execFile } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readlink, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import type { ReviewCoverageCertification } from "@muon/protocol";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const MAX_META_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_CHANGED_FILES = 500;
const GIT_TIMEOUT_MS = 15_000;

const gitNexusMetaSchema = z.object({
  lastCommit: z.string().regex(/^[0-9a-f]{7,64}$/i),
  fileHashes: z.record(z.string(), z.string()),
});

export type { ReviewCoverageCertification };

export type WorktreeReviewState = {
  changedFiles: string[];
  baselineCommit: string;
  repoHead: string;
  artifactDigest: string;
};

export type ReviewCertificationDependencies = {
  reviewState: (input: {
    repoRoot: string;
    worktreePath: string;
  }) => Promise<WorktreeReviewState>;
  readMeta: (repoRoot: string) => Promise<unknown>;
};

export type ReviewGitRunner = (
  cwd: string,
  args: string[]
) => Promise<string>;

export type ReviewArtifactReader = (
  worktreePath: string,
  relativePath: string,
  maxBytes: number
) => Promise<{
  kind: "file" | "symlink" | "deleted";
  content: Buffer;
  executable: boolean;
}>;

async function defaultGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  return String(stdout);
}

function updateDigestField(
  digest: Hash,
  label: string,
  value: string | Buffer
): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  digest.update(label);
  digest.update("\0");
  digest.update(length);
  digest.update(bytes);
}

async function defaultReadArtifact(
  worktreePath: string,
  relativePath: string,
  maxBytes: number
): Promise<{
  kind: "file" | "symlink" | "deleted";
  content: Buffer;
  executable: boolean;
}> {
  const absolutePath = join(worktreePath, relativePath);
  let info;
  try {
    info = await lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        kind: "deleted",
        content: Buffer.alloc(0),
        executable: false,
      };
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    const content = Buffer.from(await readlink(absolutePath), "utf8");
    if (content.byteLength > maxBytes) {
      throw new Error("Changed artifact exceeds the review byte bound.");
    }
    return {
      kind: "symlink",
      content,
      executable: false,
    };
  }
  if (info.isFile()) {
    if (info.size > maxBytes) {
      throw new Error("Changed artifact exceeds the review byte bound.");
    }
    const handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.size > maxBytes) {
        throw new Error("Changed artifact exceeds the review byte bound.");
      }
      return {
        kind: "file",
        content: await handle.readFile(),
        executable: (current.mode & 0o111) !== 0,
      };
    } finally {
      await handle.close();
    }
  }
  throw new Error(
    `Changed review path '${relativePath}' is not a regular file or symlink.`
  );
}

/**
 * Collect the complete delta that the merge executor could land. Comparing the
 * worktree's current filesystem to its merge-base catches vendor-created
 * commits as well as staged/unstaged edits; untracked files are added
 * separately because ordinary git diff omits them.
 */
export async function collectWorktreeReviewState(
  input: { repoRoot: string; worktreePath: string },
  git: ReviewGitRunner = defaultGit,
  readArtifact: ReviewArtifactReader = defaultReadArtifact
): Promise<WorktreeReviewState> {
  const [repoHeadRaw, worktreeHeadRaw] = await Promise.all([
    git(input.repoRoot, ["rev-parse", "HEAD"]),
    git(input.worktreePath, ["rev-parse", "HEAD"]),
  ]);
  const repoHead = repoHeadRaw.trim();
  const worktreeHead = worktreeHeadRaw.trim();
  const baselineCommit = (
    await git(input.worktreePath, [
      "merge-base",
      repoHead,
      worktreeHead,
    ])
  ).trim();
  const [tracked, untracked] = await Promise.all([
    git(input.worktreePath, [
      "diff",
      "--name-only",
      "-z",
      baselineCommit,
      "--",
    ]),
    git(input.worktreePath, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  ]);
  const trackedFiles = tracked.split("\0").filter(Boolean);
  const untrackedFiles = untracked.split("\0").filter(Boolean);
  const changedFiles = [
    ...new Set([...trackedFiles, ...untrackedFiles]),
  ].sort();
  if (changedFiles.length > MAX_CHANGED_FILES) {
    throw new Error(
      `Changed-file evidence exceeds the ${MAX_CHANGED_FILES}-file review bound.`
    );
  }

  const digest = createHash("sha256");
  updateDigestField(digest, "format", "muon-merge-artifact-v1");
  updateDigestField(digest, "baseline", baselineCommit);
  updateDigestField(digest, "repo-head", repoHead);

  let artifactBytes =
    Buffer.byteLength(baselineCommit) + Buffer.byteLength(repoHead);
  for (const file of changedFiles) {
    const normalized = posix.normalize(file);
    if (
      posix.isAbsolute(file) ||
      normalized !== file ||
      normalized === ".." ||
      normalized.startsWith("../")
    ) {
      throw new Error(`Unsafe changed review path '${file}'.`);
    }
    artifactBytes += Buffer.byteLength(file);
    if (artifactBytes > MAX_ARTIFACT_BYTES) {
      throw new Error(
        "Changed artifact exceeds the 8 MiB review certification bound."
      );
    }
    const { kind, content, executable } = await readArtifact(
      input.worktreePath,
      normalized,
      MAX_ARTIFACT_BYTES - artifactBytes
    );
    artifactBytes += content.byteLength;
    if (artifactBytes > MAX_ARTIFACT_BYTES) {
      throw new Error(
        "Changed artifact exceeds the 8 MiB review certification bound."
      );
    }
    updateDigestField(digest, "kind", kind);
    updateDigestField(
      digest,
      "mode",
      executable ? "executable" : "regular"
    );
    updateDigestField(digest, "path", file);
    updateDigestField(digest, "content", content);
  }

  return {
    changedFiles,
    baselineCommit,
    repoHead,
    artifactDigest: digest.digest("hex"),
  };
}

async function defaultReadMeta(repoRoot: string): Promise<unknown> {
  const path = join(repoRoot, ".gitnexus", "meta.json");
  const info = await stat(path);
  if (info.size > MAX_META_BYTES) {
    throw new Error("GitNexus metadata exceeds the review bound.");
  }
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

const defaultDependencies: ReviewCertificationDependencies = {
  reviewState: collectWorktreeReviewState,
  readMeta: defaultReadMeta,
};

function commitsMatch(indexed: string, head: string): boolean {
  return indexed.startsWith(head) || head.startsWith(indexed);
}

/**
 * Backend merge backstop for every operator surface.
 *
 * Desktop still renders the richer affected-flow `review_diff` report. This
 * route-level check guarantees the minimum security property CLI/TUI lacked:
 * the exact worktree has a fresh GitNexus baseline and every changed path was
 * present in that index. Missing, stale, malformed, oversized, or incomplete
 * evidence fails closed before an approval can become approved.
 */
export async function certifyWorktreeReviewCoverage(
  input: { repoRoot: string; worktreePath: string },
  dependencies: ReviewCertificationDependencies = defaultDependencies
): Promise<ReviewCoverageCertification> {
  let reviewState: WorktreeReviewState;
  try {
    reviewState = await dependencies.reviewState(input);
  } catch (error) {
    return {
      status: "blocked",
      blockCode: "unavailable",
      changedFiles: [],
      artifactDigest: createHash("sha256")
        .update("muon-review-unavailable")
        .digest("hex"),
      reason: `Changed-file evidence is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const {
    changedFiles,
    baselineCommit,
    repoHead,
    artifactDigest,
  } = reviewState;
  if (changedFiles.length === 0) {
    return {
      status: "certified",
      verdict: "no-op",
      changedFiles,
      artifactDigest,
      baselineCommit,
      headCommit: repoHead,
    };
  }

  try {
    const rawMeta = await dependencies.readMeta(input.repoRoot);
    const meta = gitNexusMetaSchema.parse(rawMeta);
    if (
      !commitsMatch(meta.lastCommit, baselineCommit) ||
      !commitsMatch(meta.lastCommit, repoHead) ||
      !commitsMatch(repoHead, baselineCommit)
    ) {
      return {
        status: "blocked",
        blockCode: "stale",
        changedFiles,
        artifactDigest,
        indexedCommit: meta.lastCommit,
        baselineCommit,
        headCommit: repoHead,
        reason:
          "GitNexus review evidence is stale for this task worktree. Re-index or rebase the worktree, then retry approval.",
      };
    }
    const blindFiles = changedFiles.filter(
      (file) => meta.fileHashes[file] === undefined
    );
    if (blindFiles.length > 0) {
      return {
        status: "blocked",
        blockCode: "review-blind",
        changedFiles,
        artifactDigest,
        blindFiles,
        indexedCommit: meta.lastCommit,
        baselineCommit,
        headCommit: repoHead,
        reason: `REVIEW BLIND: ${blindFiles.length} changed file(s) are new or absent from the GitNexus index.`,
      };
    }
    return {
      status: "certified",
      verdict: "graph-certified",
      changedFiles,
      artifactDigest,
      indexedCommit: meta.lastCommit,
      baselineCommit,
      headCommit: repoHead,
    };
  } catch (error) {
    return {
      status: "blocked",
      blockCode: "unavailable",
      changedFiles,
      artifactDigest,
      reason: `GitNexus review evidence is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
