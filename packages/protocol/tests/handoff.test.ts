import { describe, expect, it } from "vitest";
import {
  HANDOFF_DEGRADATION,
  HANDOFF_PACKET_VERSION,
  handoffPacketSchema,
} from "../src/handoff.js";

const V1_PAYLOAD = {
  taskGoal: "Fix the failing test in backend",
  whatChanged: "Lane 'codex' completed the brief.",
  whatFailed: "Nothing reported failing. Exit code 0.",
  nextLaneRequest: "Review the run result for task 'task-1' and continue.",
  commandsRun: ["codex exec fix it"],
  checksStatus: ["exit_code=0", "run: completed"],
  openQuestions: ["None captured during this run."],
  provenance: {
    lane: "codex",
    createdAt: "2026-07-06T10:00:10.000Z",
  },
};

const VALID_DIFF_HASH = `sha256:${"a".repeat(64)}`;

function fullV2Payload() {
  return {
    ...V1_PAYLOAD,
    schemaVersion: HANDOFF_PACKET_VERSION,
    changedFiles: ["src/a.ts", "src/b.ts"],
    diffHash: VALID_DIFF_HASH,
    diffVerified: true,
    checks: [
      {
        name: "unit tests",
        command: "npm test",
        outcome: "passed",
        exitCode: 0,
        summary: "212 tests green",
      },
      {
        name: "lint",
        outcome: "failed",
        exitCode: 1,
        summary: "2 errors",
      },
    ],
    artifacts: [
      { path: "reports/coverage.html", kind: "report" },
      { path: "dist/bundle.js", kind: "file", hash: VALID_DIFF_HASH },
    ],
    uncertainties: ["Unclear whether the retry path is exercised."],
    unresolvedDecisions: ["Keep or drop the legacy flag?"],
    recommendedNextAction: "Run the integration suite next.",
    memoryProposals: [{ kind: "decision", text: "Retry uses backoff." }],
    degraded: { flag: false, reasons: [] },
  };
}

describe("handoffPacketSchema v2", () => {
  it("parses a pure-v1 payload and applies v2 defaults", () => {
    const parsed = handoffPacketSchema.parse(V1_PAYLOAD);

    expect(parsed.taskGoal).toBe(V1_PAYLOAD.taskGoal);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.changedFiles).toEqual([]);
    expect(parsed.checks).toEqual([]);
    expect(parsed.artifacts).toEqual([]);
    expect(parsed.uncertainties).toEqual([]);
    expect(parsed.unresolvedDecisions).toEqual([]);
    expect(parsed.memoryProposals).toEqual([]);
    expect(parsed.diffVerified).toBe(false);
    expect(parsed.diffHash).toBeUndefined();
    expect(parsed.recommendedNextAction).toBeUndefined();
    expect(parsed.degraded).toEqual({ flag: false, reasons: [] });
  });

  it("keeps parsing v1 rows with long free-text fields (no new bounds on v1 keys)", () => {
    const parsed = handoffPacketSchema.parse({
      ...V1_PAYLOAD,
      whatChanged: "x".repeat(50_000),
      checksStatus: ["y".repeat(10_000)],
    });
    expect(parsed.whatChanged).toHaveLength(50_000);
  });

  it("round-trips a full v2 packet through JSON", () => {
    const parsed = handoffPacketSchema.parse(fullV2Payload());
    const rehydrated = handoffPacketSchema.parse(
      JSON.parse(JSON.stringify(parsed))
    );
    expect(rehydrated).toEqual(parsed);
    expect(rehydrated.schemaVersion).toBe(2);
    expect(rehydrated.checks[0]?.outcome).toBe("passed");
    expect(rehydrated.diffHash).toBe(VALID_DIFF_HASH);
  });

  it("rejects payloads that violate the load-bearing bounds", () => {
    expect(() =>
      handoffPacketSchema.parse({
        ...V1_PAYLOAD,
        changedFiles: Array.from({ length: 201 }, (_, i) => `src/f${i}.ts`),
      })
    ).toThrow();

    expect(() =>
      handoffPacketSchema.parse({
        ...V1_PAYLOAD,
        checks: Array.from({ length: 51 }, (_, i) => ({
          name: `check-${i}`,
          outcome: "passed",
          summary: "",
        })),
      })
    ).toThrow();

    expect(() =>
      handoffPacketSchema.parse({
        ...V1_PAYLOAD,
        checks: [
          { name: "tests", outcome: "passed", summary: "s".repeat(501) },
        ],
      })
    ).toThrow();

    expect(() =>
      handoffPacketSchema.parse({
        ...V1_PAYLOAD,
        diffHash: "sha256:not-hex",
      })
    ).toThrow();

    expect(() =>
      handoffPacketSchema.parse({
        ...V1_PAYLOAD,
        diffHash: "md5:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      })
    ).toThrow();

    expect(() =>
      handoffPacketSchema.parse({
        ...V1_PAYLOAD,
        degraded: {
          flag: true,
          reasons: Array.from({ length: 21 }, (_, i) => `reason-${i}`),
        },
      })
    ).toThrow();
  });

  it("strips unknown keys instead of failing", () => {
    const parsed = handoffPacketSchema.parse({
      ...V1_PAYLOAD,
      totallyUnknownKey: "ignore me",
    });
    expect(parsed).not.toHaveProperty("totallyUnknownKey");
  });

  it("exposes stable degradation reason codes", () => {
    expect(HANDOFF_DEGRADATION.noCheckEvidence).toBe("no_check_evidence");
    expect(HANDOFF_DEGRADATION.noDiffEvidence).toBe("no_diff_evidence");
    expect(HANDOFF_DEGRADATION.checksTruncated).toBe("checks_truncated");
    expect(HANDOFF_DEGRADATION.changedFilesTruncated).toBe(
      "changed_files_truncated"
    );
  });
});
