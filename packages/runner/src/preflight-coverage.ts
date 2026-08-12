import { createHmac, timingSafeEqual } from "node:crypto";
import type { MuonApiClient, RecordedEvent } from "@muon/client";
import { collectWorktreeEvidence } from "@muon/core";
import {
  gitCommitsMatch,
  preflightEditEvidencePayload,
  preflightEditEvidenceSchema,
  type PreflightEditEvidence,
} from "@muon/protocol";

export type EditPreflightCoverage = {
  ok: boolean;
  changedFiles: string[];
  coveredFiles: string[];
  uncoveredFiles: string[];
  reason?: string;
};

function hasValidProof(
  evidence: PreflightEditEvidence,
  nonce: string
): boolean {
  const expected = createHmac("sha256", nonce)
    .update(preflightEditEvidencePayload(evidence))
    .digest();
  const actual = Buffer.from(evidence.proof, "hex");
  return (
    actual.length === expected.length && timingSafeEqual(actual, expected)
  );
}

export function evaluateEditPreflightCoverage(input: {
  changedFiles: string[];
  events: RecordedEvent[];
  jobId: string;
  nonce: string;
}): EditPreflightCoverage {
  const changedFiles = [...new Set(input.changedFiles)].sort();
  if (changedFiles.length === 0) {
    return {
      ok: true,
      changedFiles,
      coveredFiles: [],
      uncoveredFiles: [],
    };
  }

  const covered = new Set<string>();
  for (const event of input.events) {
    const parsed = preflightEditEvidenceSchema.safeParse(
      event.metadata.preflightEdit
    );
    if (
      !parsed.success ||
      parsed.data.jobId !== input.jobId ||
      !gitCommitsMatch(
        parsed.data.graphCommit,
        parsed.data.headCommit
      ) ||
      !hasValidProof(parsed.data, input.nonce)
    ) {
      continue;
    }
    parsed.data.coveredFiles.forEach((file) => covered.add(file));
  }
  const coveredFiles = [...covered].sort();
  const uncoveredFiles = changedFiles.filter((file) => !covered.has(file));
  return uncoveredFiles.length === 0
    ? {
        ok: true,
        changedFiles,
        coveredFiles,
        uncoveredFiles,
      }
    : {
        ok: false,
        changedFiles,
        coveredFiles,
        uncoveredFiles,
        reason:
          coveredFiles.length === 0
            ? "No verified preflight_edit evidence was recorded for this job."
            : `Changed files lack verified preflight_edit coverage: ${uncoveredFiles.join(", ")}`,
      };
}

export async function verifyEditPreflightCoverage(input: {
  client: MuonApiClient;
  taskId: string;
  jobId: string;
  nonce: string;
  worktreeCwd?: string;
}): Promise<EditPreflightCoverage> {
  if (!input.worktreeCwd) {
    return {
      ok: false,
      changedFiles: [],
      coveredFiles: [],
      uncoveredFiles: [],
      reason:
        "Edit preflight completion cannot be verified without a governed task worktree.",
    };
  }
  const evidence = await collectWorktreeEvidence(input.worktreeCwd);
  if (!evidence.changedFiles) {
    return {
      ok: false,
      changedFiles: [],
      coveredFiles: [],
      uncoveredFiles: [],
      reason:
        "Changed-file evidence is unavailable; refusing to certify edit preflight coverage.",
    };
  }
  if (evidence.changedFiles.length === 0) {
    return {
      ok: true,
      changedFiles: [],
      coveredFiles: [],
      uncoveredFiles: [],
    };
  }
  const events = await input.client.listTaskEvents(input.taskId);
  return evaluateEditPreflightCoverage({
    changedFiles: evidence.changedFiles,
    events,
    jobId: input.jobId,
    nonce: input.nonce,
  });
}
