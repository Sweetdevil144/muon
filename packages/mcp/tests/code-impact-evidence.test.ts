import { describe, expect, it } from "vitest";
import { codeImpactEvidenceFromTool } from "../src/code-impact-evidence.js";

// ── ADR-0089 — the ONE typed seam for code_impact evidence ──────────────────
describe("codeImpactEvidenceFromTool", () => {
  it("parses a valid payload and PRESERVES the freshness tri-state — null stays UNKNOWN, never current", () => {
    const parsed = codeImpactEvidenceFromTool({
      structuredContent: {
        result: {
          risk: "LOW",
          summary: { direct: 2, processes_affected: 1 },
          target: { id: "uid-1", filePath: "src/a.ts", name: "fn" },
          byDepth: { "1": [{ filePath: "src/b.ts", name: "caller" }] },
          extraFutureField: "rides along",
        },
        repo: { graphCommit: "abc", headCommit: "abc", stale: null },
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The tri-state survives typed: null is UNKNOWN. Every gate reads
    // `stale !== false`, so an UNKNOWN index can never pass as current.
    expect(parsed.evidence.repo.stale).toBeNull();
    expect(parsed.evidence.repo.stale !== false).toBe(true);
    // Passthrough: unknown fields ride along rather than being stripped.
    expect(
      (parsed.evidence.result as Record<string, unknown>).extraFutureField
    ).toBe("rides along");
  });

  it("normalizes AT the seam: risk to the four-value vocabulary or null; counts to number or null — never zero for absent", () => {
    const parsed = codeImpactEvidenceFromTool({
      structuredContent: {
        result: {
          risk: "medium",
          summary: { direct: "3", processes_affected: "not-a-number" },
        },
        repo: { stale: false },
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.evidence.result.risk).toBe("MEDIUM");
    expect(parsed.evidence.result.summary?.direct).toBe(3);
    // Absent evidence is null, NEVER zero (the live-brain lesson).
    expect(parsed.evidence.result.summary?.processes_affected).toBeNull();

    // Fabricated-zero guards (review finding): Number("")/false/[] are all
    // 0 — none may become a trusted count.
    const zeros = codeImpactEvidenceFromTool({
      structuredContent: {
        result: {
          risk: "low",
          summary: { direct: "", processes_affected: false },
        },
        repo: { stale: false },
      },
    });
    expect(zeros.ok).toBe(true);
    if (!zeros.ok) return;
    expect(zeros.evidence.result.summary?.direct).toBeNull();
    expect(zeros.evidence.result.summary?.processes_affected).toBeNull();

    const junkRisk = codeImpactEvidenceFromTool({
      structuredContent: {
        result: { risk: "catastrophic" },
        repo: { stale: false },
      },
    });
    expect(junkRisk.ok).toBe(true);
    if (!junkRisk.ok) return;
    expect(junkRisk.evidence.result.risk).toBeNull();
  });

  it("an errored tool result surfaces ITS stated reason; an absent one gets the honest default", () => {
    const errored = codeImpactEvidenceFromTool({
      isError: true,
      structuredContent: { error: "no indexed repository" },
    });
    expect(errored.ok).toBe(false);
    if (errored.ok) return;
    expect(errored.reason).toBe("no indexed repository");

    const absent = codeImpactEvidenceFromTool(undefined);
    expect(absent.ok).toBe(false);
    if (absent.ok) return;
    expect(absent.reason).toContain("unavailable");
  });

  it("a payload the schema cannot read is UNREADABLE evidence — typed refusal, never a partial cast", () => {
    const mangled = codeImpactEvidenceFromTool({
      structuredContent: { result: "not an object", repo: 42 } as never,
    });
    expect(mangled.ok).toBe(false);
    if (mangled.ok) return;
    expect(mangled.reason).toContain("cannot read");
    expect(mangled.reason).toContain("UNKNOWN");
  });
});
