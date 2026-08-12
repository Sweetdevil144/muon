import { describe, expect, it } from "vitest";
import { approvalEvidenceSchema, approvalRiskSchema } from "../src/approval.js";

describe("approvalRiskSchema (round-3 #7 — the UNKNOWN tier)", () => {
  it("carries exactly four tiers, unknown included", () => {
    // Pin the vocabulary: adding a tier is a review conversation, and losing
    // `unknown` would silently send uncomputable risk back to a computed word.
    expect(approvalRiskSchema.options).toEqual([
      "low",
      "medium",
      "high",
      "unknown",
    ]);
  });

  it("accepts unknown and rejects anything outside the vocabulary", () => {
    expect(approvalRiskSchema.safeParse("unknown").success).toBe(true);
    for (const invalid of ["none", "critical", "", "UNKNOWN", "Low"]) {
      expect(approvalRiskSchema.safeParse(invalid).success, invalid).toBe(
        false
      );
    }
  });

  it("evidence carries unknown like any other tier — no special casing", () => {
    const parsed = approvalEvidenceSchema.safeParse({
      action: "mcp__payments__transfer",
      scope: "Tool request in session s-1",
      riskLevel: "unknown",
      impactIfApproved:
        "MUON could not classify this tool. Treat it as able to do anything the session's authority allows.",
    });
    expect(parsed.success).toBe(true);
  });
});
