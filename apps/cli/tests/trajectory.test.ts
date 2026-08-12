import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "../src/lib/api-client.js";
import {
  collectTaskTrajectory,
  registerTrajectoryCommands,
  verifyAndReplayTrajectory,
} from "../src/commands/trajectory.js";

function run(argv: string[], client: Partial<MuonApiClient>) {
  const program = new Command();
  program.exitOverride();
  registerTrajectoryCommands(program, () => client as MuonApiClient);
  return program.parseAsync(["node", "muon", ...argv]);
}

function fakeClient(): Partial<MuonApiClient> {
  return {
    getTaskDetail: vi.fn(async () => ({
      id: "task-1",
      title: "Gate regression",
      description: "fixture",
      status: "blocked",
      priority: "high",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:02.000Z",
      assignments: [],
      handoffs: [],
      approvals: [],
    })),
    listTaskEvents: vi.fn(async () => [
      {
        id: "event-1",
        laneId: "muon",
        taskId: "task-1",
        kind: "task.blocked",
        message: "governed action refused",
        metadata: {},
        principalId: "human:operator",
        principalKind: "human",
        requestId: "gate-1",
        payloadDiff: { status: { before: "pending", after: "rejected" } },
        timestamp: "2026-08-01T00:00:02.000Z",
      },
    ]),
    listDispatchJobs: vi.fn(async () => [
      {
        id: "job-1",
        kind: "session",
        vendor: "codex",
        taskId: "task-1",
        brief: "fixture",
        status: "done",
        dispatchedBy: "human:operator",
        interruptRequested: false,
        steerMessages: [],
      },
    ]),
    listJobContext: vi.fn(async () => ({
      frames: [
        {
          id: "frame-1",
          clientRequestId: "request-1",
          jobId: "job-1",
          taskId: "task-1",
          laneId: "lane-codex",
          missionId: "job-1",
          turnSeq: 1,
          source: "dispatch",
          completeness: "muon_supplied",
          content: "do not widen this",
          contentSha256: `sha256:${"b".repeat(64)}`,
          charCount: 17,
          tokenEstimate: 5,
          createdAt: "2026-08-01T00:00:00.500Z",
          exposures: [],
          delivery: {
            id: "delivery-1",
            frameId: "frame-1",
            status: "delivered",
            createdAt: "2026-08-01T00:00:00.600Z",
          },
        },
      ],
      condensations: [
        {
          id: "condensation-1",
          jobId: "job-1",
          taskId: "task-1",
          origin: "vendor_reported",
          sourceResponseId: "codex:item:compact-1",
          createdAt: "2026-08-01T00:00:01.500Z",
          members: [],
        },
      ],
      condensationsTruncated: false,
    })),
    listStreamChunks: vi
      .fn()
      .mockResolvedValueOnce([
        {
          seq: 1,
          taskId: "task-1",
          laneId: "muon-chat",
          kind: "user.message",
          content: "do not widen this",
          timestamp: "2026-08-01T00:00:01.000Z",
        },
      ])
      .mockResolvedValueOnce([]),
  };
}

describe("muon trajectory", () => {
  let dir: string | undefined;

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("saves a digest-bound task trajectory without overwriting an existing file", async () => {
    dir = mkdtempSync(join(tmpdir(), "muon-trajectory-"));
    const file = join(dir, "gate.json");
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    await run(
      ["trajectory", "save", "--task-id", "task-1", "--output", file],
      fakeClient()
    );
    const bundle = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const verified = verifyAndReplayTrajectory(bundle, ["task.blocked"]);
    expect(verified.replay).toMatchObject({
      systemEvents: 1,
      contextWindowChunks: 1,
      principalStampedEvents: 1,
      payloadDiffEvents: 1,
      contextFrames: 1,
      deliveredFrames: 1,
      vendorKnowledgeGaps: 1,
      completeness: { context: "muon-recorded-only" },
    });
    expect(writes.join("")).toContain(
      "saved 1 events, 1 stream chunks, and 1 context frames"
    );

    await run(
      ["trajectory", "save", "--task-id", "task-1", "--output", file],
      fakeClient()
    );
    expect(process.exitCode).toBe(1);
  });

  it("replay rejects a tampered payload and can assert a recorded refusal", async () => {
    dir = mkdtempSync(join(tmpdir(), "muon-trajectory-"));
    const file = join(dir, "gate.json");
    await run(
      ["trajectory", "save", "--task-id", "task-1", "--output", file],
      fakeClient()
    );
    process.exitCode = 0;
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    await run(
      [
        "trajectory",
        "replay",
        "--file",
        file,
        "--expect-event",
        "task.blocked",
      ],
      {}
    );
    expect(process.exitCode).toBe(0);
    expect(out.join("")).toContain("trajectory verified");
    expect(out.join("")).toContain("vendor-hidden context is not reconstructed");

    const tampered = JSON.parse(readFileSync(file, "utf8")) as {
      events: { message: string }[];
    };
    tampered.events[0]!.message = "rewritten after export";
    writeFileSync(file, JSON.stringify(tampered));
    await run(["trajectory", "replay", "--file", file], {});
    expect(process.exitCode).toBe(1);
  });

  it("marks a capped stream export truncated after probing the next row", async () => {
    const client = fakeClient();
    client.listStreamChunks = vi
      .fn()
      .mockResolvedValueOnce([
        {
          seq: 1,
          taskId: "task-1",
          laneId: "muon-chat",
          kind: "output",
          content: "bounded row",
          timestamp: "2026-08-01T00:00:01.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          seq: 2,
          taskId: "task-1",
          laneId: "muon-chat",
          kind: "output",
          content: "probe proves another row exists",
          timestamp: "2026-08-01T00:00:02.000Z",
        },
      ]);
    const bundle = await collectTaskTrajectory({
      client: client as MuonApiClient,
      taskId: "task-1",
      maxChunks: 1,
      exportedAt: "2026-08-01T01:00:00.000Z",
    });
    expect(bundle.chunks).toHaveLength(1);
    expect(bundle.completeness.streams).toBe("truncated");
  });

  it("does not duplicate frames while condensations paginate independently", async () => {
    const client = fakeClient();
    const condensation = (index: number) => ({
      id: `condensation-${index}`,
      jobId: "job-1",
      taskId: "task-1",
      origin: "vendor_reported" as const,
      sourceResponseId: `codex:item:compact-${index}`,
      createdAt: `2026-08-01T00:00:01.${String(index).padStart(3, "0")}Z`,
      members: [],
    });
    const first = await client.listJobContext!("job-1");
    client.listJobContext = vi
      .fn()
      .mockResolvedValueOnce({
        frames: first.frames,
        condensations: Array.from({ length: 500 }, (_, index) =>
          condensation(index)
        ),
        condensationsTruncated: true,
      })
      .mockResolvedValueOnce({
        frames: [],
        condensations: [condensation(500)],
        condensationsTruncated: false,
      });

    const bundle = await collectTaskTrajectory({
      client: client as MuonApiClient,
      taskId: "task-1",
      exportedAt: "2026-08-01T01:00:00.000Z",
    });

    expect(bundle.contextFrames).toHaveLength(1);
    expect(bundle.contextCondensations).toHaveLength(501);
    expect(client.listJobContext).toHaveBeenNthCalledWith(
      2,
      "job-1",
      expect.objectContaining({ afterTurn: 1 })
    );
  });
});
