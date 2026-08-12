import { z } from "zod";

// Handoff packet content is AGENT-PRODUCED UNTRUSTED DATA. It rides only
// surfaces that already carry untrusted text (packetBody-equivalent), it is
// never instructions, never authority, and never enters confirmed memory or
// approval evidence. v2 is strictly additive: every v1 key parses unchanged
// and every new key is optional/defaulted so old wire payloads keep parsing.

const sha256HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const handoffCheckSchema = z.object({
  name: z.string().min(1).max(120),
  command: z.string().max(500).optional(),
  /**
   * `passed-but-uncovering` is a GREEN command that proved nothing: it exited
   * zero, and MUON resolved its actual test-collection scope and found it
   * observes NONE of the run's changed files. It is deliberately not spelled
   * `passed-*` in the sense any reader can shorten — every existing consumer
   * compares `=== "passed"`, so this value fails those comparisons closed.
   *
   * It exists because the alternative is a false attestation. A real mission
   * changed only `apps/cli/tests/crew.test.ts`, the harness check was
   * `npm test`, and the root vitest `include` covers `src/**` and
   * `packages/protocol/tests/**` — so the changed suite never ran, and the
   * packet still said `outcome: passed, exitCode: 0` with a summary naming
   * `packages/protocol/tests/vendor-registry.test.ts`. The evidence contained
   * the proof of its own irrelevance and nothing compared the two.
   */
  outcome: z.enum([
    "passed",
    "passed-but-uncovering",
    "failed",
    "skipped",
    "error",
  ]),
  exitCode: z.number().int().optional(),
  summary: z.string().max(500).default(""),
});
export type HandoffCheck = z.infer<typeof handoffCheckSchema>;

/**
 * ADR-0037 phase 2 — the READ-side check, carrying MUON's own flakiness
 * annotation.
 *
 * This is a SEPARATE schema, and the separation is the security property.
 * `handoffCheckSchema` above is what an agent SUBMITS, and it does not name
 * `flakiness`, so a packet claiming "known-flaky: failed 1 of 20" cannot even
 * be expressed on the write path — zod drops the key before anything reads it.
 * Only MUON's own annotator, running server-side over history MUON recorded,
 * produces a value that fits the schema below.
 *
 * That matters because "known-flaky" is the most abusable label in a test
 * report: an agent that may apply it has been handed a way to ship broken work
 * while sounding rigorous. The backend still strips a claimed annotation
 * defensively (`stripClaimedFlakiness`), but defence-in-depth is the second
 * line here — the first is that the field is not in the vocabulary an agent
 * writes.
 *
 * Phase 1 shipped the annotator and nothing else, so the annotation reached
 * ZERO humans: every consumer re-validated with `handoffPacketSchema`, which
 * strips unknown keys. This schema is what lets it survive that round trip.
 */
export const flakinessSchema = z.object({
  kind: z.enum([
    "insufficient-evidence",
    "stable",
    "flaky",
    "consistently-failing",
  ]),
  runs: z.number().int().min(0),
  failures: z.number().int().min(0),
});

export const annotatedHandoffCheckSchema = handoffCheckSchema.extend({
  flakiness: flakinessSchema.optional(),
  flakinessNote: z.string().max(200).optional(),
});
export type AnnotatedHandoffCheck = z.infer<
  typeof annotatedHandoffCheckSchema
>;

export const handoffArtifactSchema = z.object({
  path: z.string().min(1).max(260),
  kind: z.enum(["file", "report", "log", "other"]).default("file"),
  hash: sha256HashSchema.optional(),
});
export type HandoffArtifact = z.infer<typeof handoffArtifactSchema>;

export const handoffMemoryProposalSchema = z.object({
  kind: z
    .enum(["decision", "constraint", "convention", "attempt", "question"])
    .default("attempt"),
  text: z.string().min(1).max(1000),
});
export type HandoffMemoryProposal = z.infer<typeof handoffMemoryProposalSchema>;

export const handoffDegradationSchema = z.object({
  flag: z.boolean(),
  reasons: z.array(z.string().min(1).max(200)).max(20),
});
export type HandoffDegradation = z.infer<typeof handoffDegradationSchema>;

export const HANDOFF_PACKET_VERSION = 2;

/**
 * Stable degradation reason codes (prefix-match convention: detail may be
 * appended after `:` and is sliced to the 200-char reason bound).
 */
