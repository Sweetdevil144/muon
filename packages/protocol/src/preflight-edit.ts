import { z } from "zod";

export const preflightEditRiskSchema = z.enum(["LOW", "MEDIUM"]);
export type PreflightEditRisk = z.infer<typeof preflightEditRiskSchema>;

export const preflightEditEvidenceSchema = z
  .object({
    version: z.literal(1),
    jobId: z.string().min(1).max(200),
    target: z.string().min(1).max(200),
    filePath: z.string().min(1).max(1024),
    risk: preflightEditRiskSchema,
    graphCommit: z.string().min(1).max(100),
    headCommit: z.string().min(1).max(100),
    coveredFiles: z.array(z.string().min(1).max(1024)).max(128),
    proof: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type PreflightEditEvidence = z.infer<
  typeof preflightEditEvidenceSchema
>;

export type UnsignedPreflightEditEvidence = Omit<
  PreflightEditEvidence,
  "proof"
>;

export function gitCommitsMatch(
  left: string | undefined,
  right: string | undefined
): boolean {
  if (!left || !right || left.length < 7 || right.length < 7) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

/**
 * Stable payload for runner-issued, job-scoped completion evidence. It records
 * that MUON's MCP handler completed the graph + memory preflight and is never
 * operator authority granted by model output.
 */
export function preflightEditEvidencePayload(
  input: UnsignedPreflightEditEvidence
): string {
  return JSON.stringify({
    version: input.version,
    jobId: input.jobId,
    target: input.target,
    filePath: input.filePath,
    risk: input.risk,
    graphCommit: input.graphCommit,
    headCommit: input.headCommit,
    coveredFiles: [...new Set(input.coveredFiles)].sort(),
  });
}
