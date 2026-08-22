import { codeImpactEvidenceFromTool } from "./code-impact-evidence.js";
import type { MemoryImpactClaim } from "@muon/protocol";
import type { GitNexusSymbolResolution } from "./gitnexus-tools.js";

/**
 * ADR-0063 — `memory_ground`'s third check, as a PURE decision function so
 * every branch is pinnable without simulating the GitNexus CLI. The handler
 * owns only the plumbing (resolve the target, run `code_impact` when it
 * resolved); everything that decides a verdict lives here.
 *
 * The philosophy mirrors the anchor check's: a HEALTHY graph's "not-found"
 * is evidence (mismatch); a graph that could not be asked is not evidence
 * of anything (not-checkable); and only the FRESHNESS half of the edit gate
 * is applied — a changed risk tier is the DIFF, never a reason to refuse
 * the diff.
 */
export type ImpactAgreementCheck = {
  kind: "impact-agreement";
  verdict: "holds" | "mismatch" | "not-checkable";
  detail: string;
};

export function impactAgreementCheck(
  claim: MemoryImpactClaim,
  resolved: GitNexusSymbolResolution,
  impact:
    | { isError?: boolean; structuredContent?: Record<string, unknown> }
    | undefined,
  gitCommitsMatch: (a: string, b: string) => boolean
): ImpactAgreementCheck {
  const row = (
    verdict: ImpactAgreementCheck["verdict"],
    detail: string
  ): ImpactAgreementCheck => ({
    kind: "impact-agreement",
    verdict,
    detail: detail.slice(0, 480),
  });
  if (resolved.status === "error") {
    return row(
      "not-checkable",
      `the claim's target could not be checked (${resolved.detail.slice(0, 120)})`
    );
  }
  if (resolved.status === "not-found") {
    return row(
      "mismatch",
      `the claim's target '${claim.target}' no longer resolves in the code graph (claimed at ${claim.atCommit})`
    );
  }
  // ADR-0089: THE producing seam — the same typed parse every consumer
  // runs; an unreadable payload is not-checkable, never a partial cast.
  const parsedEvidence = codeImpactEvidenceFromTool(impact);
  if (!parsedEvidence.ok) {
    return row(
      "not-checkable",
      "impact evidence is unavailable — a graph that could not be asked is not evidence of drift"
    );
  }
  const impactResult = parsedEvidence.evidence.result;
  const repo = parsedEvidence.evidence.repo;
  const graphCommit =
    typeof repo.graphCommit === "string" ? repo.graphCommit : undefined;
  const headCommit =
    typeof repo.headCommit === "string" ? repo.headCommit : undefined;
  if (
    !graphCommit ||
    !headCommit ||
    !gitCommitsMatch(graphCommit, headCommit) ||
    repo.stale !== false
  ) {
    return row(
      "not-checkable",
      "the code graph is stale or its indexed commit could not be verified; a stale index must not testify — reindex, then ground again"
    );
  }
  // ADR-0089: the seam already normalized — counts are number|null and
  // risk is the four-value vocabulary or null. Reading, not re-validating.
  const nowDirect = impactResult.summary?.direct ?? null;
  const nowProcesses = impactResult.summary?.processes_affected ?? null;
  const nowRisk = impactResult.risk;
  if (nowDirect === null || nowProcesses === null || nowRisk === null) {
    return row(
      "not-checkable",
      "impact returned an incomplete summary; nothing comparable to the claim"
    );
  }
  const drifts: string[] = [];
  if (nowDirect !== claim.summary.directCallers) {
    drifts.push(`direct callers ${claim.summary.directCallers}→${nowDirect}`);
  }
  if (nowProcesses !== claim.summary.processes) {
    drifts.push(`processes ${claim.summary.processes}→${nowProcesses}`);
  }
  if (nowRisk !== claim.summary.risk) {
    drifts.push(`risk ${claim.summary.risk}→${nowRisk}`);
  }
  if (drifts.length > 0) {
    return row(
      "mismatch",
      `blast radius drifted since ${claim.atCommit}: ${drifts.join(", ")} (measured at ${headCommit.slice(0, 12)})`
    );
  }
  return row(
    "holds",
    `impact re-run agrees with the claim from ${claim.atCommit}: ${nowDirect} direct caller(s), ${nowProcesses} process(es), risk ${nowRisk}`
  );
}
