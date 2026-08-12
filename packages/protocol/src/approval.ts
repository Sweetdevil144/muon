import { z } from "zod";

/**
 * `unknown` is its own tier, not a default. A risk MUON could not compute used
 * to fall through to `low` — the least alarming word on the surface for the
 * one case where MUON knows nothing at all. The rule for every consumer:
 * `unknown` is rendered as what it is and treated AT LEAST as `high`; it is
 * never a synonym for safe. (Round-3 #7; same fail-closed-by-vocabulary move
 * as the flake ledger's write schema.)
 */
export const approvalRiskSchema = z.enum(["low", "medium", "high", "unknown"]);
export type ApprovalRisk = z.infer<typeof approvalRiskSchema>;

export const approvalActionSchema = z.enum([
  "merge",
  "command",
  "deploy",
  "dangerous_action",
  "gate",
]);
export type ApprovalAction = z.infer<typeof approvalActionSchema>;

export const approvalEvidenceSchema = z
  .object({
    action: z.string().min(1).max(160),
    scope: z.string().min(1).max(2_000),
    riskLevel: approvalRiskSchema,
    impactIfApproved: z.string().min(5).max(4_000),
    payloadDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    details: z.record(z.string(), z.string().max(2_000)).default({}),
  })
  .strict();
export type ApprovalEvidence = z.infer<typeof approvalEvidenceSchema>;

export const reviewArtifactDigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/);

const reviewCoordinatesSchema = z.object({
  changedFiles: z.array(z.string().min(1).max(2_000)).max(500),
  artifactDigest: reviewArtifactDigestSchema,
  indexedCommit: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
  baselineCommit: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
  headCommit: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
});

/**
 * Current server-derived merge review state. File paths are repository-relative
 * coordinates only; no source text or credentials cross this contract.
 */
export const reviewCoverageCertificationSchema = z.union([
  reviewCoordinatesSchema.extend({
    status: z.literal("certified"),
    verdict: z.enum(["no-op", "graph-certified"]),
  }),
  reviewCoordinatesSchema.extend({
    status: z.literal("blocked"),
    blockCode: z.literal("review-blind"),
    reason: z.string().min(1).max(2_000),
    blindFiles: z.array(z.string().min(1).max(2_000)).min(1).max(500),
  }),
  reviewCoordinatesSchema.extend({
    status: z.literal("blocked"),
    blockCode: z.enum(["stale", "unavailable"]),
    reason: z.string().min(1).max(2_000),
    blindFiles: z
      .array(z.string().min(1).max(2_000))
      .max(500)
      .optional(),
  }),
]);
export type ReviewCoverageCertification = z.infer<
  typeof reviewCoverageCertificationSchema
>;

/**
 * Explicit human claim used only for REVIEW BLIND files. The server compares
 * both coordinates and the digest against a freshly recomputed worktree state.
 */
export const manualReviewAttestationSchema = z
  .object({
    acknowledged: z.literal(true),
    artifactDigest: reviewArtifactDigestSchema,
    blindFiles: z.array(z.string().min(1).max(2_000)).min(1).max(500),
  })
  .strict();
export type ManualReviewAttestation = z.infer<
  typeof manualReviewAttestationSchema
>;

/**
 * Durable operator-side audit record persisted on the approval decision.
 * `method:"operator-manual"` never means the graph certified the blind files.
 */
export const mergeReviewRecordSchema = z
  .object({
    version: z.literal(1),
    method: z.enum(["gitnexus", "operator-manual"]),
    verdict: z.enum(["no-op", "graph-certified", "review-blind-attested"]),
    artifactDigest: reviewArtifactDigestSchema,
    changedFiles: z.array(z.string().min(1).max(2_000)).max(500),
    blindFiles: z.array(z.string().min(1).max(2_000)).max(500),
    indexedCommit: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
    baselineCommit: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
    headCommit: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
    reviewedAt: z.string().datetime(),
    reviewer: z.literal("operator"),
  })
  .strict();
export type MergeReviewRecord = z.infer<typeof mergeReviewRecordSchema>;

/**
 * The longest a standing-approver lease may still be believed, measured from the
 * moment it is read. The issuer mints far shorter leases
 * (`STANDING_APPROVER_LEASE_TTL_MS`, backend), so this is the independent
 * ceiling every reader applies to a row it did not mint: a corrupted or
 * hand-edited `expiresAt` far in the future can never buy an un-revocable grant.
 */
export const STANDING_APPROVER_LEASE_HORIZON_MS = 120_000;

/**
 * "A standing operator approver is watching the approval inbox RIGHT NOW."
 *
 * This is the ONE fact that lets a session with no interactive operator gate
 * normally (file → wait) instead of denying fast: Full Auto ("Auto approve all")
 * is a live human posture, and while it holds, a filed approval really is
 * resolved by an operator-tier decider within a poll cycle.
 *
 * It is a LEASE, never a boolean. A persisted `true` written by a desktop that
 * then crashed would leave every coordinator ungated forever, so the grant is
 * only ever representable WITH the instant it lapses on its own: `active:false`
 * carries no expiry and `active:true` cannot exist without one. `.strict()` on
 * both arms keeps the surface complete — nothing else rides along inside an
 * authority-bearing envelope.
 */
export const standingApproverGrantSchema = z.discriminatedUnion("active", [
  z
    .object({
      active: z.literal(true),
      /** ISO-8601 instant this grant lapses unless the approver renews it. */
      expiresAt: z.string().datetime(),
    })
    .strict(),
  z.object({ active: z.literal(false) }).strict(),
]);
export type StandingApproverGrant = z.infer<typeof standingApproverGrantSchema>;

/**
 * Does a standing operator approver hold a LIVE watch on the approval inbox?
 *
 * The grant is stated positively and every clause must affirm it: the caller has
 * to hold a grant, the grant has to SAY it is active, its expiry has to parse,
 * and that expiry has to be both in the future and inside the horizon a real
 * issuer could have minted. Absence, a malformed instant, a lapsed lease and an
 * impossible one all resolve the same way — no watch — so the fail-closed path
 * is the one taken when anything at all is unknown.
 *
 * Shared by the runner, the session gate, and the brain so "is anyone watching"
 * has exactly one definition and cannot drift between the reader and the writer.
 */
export function standingApproverIsWatching(
  grant: StandingApproverGrant | undefined,
  now: number = Date.now()
): boolean {
  if (!grant || grant.active !== true) {
    return false;
  }
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return false;
  }
  return expiresAt > now && expiresAt - now <= STANDING_APPROVER_LEASE_HORIZON_MS;
}

export const approvalRequestSchema = z.object({
  lane: z.string().min(2),
  taskId: z.string().min(1),
  action: approvalActionSchema,
  riskLevel: approvalRiskSchema,
  reason: z.string().min(5),
  impactIfApproved: z.string().min(5),
  evidence: approvalEvidenceSchema.optional(),
});

export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
