import { describe, expect, it } from "vitest";
import {
  parseWorkerFinalReport,
  parseWorkerMemoryProposals,
} from "../src/worker-final-report.js";

const report = (memory = "- [decision] Keep the ledger authoritative.") => `
GOAL: Close the durable handoff loop.
CHANGED:
- Added parsing.
FAILED: nothing
COMMANDS RUN:
- npm test
CHECKS:
- npm test: passed
CHANGED FILES:
- packages/core/src/worker-final-report.ts
OPEN QUESTIONS:
- Should analytics refresh after compaction?
UNCERTAINTIES:
- Large-corpus thresholds remain uncalibrated.
NEXT ACTION:
- Review and confirm useful memory proposals.
MEMORY PROPOSALS:
${memory}`;

describe("parseWorkerFinalReport", () => {
  it("uses only the last complete report and extracts bounded coordination fields", () => {
    const parsed = parseWorkerFinalReport(
      `${report("- [attempt] Ignore this earlier report.")}\nnoise\n${report()}`
    );

    expect(parsed).toEqual({
      openQuestions: ["Should analytics refresh after compaction?"],
      uncertainties: ["Large-corpus thresholds remain uncalibrated."],
      nextAction: "Review and confirm useful memory proposals.",
      memoryProposals: [
        { kind: "decision", text: "Keep the ledger authoritative." },
      ],
    });
  });

  it("refuses partial or out-of-order prose instead of treating it as a report", () => {
    expect(
      parseWorkerFinalReport(`
GOAL: Looks structured
OPEN QUESTIONS:
- But required sections are absent.
MEMORY PROPOSALS:
- [decision] Do not capture me.
`)
    ).toBeUndefined();
  });

  it("redacts common secret shapes and defaults untyped proposals to attempts", () => {
    const parsed = parseWorkerFinalReport(
      report(`
- API_TOKEN=super-secret-value
- Bearer abcdefghijklmnop
`)
    );

    expect(parsed?.memoryProposals).toEqual([
      { kind: "attempt", text: "API_TOKEN=[redacted]" },
      { kind: "attempt", text: "Bearer [redacted]" },
    ]);
  });

  it("does not turn trailing non-list prose into a memory proposal", () => {
    const parsed = parseWorkerFinalReport(
      `${report()}\nThis trailing renderer diagnostic is not a proposal.`
    );

    expect(parsed?.memoryProposals).toEqual([
      { kind: "decision", text: "Keep the ledger authoritative." },
    ]);
  });
});

describe("parseWorkerMemoryProposals", () => {
  it("recovers an explicit final proposal section from an incomplete report", () => {
    const output = `OPEN QUESTIONS:
- none
MEMORY PROPOSALS:
- [constraint] Keep agent proposals unconfirmed until governed.
- Untyped durable lessons remain attempts.`;

    expect(parseWorkerFinalReport(output)).toBeUndefined();
    expect(parseWorkerMemoryProposals(output)).toEqual([
      {
        kind: "constraint",
        text: "Keep agent proposals unconfirmed until governed.",
      },
      { kind: "attempt", text: "Untyped durable lessons remain attempts." },
    ]);
  });

  it("does not parse arbitrary bullets without the explicit label", () => {
    expect(
      parseWorkerMemoryProposals("- [decision] This is ordinary prose.")
    ).toEqual([]);
  });

  it("redacts fallback secrets and caps the recovered proposal count", () => {
    const proposals = Array.from(
      { length: 12 },
      (_, index) =>
        `- [constraint] API_TOKEN=secret-${index} durable rule ${index}`
    ).join("\n");

    const parsed = parseWorkerMemoryProposals(
      `MEMORY PROPOSALS:\n${proposals}`
    );
    expect(parsed).toHaveLength(10);
    expect(parsed.every((proposal) => !proposal.text.includes("secret-"))).toBe(
      true
    );
    expect(parsed[0]?.text).toContain("[redacted]");
  });
});

describe("feature #9 — an attempt carries the worker's declared outcome", () => {
  const proposals = (memory: string) =>
    parseWorkerFinalReport(report(memory))!.memoryProposals;

  it("extracts an outcome from the bracket form", () => {
    const [proposal] = proposals(
      "- [attempt:abandoned] tried a mutex around the cache; deadlocked under load"
    );
    expect(proposal).toMatchObject({ kind: "attempt", outcome: "abandoned" });
    // The marker must not survive into the stored text.
    expect(proposal!.text).toBe(
      "tried a mutex around the cache; deadlocked under load"
    );
  });

  it("extracts an outcome from the colon form", () => {
    expect(proposals("- attempt:worked: retry with backoff fixed it")[0]).toMatchObject(
      { kind: "attempt", outcome: "worked" }
    );
  });

  it("accepts every outcome in the vocabulary", () => {
    for (const outcome of ["worked", "abandoned", "superseded", "unknown"]) {
      expect(
        proposals(`- [attempt:${outcome}] did a thing`)[0]?.outcome,
        outcome
      ).toBe(outcome);
    }
  });

  it("leaves the outcome ABSENT when the worker did not say", () => {
    // Never inferred. A job can succeed overall while the attempt it describes
    // was abandoned — exactly the case "already tried this?" most needs right,
    // and note this fixture's report says FAILED: nothing.
    const [proposal] = proposals("- [attempt] tried the cache-warming approach");
    expect(proposal!.kind).toBe("attempt");
    expect(proposal!.outcome).toBeUndefined();
  });

  it("ignores an outcome declared on a kind that has no such concept", () => {
    const [proposal] = proposals("- [decision:worked] we chose Postgres");
    expect(proposal!.kind).toBe("decision");
    expect(proposal!.outcome).toBeUndefined();
  });

  it("keeps a proposal whose outcome word is outside the vocabulary", () => {
    const [proposal] = proposals("- [attempt:brilliant] did a thing");
    expect(proposal!.outcome).toBeUndefined();
    expect(proposal!.text).toContain("did a thing");
  });

  it("parses every pre-existing untagged form byte for byte", () => {
    // The suffix is optional everywhere; no existing report changes meaning.
    const parsed = proposals(
      [
        "- [constraint] never widen the gate",
        "- decision: use SQLite",
        "- a bare proposal",
      ].join("\n")
    );
    expect(parsed.map((p) => p.kind)).toEqual([
      "constraint",
      "decision",
      "attempt",
    ]);
    expect(parsed.every((p) => p.outcome === undefined)).toBe(true);
  });
});
