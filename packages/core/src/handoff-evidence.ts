import { createHash } from "node:crypto";
import {
  isLinkedWorktree,
  worktreeChangedFiles,
  worktreeDiff,
} from "./worktree.js";

/**
 * Diff evidence for a handoff packet: either a verified full-stream sha256
 * of `git diff HEAD` (untracked included via intent-to-add), or an honest
 * reason why no hash could be produced. Absence is never silent.
 */
export type HandoffDiffInput =
  | { hash: string; totalBytes: number } // full-stream sha256, verified
  | { unavailableReason: string }; // honest absence

export type WorktreeEvidence = {
  diff: HandoffDiffInput;
  changedFiles?: string[];
};

/** Retained diff text is irrelevant here; the hash covers the full stream. */
const EVIDENCE_RETAINED_BYTES = 4096;

/**
 * Collects diff-hash + changed-file evidence from a governed task worktree.
 * Refuses to hash a primary checkout (same gate as the loop evaluator): a
 * non-worktree workspace yields `workspace_not_worktree`, and any diff
 * failure yields `diff_error:<msg>` instead of throwing.
 */
export async function collectWorktreeEvidence(
  worktreePath: string
): Promise<WorktreeEvidence> {
  if (!(await isLinkedWorktree(worktreePath))) {
    return { diff: { unavailableReason: "workspace_not_worktree" } };
  }

  let changedFiles: string[] | undefined;
  try {
    changedFiles = await worktreeChangedFiles(worktreePath);
  } catch {
    changedFiles = undefined;
  }

  try {
    const hash = createHash("sha256");
    const result = await worktreeDiff(worktreePath, {
      maxBytes: EVIDENCE_RETAINED_BYTES,
      onChunk: (chunk) => hash.update(chunk),
    });
    return {
      diff: {
        hash: `sha256:${hash.digest("hex")}`,
        totalBytes: result.totalBytes,
      },
      ...(changedFiles !== undefined ? { changedFiles } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      diff: { unavailableReason: `diff_error:${message.slice(0, 150)}` },
      ...(changedFiles !== undefined ? { changedFiles } : {}),
    };
  }
}
