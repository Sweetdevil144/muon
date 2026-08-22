import type {
  ApprovalGrantDuration,
  ManualReviewAttestation,
} from "@muon/protocol";

/**
 * The ONE place a governed approval decision's payload is built.
 *
 * Seven call sites construct this today (two in desktop main, one in the
 * desktop renderer, two TUI desks, the CLI, the approvals monitor), each
 * assembling the same four fields by hand. A governed write must not have a
 * per-surface dialect: the audit event, `muon report` and the exported bundle
 * all consume `decisionNotes`, so a surface that forgets it makes a human's
 * decision indistinguishable from a scripted API call — and nothing about the
 * shape of an inline object literal prevents the next surface from forgetting
 * again.
 *
 * So the attribution rule lives here, applied by construction:
 *
 *  - EVERY decision carries a `decisionNotes`. A surface that supplies none
 *    gets its own attribution sentence; a surface with a human's note keeps
 *    the note (a human's words outrank a template) and never loses the
 *    surface, because the surface is appended.
 *  - The receipt rides ONLY where a caller asks for one, and only as the
 *    shared `{ ttlMs }` shape the server clamps.
 *  - `manualReview` is passed through untouched: it is an attestation bound
 *    to a digest, and rewriting any part of it here would break that binding.
 */

export type DecisionSurface =
  | "MUON TUI"
  | "MUON desktop"
  | "MUON CLI"
  | "MUON automation";

export type ApprovalDecisionInput = {
  readonly approvalId: string;
  readonly status: "approved" | "rejected";
  readonly surface: DecisionSurface;
  /** A human's own words, when the surface collected any. */
  readonly notes?: string | undefined;
  /** Present only when the surface offered — and the human took — "remember". */
  readonly receiptTtlMs?: number | undefined;
  /**
   * ADR-0056: the GRADED form of the same opt-in — `once` (mints nothing),
   * `session` (this run) or `always` (this chat, until it expires or the
   * operator revokes). Mutually exclusive with `receiptTtlMs`; the builder
   * refuses both rather than silently picking one, because a surface that
   * quietly downgrades a human's chosen grade is exactly the drift this module
   * exists to prevent.
   */
  readonly grantDuration?: ApprovalGrantDuration | undefined;
  readonly manualReview?: ManualReviewAttestation | undefined;
};

export type ApprovalDecisionPayload = {
  approvalId: string;
  status: "approved" | "rejected";
  decisionNotes: string;
  receipt?: { ttlMs: number };
  grant?: { duration: ApprovalGrantDuration };
  manualReview?: ManualReviewAttestation;
};

export function buildApprovalDecision(
  input: ApprovalDecisionInput
): ApprovalDecisionPayload {
  if (input.receiptTtlMs !== undefined && input.grantDuration !== undefined) {
    throw new Error(
      "An approval decision carries one durable authority: pass either receiptTtlMs or grantDuration, never both."
    );
  }
  const note = input.notes?.trim();
  const attribution = input.manualReview
    ? `manually reviewed from ${input.surface}`
    : `decided from ${input.surface}`;
  return {
    approvalId: input.approvalId,
    status: input.status,
    // A human's note NEVER replaces the attribution, and attribution never
    // replaces the note. Both are consumed downstream by different readers.
    decisionNotes: note ? `${note} (${attribution})` : attribution,
    ...(input.receiptTtlMs === undefined
      ? {}
      : { receipt: { ttlMs: input.receiptTtlMs } }),
    // `once` is a real answer, not an absence: it is sent so the server records
    // the grade the human actually chose, and it mints nothing by definition.
    ...(input.grantDuration === undefined
      ? {}
      : { grant: { duration: input.grantDuration } }),
    ...(input.manualReview === undefined
      ? {}
      : { manualReview: input.manualReview }),
  };
}
