import { describe, expect, it } from "vitest";
import { handoffPacketSchema } from "@muon/protocol";
import {
  buildHandoffPacket,
  renderHandoffPacketMarkdown,
} from "../src/build-handoff-packet.js";

/**
 * P0.3 acceptance proof: a parent agent (any vendor) can continue the work
 * from the typed packet ALONE — no prose body, no transcript — and missing
 * hash/check evidence is visibly degraded, never silently complete.
 */
describe("handoff continuation from the typed packet alone", () => {
  const fixture = {
    laneKey: "codex",
    taskId: "task-cc",
    brief: "Make the rate limiter respect burst windows",
    result: {
      exitCode: 0,
      output: "implemented sliding window",
      errorOutput: "",
      durationMs: 900,
    },
    events: [],
    checks: [
      {
        name: "unit tests",
        command: "npm test",
        outcome: "passed" as const,
        exitCode: 0,
        summary: "210 passed",
      },
      {
        name: "integration",
        command: "npm run e2e",
        outcome: "failed" as const,
        exitCode: 1,
        summary: "burst case flaky",
      },
      {
        name: "lint",
        outcome: "passed" as const,
        summary: "clean",
      },
    ],
    changedFiles: ["src/a.ts", "src/b.ts"],
    diff: { hash: `sha256:${"e".repeat(64)}`, totalBytes: 4321 },
    uncertainties: ["Does the limiter reset on deploy?"],
    unresolvedDecisions: ["Window size 10s vs 30s undecided."],
    recommendedNextAction: "Stabilize the flaky burst integration test.",
    createdAt: "2026-07-16T10:00:00.000Z",
  };

  it("reconstructs files, check outcomes, verification, and next action cross-vendor", () => {
    const packet = buildHandoffPacket(fixture);

    // Simulate the wire: JSON round-trip parsed with the protocol schema only.
    const parsed = handoffPacketSchema.parse(JSON.parse(JSON.stringify(packet)));

    const continuation = {
      files: parsed.changedFiles,
      failingChecks: parsed.checks
        .filter((check) => check.outcome !== "passed")
        .map((check) => check.name),
      verified: parsed.diffVerified && parsed.diffHash !== undefined,
      next: parsed.recommendedNextAction,
      open: [...parsed.uncertainties, ...parsed.unresolvedDecisions],
    };

    expect(continuation).toEqual({
      files: ["src/a.ts", "src/b.ts"],
      failingChecks: ["integration"],
      verified: true,
      next: "Stabilize the flaky burst integration test.",
      open: [
        "Does the limiter reset on deploy?",
        "Window size 10s vs 30s undecided.",
      ],
    });
    expect(parsed.degraded.flag).toBe(false);
  });

  it("visibly degrades when the diff hash evidence is missing", () => {
    const { diff: _omitted, ...withoutDiff } = fixture;
    const packet = buildHandoffPacket(withoutDiff);
    const parsed = handoffPacketSchema.parse(JSON.parse(JSON.stringify(packet)));

    expect(parsed.degraded.flag).toBe(true);
    expect(parsed.degraded.reasons).toContain("no_diff_evidence");
    expect(parsed.diffVerified).toBe(false);
    expect(parsed.diffHash).toBeUndefined();
    expect(renderHandoffPacketMarkdown(packet).startsWith("> ⚠ DEGRADED:")).toBe(
      true
    );
  });
});
