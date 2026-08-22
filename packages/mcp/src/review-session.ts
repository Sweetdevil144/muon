import { createHash } from "node:crypto";

/**
 * A4 — `review_diff` before `ship`, as a SESSION-SCOPED preflight.
 *
 * `ship` files the merge gate. Until now it checked nothing at all: a
 * coordinator could file a merge for a task it had never looked at, and the
 * only thing standing between that and a human clicking approve was the
 * server-side certification at decision time.
 *
 * That certification IS still the authority, and nothing here replaces it.
 * What this adds is the cheap, early, honest half: a coordinator that has not
 * run `review_diff` for the task it is about to ship is told so BY NAME, with
 * the exact call to make, instead of discovering it after a human has been
 * pulled into an inbox.
 *
 * WHY SESSION-SCOPED, deliberately:
 *  - The record lives in this MCP process and dies with it. A fresh session
 *    must re-run `review_diff` before it may ship. That is the intended
 *    behaviour, not a limitation: "someone reviewed this once" is not evidence
 *    that THIS coordinator has looked at the change it is proposing to merge.
 *  - It is therefore never a grant. Holding a record cannot make a blind diff
 *    shippable, cannot outlive the process, and cannot be forged from a tool
 *    argument — the id is computed from the diff MUON itself read.
 */

/** What one `review_diff` call proved, and when. */
export type ReviewDiffRecord = {
  /** The stable id echoed to the caller as `reviewDiff.id`. */
  readonly id: string;
  /** `no-op` / `flows-resolved` / `review-blind`, verbatim from the impact. */
  readonly verdict: string;
  /** Epoch ms, so a surface can say how old the evidence is. */
  readonly at: number;
  /** Bounded blind-file list, for the recovery actions A6 enumerates. */
  readonly blindFiles: readonly string[];
  /** ADR-0065: the STRUCTURED citation channel on review evidence — the
   *  note coordinates the reviewer's verdict leaned on. Caller-asserted
   *  provenance (recorded, never authority) and deliberately NOT part of
   *  the review id, which is computed only from what MUON itself read. */
  readonly citedNoteIds: readonly string[];
};

/**
 * The per-session store, keyed by `reviewDiffKey`. A plain Map shared by
 * reference between the base tools (which write it) and the control tools
 * (which read it): they are composed separately and never see each other's
 * scope, so the shared object IS the wire between them.
 */
export type ReviewDiffLedger = Map<string, ReviewDiffRecord>;

export function createReviewDiffLedger(): ReviewDiffLedger {
  return new Map();
}

/**
 * ONE key per record, and no fallback between the two forms.
 *
 * A review of the caller's OWN tree must never satisfy a ship of a SIBLING
 * task: those are different worktrees with different changes, and a lookup
 * that fell back from `task:` to `workspace:` would certify the second with
 * evidence about the first. So `ship(taskId)` looks up `task:<taskId>` and
 * nothing else, which is why the refusal tells the caller to run `review_diff`
 * WITH the taskId.
 */
export function reviewDiffKey(
  input: { taskId?: string; workspacePath?: string }
): string {
  const taskId = input.taskId?.trim();
  if (taskId) return `task:${taskId}`;
  return `workspace:${input.workspacePath?.trim() ?? ""}`;
}

/**
 * A6 — how many blind files a recovery payload names. Bounded because a
 * blind-file list is a workspace path set and a reviewer needs a handle on it,
 * not a directory listing; the count beside it stays exact.
 */
export const BLIND_RECOVERY_LIMIT = 20;

/**
 * A6 — the LAWFUL WAYS OUT of REVIEW BLIND, enumerated as concrete actions.
 *
 * One list, used verbatim by `review_diff`'s degradation payload and by every
 * `ship` refusal for a blind verdict, so the two can never advise differently
 * about the same state. Order is the order to try them in.
 *
 * Two things this deliberately does NOT say. It never offers "file the merge
 * anyway" — the orchestrator has no lawful path to a merge while blind, and an
 * action list is where an agent looks for one. And the manual-attest path is
 * named as an OPERATOR act, because it is: the backend accepts a manual review
 * attestation only from the operator tier and only when the certification's
 * own `blockCode` is `review-blind`.
 */
export function blindRecoveryActions(taskId?: string): string[] {
  const rerun = taskId
    ? `review_diff with taskId '${taskId}'`
    : "review_diff with a narrower scope (staged/unstaged) or an explicit baseRef";
  return [
    "Re-index this workspace so the blind files enter the graph: `gitnexus analyze --index-only` (add `--force` when the index predates this code), then re-run review_diff. If MUON is already rebuilding the index, wait for it rather than starting a second `gitnexus analyze`.",
    `Bound the diff and look again: re-run ${rerun} so a smaller, fully-indexed change can reach a resolved verdict instead of one blind file blinding the whole review.`,
    "If the files cannot be indexed, a HUMAN must read every blind file and record a manual review attestation on the merge approval (operator tier; the backend accepts it only against a review-blind certification). You cannot attest on their behalf, and you cannot file the merge while blind.",
  ];
}

/**
 * The id, derived from the evidence rather than assigned.
 *
 * Same inputs → same id, so a caller can tell "I re-ran the same review" from
 * "the tree moved under me", and an id quoted on an approval can be compared
 * against a fresh run. It is a COORDINATE, not a token: it grants nothing, and
 * it is computed from what MUON read, never from anything a caller supplied.
 *
 * 24 hex characters: enough that two genuinely different diffs in one session
 * cannot collide by accident, short enough to be quoted in a sentence.
 */
export function computeReviewDiffId(input: {
  scope: string;
  baseRef?: string;
  verdict: string;
  changedFiles: readonly string[];
  graphCommit?: string;
}): string {
  const digest = createHash("sha256");
  // Field-separated and length-prefixed nowhere, so the separator has to be a
  // character a path cannot contain: "\n" is refused by git in a path anyway,
  // and the sorted file list makes the id independent of git's ordering.
  digest.update(input.scope);
  digest.update("\n");
  digest.update(input.baseRef ?? "");
  digest.update("\n");
  digest.update(input.verdict);
  digest.update("\n");
  digest.update([...input.changedFiles].sort().join("\n"));
  digest.update("\n");
  digest.update(input.graphCommit ?? "");
  return digest.digest("hex").slice(0, 24);
}
