import { describe, expect, it, vi } from "vitest";
import type { ContextFrameRecord } from "@muon/client";
import {
  createContextEvidenceRecorder,
  type ContextEvidenceClient,
} from "../src/context-evidence.js";

const frame: ContextFrameRecord = {
  id: "frame-1",
  clientRequestId: "11111111-1111-4111-8111-111111111111",
  jobId: "job-1",
  taskId: "task-1",
  laneId: "lane-1",
  missionId: "job-1",
  turnSeq: 1,
  source: "dispatch",
  completeness: "muon_supplied",
  content: "exact prompt",
  contentSha256: `sha256:${"a".repeat(64)}`,
  charCount: 12,
  tokenEstimate: 3,
  createdAt: "2026-08-01T00:00:00.000Z",
  exposures: [],
  delivery: null,
};

describe("context evidence recorder", () => {
  it("redacts a vendor credential before persisting a failed receipt", async () => {
    const completeContextFrameForLease = vi.fn(async () => frame);
    const client = {
      beginContextFrameForLease: vi.fn(async () => frame),
      completeContextFrameForLease,
      recordContextCondensationForLease: vi.fn(async () => ({}) as never),
    } satisfies ContextEvidenceClient;
    const recorder = createContextEvidenceRecorder({
      client,
      jobId: "job-1",
      lease: { host: "runner-1", leaseToken: `lease-${"b".repeat(58)}` },
    });

    await recorder.failed(
      frame,
      new Error("transport rejected sk-secret123456789 and stopped")
    );

    expect(completeContextFrameForLease).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        failure: "transport rejected [redacted] and stopped",
      })
    );
  });
});
