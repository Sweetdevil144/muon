import { describe, expect, it } from "vitest";
import type { DiffImpact } from "@muon/client/diff-impact";
import type { ReviewDiffResponse } from "../src/shared/ipc.js";
import {
  mergeShipBlockReason,
  mergeShipRefusal,
} from "../src/renderer/lib/ship-gate.js";
import { renderRefusalLine } from "@muon/client/refusal";

const impact = (over: Partial<DiffImpact> = {}): DiffImpact => ({
  scope: "all",
  totals: { changedFiles: 2, resolvedFiles: 1, blindFiles: 1, changedSymbols: 3, affectedProcesses: 0 },
  blindFiles: ["src/new.ts"],
  changedSymbols: [],
  affectedProcesses: [],
  coverage: 0.5,
  indexFreshness: { graphCommit: "abc1234", headCommit: "def5678", stale: true },
  verdict: "review-blind",
  notes: ["REVIEW BLIND: 1/2 changed file(s) are not in the graph."],
  ...over,
});

const ok = (over?: Partial<DiffImpact>): ReviewDiffResponse => ({
  status: "ok",
  impact: impact(over),
});

const mergeApproval = { kind: "merge", jobId: "job-1" };

describe("mergeShipBlockReason — the fail-closed ship gate", () => {
  it("BLOCKS approving a review-blind merge, surfacing the reason", () => {
    const reason = mergeShipBlockReason(mergeApproval, "approved", ok());
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/REVIEW BLIND/);
    // review_diff's own honesty note still reaches the operator...
    expect(reason).toMatch(/not in the graph/);
    // ...and so does a lawful way forward. Asserted by intent rather than
    // exact prose: ADR-0033 renders this from a typed next action now, so
    // pinning the sentence would fail on a wording change that fixed nothing.
    expect(reason).toMatch(/re-index/i);
    expect(reason).toMatch(/attest|review every blind file/i);
  });

  it("allows only an explicit manual attestation to pass a review-blind verdict", () => {
    expect(
      mergeShipBlockReason(mergeApproval, "approved", ok(), true)
    ).toBeNull();
  });

  it("allows a merge whose flows resolved (not blind)", () => {
    expect(
      mergeShipBlockReason(mergeApproval, "approved", ok({ verdict: "flows-resolved" }))
    ).toBeNull();
  });

  it("allows a no-op merge (nothing changed)", () => {
    expect(
      mergeShipBlockReason(mergeApproval, "approved", ok({ verdict: "no-op" }))
    ).toBeNull();
  });

  it("never blocks a REJECT (only a blind approve is stopped)", () => {
    expect(mergeShipBlockReason(mergeApproval, "rejected", ok())).toBeNull();
  });

  it("never blocks a non-merge approval, even when review is blind", () => {
    expect(
      mergeShipBlockReason({ kind: "policy", jobId: "job-1" }, "approved", ok())
    ).toBeNull();
  });

  it("fails CLOSED when review_diff is degraded", () => {
    const degraded: ReviewDiffResponse = {
      status: "degraded",
      reason: "index missing",
      action: "Run the indexer.",
    };
    const reason = mergeShipBlockReason(mergeApproval, "approved", degraded);
    expect(reason).toMatch(/evidence is unavailable/i);
    expect(reason).toMatch(/index missing/i);
    expect(reason).toMatch(/Run the indexer/);
  });

  it("fails CLOSED when review_diff was never wired (null)", () => {
    expect(mergeShipBlockReason(mergeApproval, "approved", null)).toMatch(
      /evidence is unavailable/i
    );
  });

  it("falls back to a generic reason when the verdict carries no note", () => {
    const reason = mergeShipBlockReason(mergeApproval, "approved", ok({ notes: [] }));
    expect(reason).toMatch(/unindexed or the index is stale/);
  });
});

// ADR-0033 — the same decision, rendered for two audiences.
describe("mergeShipRefusal — the typed ship gate", () => {
  it("names the rule so a client can branch without parsing prose", () => {
    expect(mergeShipRefusal(mergeApproval, "approved", ok())?.rule).toBe(
      "ship.review_blind"
    );
    expect(
      mergeShipRefusal(mergeApproval, "approved", null)?.rule
    ).toBe("ship.review_unavailable");
  });

  it("returns null on every path the gate allows", () => {
    expect(mergeShipRefusal(mergeApproval, "rejected", ok())).toBeNull();
    expect(mergeShipRefusal(mergeApproval, "approved", ok(), true)).toBeNull();
    expect(
      mergeShipRefusal(mergeApproval, "approved", ok({ verdict: "flows-resolved" }))
    ).toBeNull();
    expect(
      mergeShipRefusal({ kind: "ship", jobId: "j" }, "approved", ok())
    ).toBeNull();
  });

  it("carries counts and a lawful next action as structured evidence", () => {
    const refusal = mergeShipRefusal(mergeApproval, "approved", ok())!;
    const labels = refusal.evidence.map((f) => f.label);
    expect(labels).toContain("changedFiles");
    expect(labels).toContain("blindFiles");
    expect(refusal.nextAction?.kind).toBe("operator");
  });

  it("never shows an agent the blind file path the operator sees", () => {
    // The disclosure boundary that makes 'explain' safe: counts are a fact,
    // a blind-file list is a workspace path set.
    const refusal = mergeShipRefusal(mergeApproval, "approved", ok())!;
    const forAgent = renderRefusalLine(refusal, "agent");
    const forOperator = renderRefusalLine(refusal, "operator");
    expect(forOperator).toContain("src/new.ts");
    expect(forAgent).not.toContain("src/new.ts");
    expect(forAgent).toContain("blindFiles=1");
  });
});
