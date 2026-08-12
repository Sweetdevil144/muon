import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  createTrajectoryPayload,
  parseTrajectoryBundle,
  replayTrajectory,
  trajectoryDigestInput,
  type TrajectoryBundle,
} from "../src/trajectory.js";

const sha = "a".repeat(64);

describe("governance trajectory", () => {
  it("canonicalizes keys and ledger order for a stable digest input", () => {
    expect(canonicalJson({ z: 1, a: { d: 2, b: 1 } })).toBe(
      '{"a":{"b":1,"d":2},"z":1}'
    );
    const payload = createTrajectoryPayload({
      taskId: "task-1",
      events: [
        {
          id: "e2",
          laneId: "codex",
          taskId: "task-1",
          kind: "task.completed",
          message: "done",
          metadata: {},
          timestamp: "2026-08-01T00:00:02.000Z",
        },
        {
          id: "e1",
          laneId: "codex",
          taskId: "task-1",
          kind: "task.blocked",
          message: "refused",
          metadata: {},
          timestamp: "2026-08-01T00:00:01.000Z",
        },
      ],
      chunks: [
        {
          seq: 9,
          taskId: "task-1",
          laneId: "codex",
          kind: "output",
          content: "later",
          timestamp: "2026-08-01T00:00:03.000Z",
        },
        {
          seq: 4,
          taskId: "task-1",
          laneId: "codex",
          kind: "user.message",
          content: "earlier",
          timestamp: "2026-08-01T00:00:00.000Z",
        },
      ],
    });
    expect(payload.events.map((event) => event.id)).toEqual(["e1", "e2"]);
    expect(payload.chunks.map((chunk) => chunk.seq)).toEqual([4, 9]);
    expect(trajectoryDigestInput(payload)).not.toContain("exportedAt");
  });

  it("replays system records separately from recorded context-window chunks", () => {
    const payload = createTrajectoryPayload({
      taskId: "task-1",
      title: "Gate regression",
      events: [
        {
          id: "e1",
          laneId: "muon",
          taskId: "task-1",
          kind: "task.blocked",
          message: "refused",
          metadata: {},
          timestamp: "2026-08-01T00:00:02.000Z",
          principalId: "human:operator",
          payloadDiff: { status: { before: "pending", after: "rejected" } },
        },
      ],
      chunks: [
        {
          seq: 1,
          taskId: "task-1",
          laneId: "muon-chat",
          kind: "user.message",
          content: "do not widen this",
          timestamp: "2026-08-01T00:00:01.000Z",
        },
      ],
    });
    const bundle: TrajectoryBundle = {
      ...payload,
      exportedAt: "2026-08-01T01:00:00.000Z",
      contentSha256: sha,
    };
    const visited: string[] = [];
    const replay = replayTrajectory(bundle, (step) =>
      visited.push(`${step.recordClass}:${step.kind}`)
    );
    expect(visited).toEqual([
      "context-window-recorded:user.message",
      "system-recorded:task.blocked",
    ]);
    expect(replay).toMatchObject({
      systemEvents: 1,
      contextWindowChunks: 1,
      principalStampedEvents: 1,
      payloadDiffEvents: 1,
      completeness: { context: "muon-recorded-only" },
    });
  });

  it("refuses cross-task records and duplicate stable identifiers", () => {
    const payload = createTrajectoryPayload({
      taskId: "task-1",
      events: [
        {
          id: "e1",
          laneId: "muon",
          taskId: "task-1",
          kind: "task.blocked",
          message: "refused",
          metadata: {},
          timestamp: "2026-08-01T00:00:01.000Z",
        },
      ],
      chunks: [],
    });
    const bundle: TrajectoryBundle = {
      ...payload,
      exportedAt: "2026-08-01T01:00:00.000Z",
      contentSha256: sha,
    };
    expect(() =>
      parseTrajectoryBundle({
        ...bundle,
        events: [{ ...bundle.events[0], taskId: "task-2" }],
      })
    ).toThrow("outside its declared task scope");
    expect(() =>
      parseTrajectoryBundle({
        ...bundle,
        events: [bundle.events[0], bundle.events[0]],
      })
    ).toThrow("duplicate event identifiers");
  });

  it("keeps schema-v1 digests replayable after context evidence was added", () => {
    const legacy = {
      schemaVersion: 1 as const,
      scope: { kind: "task" as const, taskId: "task-1" },
      completeness: {
        events: "complete" as const,
        streams: "complete" as const,
        context: "muon-recorded-only" as const,
      },
      events: [],
      chunks: [],
      exportedAt: "2026-08-01T00:00:00.000Z",
      contentSha256: sha,
    };
    expect(parseTrajectoryBundle(legacy).schemaVersion).toBe(1);
    expect(replayTrajectory(legacy)).toMatchObject({
      contextFrames: 0,
      contextCondensations: 0,
      vendorKnowledgeGaps: 0,
    });
  });

  it("validates MUON condensation summaries at portable UTF-8 byte offsets", () => {
    const frame = (id: string, turnSeq: number, content: string) => ({
      id,
      clientRequestId: `request-${id}`,
      jobId: "job-1",
      taskId: "task-1",
      laneId: "lane-1",
      missionId: "job-1",
      turnSeq,
      source: "loop" as const,
      completeness: "muon_supplied",
      content,
      contentSha256: `sha256:${sha}`,
      charCount: content.length,
      tokenEstimate: Math.ceil(content.length / 4),
      createdAt: `2026-08-01T00:00:0${turnSeq}.000Z`,
      exposures: [],
      delivery: null,
    });
    const payload = createTrajectoryPayload({
      taskId: "task-1",
      events: [],
      chunks: [],
      contextFrames: [
        frame("frame-1", 1, "old context"),
        frame("frame-2", 2, "🙂 exact replayable summary after"),
      ],
      contextCondensations: [
        {
          id: "condensation-1",
          jobId: "job-1",
          taskId: "task-1",
          inputFrameId: "frame-1",
          outputFrameId: "frame-2",
          origin: "muon",
          sourceResponseId: "muon:1",
          summary: "exact replayable summary",
          summaryOffset: 5,
          createdAt: "2026-08-01T00:00:03.000Z",
          members: [
            {
              id: "member-1",
              condensationId: "condensation-1",
              artifactKind: "memory_note",
              artifactId: "note-1",
              createdAt: "2026-08-01T00:00:03.000Z",
            },
          ],
        },
      ],
    });
    const bundle = {
      ...payload,
      exportedAt: "2026-08-01T01:00:00.000Z",
      contentSha256: sha,
    };
    expect(parseTrajectoryBundle(bundle).schemaVersion).toBe(2);
    expect(() =>
      parseTrajectoryBundle({
        ...bundle,
        contextCondensations: [
          { ...bundle.contextCondensations[0], summaryOffset: 4 },
        ],
      })
    ).toThrow("cannot replay its exact output summary");
  });
});
