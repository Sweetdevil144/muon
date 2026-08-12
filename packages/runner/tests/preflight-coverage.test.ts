import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RecordedEvent } from "@muon/client";
import {
  preflightEditEvidencePayload,
  type UnsignedPreflightEditEvidence,
} from "@muon/protocol";
import { evaluateEditPreflightCoverage } from "../src/preflight-coverage.js";

const NONCE = "runner-only-proof";

function event(
  input: Partial<UnsignedPreflightEditEvidence> = {}
): RecordedEvent {
  const unsigned: UnsignedPreflightEditEvidence = {
    version: 1,
    jobId: "job-1",
    target: "changeMe",
    filePath: "src/change.ts",
    risk: "LOW",
    graphCommit: "abc1234",
    headCommit: "abc1234",
    coveredFiles: ["src/change.ts"],
    ...input,
  };
  const proof = createHmac("sha256", NONCE)
    .update(preflightEditEvidencePayload(unsigned))
    .digest("hex");
  return {
    id: "event-1",
    laneId: "codex",
    taskId: "task-1",
    kind: "task.progress",
    message: "pre-edit: verified graph and memory coverage",
    metadata: { preflightEdit: { ...unsigned, proof } },
    timestamp: "2026-07-23T10:00:00.000Z",
  };
}

describe("edit preflight completion coverage", () => {
  it("accepts the union of valid job-scoped signed coverage", () => {
    const result = evaluateEditPreflightCoverage({
      changedFiles: ["src/change.ts", "src/new.ts"],
      events: [
        event(),
        event({
          target: "owner",
          filePath: "src/owner.ts",
          coveredFiles: ["src/owner.ts", "src/new.ts"],
        }),
      ],
      jobId: "job-1",
      nonce: NONCE,
    });

    expect(result).toEqual({
      ok: true,
      changedFiles: ["src/change.ts", "src/new.ts"],
      coveredFiles: ["src/change.ts", "src/new.ts", "src/owner.ts"],
      uncoveredFiles: [],
    });
  });

  it("rejects uncovered files and ignores forged, stale, or cross-job events", () => {
    const forged = event();
    forged.metadata.preflightEdit = {
      ...(forged.metadata.preflightEdit as Record<string, unknown>),
      proof: "0".repeat(64),
    };
    const result = evaluateEditPreflightCoverage({
      changedFiles: ["src/change.ts"],
      events: [
        forged,
        event({ jobId: "job-other" }),
        event({ headCommit: "new-head" }),
      ],
      jobId: "job-1",
      nonce: NONCE,
    });

    expect(result.ok).toBe(false);
    expect(result.uncoveredFiles).toEqual(["src/change.ts"]);
    expect(result.reason).toMatch(/no verified preflight_edit evidence/i);
  });

  it("requires no graph call when the governed worktree has no changes", () => {
    expect(
      evaluateEditPreflightCoverage({
        changedFiles: [],
        events: [],
        jobId: "job-1",
        nonce: NONCE,
      })
    ).toEqual({
      ok: true,
      changedFiles: [],
      coveredFiles: [],
      uncoveredFiles: [],
    });
  });
});
