import { describe, expect, it } from "vitest";
import { impactAgreementCheck } from "../src/memory-ground-impact.js";

// ADR-0063 — the impact-agreement verdict logic, every branch. What these pin:
//   • a HEALTHY graph's not-found is evidence (mismatch); a graph that could
//     not be asked is not evidence of anything (not-checkable) — the 0.5.0
//     rule, applied to the third check;
//   • only the FRESHNESS half of the edit gate applies: HIGH/CRITICAL current
//     risk is a DIFF input, never a refusal;
//   • drift reads as a timeline (claimed → now, at commits), and agreement
//     names the numbers it re-measured.

const CLAIM = {
  v: 1 as const,
  target: "chargeCard",
  module: "src/pay/charge.ts",
  direction: "upstream" as const,
  atCommit: "abc123def456",
  summary: { directCallers: 2, processes: 1, risk: "LOW" as const },
};

const FRESH_REPO = {
  graphCommit: "deadbeef1234",
  headCommit: "deadbeef1234",
  stale: false,
};

function impactPayload(
  result: Record<string, unknown>,
  repo: Record<string, unknown> = FRESH_REPO
) {
  return { isError: false, structuredContent: { result, repo } };
}

const same = (a: string, b: string) => a === b;

describe("impactAgreementCheck", () => {
  it("resolver error → not-checkable (an unreachable graph never testifies)", () => {
    const check = impactAgreementCheck(
      CLAIM,
      { status: "error", detail: "gitnexus spawn failed" },
      undefined,
      same
    );
    expect(check.verdict).toBe("not-checkable");
    expect(check.detail).toContain("could not be checked");
  });

  it("resolver not-found → mismatch (a healthy graph's absence IS evidence)", () => {
    const check = impactAgreementCheck(
      CLAIM,
      { status: "not-found" },
      undefined,
      same
    );
    expect(check.verdict).toBe("mismatch");
    expect(check.detail).toContain("no longer resolves");
    expect(check.detail).toContain(CLAIM.atCommit);
  });

  it("impact tool error or missing evidence → not-checkable", () => {
    for (const impact of [
      undefined,
      { isError: true, structuredContent: { error: "boom" } },
      { isError: false, structuredContent: {} },
    ]) {
      const check = impactAgreementCheck(
        CLAIM,
        { status: "found" },
        impact as never,
        same
      );
      expect(check.verdict).toBe("not-checkable");
    }
  });

  it("stale or unverifiable graph → not-checkable, never a finding", () => {
    for (const repo of [
      { ...FRESH_REPO, stale: true },
      { ...FRESH_REPO, headCommit: "other" },
      { graphCommit: "deadbeef1234", stale: false }, // no headCommit
    ]) {
      const check = impactAgreementCheck(
        CLAIM,
        { status: "found" },
        impactPayload(
          { risk: "LOW", summary: { direct: 2, processes_affected: 1 } },
          repo
        ),
        same
      );
      expect(check.verdict).toBe("not-checkable");
      expect(check.detail).toContain("stale");
    }
  });

  it("incomplete summary → not-checkable", () => {
    const check = impactAgreementCheck(
      CLAIM,
      { status: "found" },
      impactPayload({ risk: "LOW", summary: { direct: "n/a" } }),
      same
    );
    expect(check.verdict).toBe("not-checkable");
    expect(check.detail).toContain("incomplete");
  });

  it("agreement → holds, naming the re-measured numbers", () => {
    const check = impactAgreementCheck(
      CLAIM,
      { status: "found" },
      impactPayload({
        risk: "low",
        summary: { direct: 2, processes_affected: 1 },
      }),
      same
    );
    expect(check.verdict).toBe("holds");
    expect(check.detail).toContain("2 direct caller(s)");
    expect(check.detail).toContain(CLAIM.atCommit);
  });

  it("drift → mismatch as a timeline, per changed field", () => {
    const check = impactAgreementCheck(
      CLAIM,
      { status: "found" },
      impactPayload({
        risk: "HIGH",
        summary: { direct: 5, processes_affected: 1 },
      }),
      same
    );
    expect(check.verdict).toBe("mismatch");
    expect(check.detail).toContain("direct callers 2→5");
    expect(check.detail).toContain("risk LOW→HIGH");
    expect(check.detail).not.toContain("processes 1→");
  });

  it("a HIGH current risk with a HIGH claim simply AGREES — the edit gate's refusal does not apply here", () => {
    const check = impactAgreementCheck(
      { ...CLAIM, summary: { ...CLAIM.summary, risk: "HIGH" } },
      { status: "found" },
      impactPayload({
        risk: "HIGH",
        summary: { direct: 2, processes_affected: 1 },
      }),
      same
    );
    expect(check.verdict).toBe("holds");
  });
});