export const HANDOFF_DEGRADATION = {
  noCheckEvidence: "no_check_evidence",
  noDiffEvidence: "no_diff_evidence", // may carry `:workspace_not_worktree` / `:diff_error:<msg>`
  checksTruncated: "checks_truncated",
  changedFilesTruncated: "changed_files_truncated",
  diffStatTruncated: "diff_stat_truncated",
  /**
   * The run ended without the typed final report `WORKER_PREAMBLE` asks for, so
   * the packet carries no worker-stated open questions, uncertainties, next
   * action or memory proposals — only what MUON itself observed.
   *
   * This exists because `done` was otherwise indistinguishable from `done, and
   * here is the evidence`: two docs jobs reported `status: done, exitCode: 0`,
   * one had edited a file and one had not, and nothing in the ledger told them
   * apart. A reader must be able to see the ABSENCE, so it is named rather than
   * left to be inferred from empty lists — a worker that legitimately has no
   * open questions produces the same empty list.
   */
  noWorkerReport: "no_worker_report",
  /**
   * The diff is EMPTY, so there was nothing for any check to verify.
   * `diffVerified` used to be true here — a run recorded
   * `diffHash: sha256:e3b0c442…b855` (the SHA-256 of the empty string) and
   * `changedFiles: []` and still claimed verification. A flag that is true for
   * an empty diff means nothing anywhere, so the empty case is NAMED instead.
   */
  emptyDiff: "empty_diff",
  /**
   * Changed files exist and a diff hash was taken, but no check MUON could
   * scope observes those paths — so the diff is hashed, not verified. May carry
   * `:<detail>` naming what the green check actually collected.
   */
  uncoveredDiff: "checks_did_not_cover_diff",
  /**
   * A hash exists but the changed-path list does not, so there is nothing to
   * intersect a check's scope against. Verification is unproven, not false.
   */
  changedFilesUnknown: "changed_files_unknown",
} as const;

/**
 * Bound for `finalMessage`. Big enough to hold a real closing report (the two
 * the founder lost were 5 431 and 4 910 characters), small enough that a packet
 * carrying one cannot approach the 256 KiB route backstop even beside 200
 * changed files and 50 checks.
 */
export const HANDOFF_FINAL_MESSAGE_CHARS = 8_000;

export const handoffPacketSchema = z.object({
  taskGoal: z.string().min(3),
  whatChanged: z.string().min(3),
  whatFailed: z.string().min(3),
  nextLaneRequest: z.string().min(3),
  commandsRun: z.array(z.string()),
  checksStatus: z.array(z.string()),
  openQuestions: z.array(z.string()),
  provenance: z.object({
    lane: z.string(),
    sessionId: z.string().optional(),
    createdAt: z.string(),
  }),
  // ---- v2 (P0.3 typed terminal contract), all defaulted/optional so v1
  // payloads parse untouched ----
  schemaVersion: z.number().int().min(1).default(1),
  changedFiles: z.array(z.string().min(1).max(260)).max(200).default([]),
  diffHash: sha256HashSchema.optional(),
  diffVerified: z.boolean().default(false),
  checks: z.array(handoffCheckSchema).max(50).default([]),
  artifacts: z.array(handoffArtifactSchema).max(50).default([]),
  uncertainties: z.array(z.string().min(1).max(500)).max(25).default([]),
  unresolvedDecisions: z.array(z.string().min(1).max(500)).max(25).default([]),
  recommendedNextAction: z.string().max(1000).optional(),
  memoryProposals: z.array(handoffMemoryProposalSchema).max(10).default([]),
  /**
   * Bounded, REDACTED tail of what the worker actually ended with — its own
   * closing words, whether or not the ten-label report parsed out of them.
   *
   * A SECOND DURABLE COPY, on purpose. A final report used to exist in exactly
   * one truncated place: the live stream chunk, head-cut at 4 000 characters.
   * `DispatchJob.result` is no substitute — it keeps the opposite end, and for a
   * `loop` job it holds MUON's own verdict line ("loop passed in 1 iteration…")
   * rather than the worker's output at all, so a loop child's report tail was
   * simply unrecoverable. This field is the copy that survives independently of
   * how the stream was rendered or bounded.
   *
   * When `no_worker_report` is also set, this is additionally the evidence for
   * WHY nothing parsed (wrong labels, a wrapping code fence, a cut-off
   * message) instead of a bare assertion that nothing did.
   *
   * Untrusted vendor text: data on a data-only surface, never instructions.
   */
  finalMessage: z.string().max(HANDOFF_FINAL_MESSAGE_CHARS + 1).optional(),
  degraded: handoffDegradationSchema.default({ flag: false, reasons: [] }),
});

export type HandoffPacket = z.infer<typeof handoffPacketSchema>;

/**
 * The packet as a READER receives it: identical to `handoffPacketSchema`
 * except that checks may carry MUON's flakiness annotation.
 *
 * Read-side only, deliberately. Nothing that ingests an agent-authored packet
 * should parse with this — see `annotatedHandoffCheckSchema` for why the two
 * vocabularies are kept apart.
 */
export const annotatedHandoffPacketSchema = handoffPacketSchema.extend({
  checks: z.array(annotatedHandoffCheckSchema).max(50).default([]),
});
export type AnnotatedHandoffPacket = z.infer<
  typeof annotatedHandoffPacketSchema
>;
