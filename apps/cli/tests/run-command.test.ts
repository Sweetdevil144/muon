import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";
import { registerRunCommand } from "../src/commands/run.js";

describe("muon run persistent dispatch", () => {
  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  it("enqueues and observes plain runs without claiming or launching locally", async () => {
    const enqueueDispatch = vi.fn(async () => ({
      id: "job-1",
      status: "queued",
    }));
    const recordEvent = vi.fn(async (event) => ({ ...event, id: "event-1" }));
    const client = {
      listLanes: vi.fn(async () => [
        {
          id: "lane-codex",
          key: "codex",
          name: "Codex",
          provider: "openai",
          role: "peer",
          status: "available",
        },
      ]),
      getTaskDetail: vi.fn(async () => ({ workspacePath: "/repo" })),
      getVendorReadiness: vi.fn(async () => [
        {
          vendor: "codex",
          installed: true,
          authenticated: true,
          detail: "ready",
        },
      ]),
      getRunner: vi.fn(async () => ({
        live: true,
        runner: {
          id: "runner-1",
          host: "local",
          status: "online",
          lastSeenAt: new Date().toISOString(),
        },
      })),
      assignTask: vi.fn(async () => ({})),
      enqueueDispatch,
      listStreamChunks: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            seq: 1,
            taskId: "task-1",
            laneId: "lane-codex",
            kind: "output",
            content: "working",
            timestamp: "2026-07-16T00:00:00.000Z",
          },
        ]),
      getDispatchJob: vi.fn(async () => ({
        id: "job-1",
        status: "done",
        exitCode: 0,
        result: "done",
        createdAt: "2026-07-16T00:00:00.000Z",
      })),
      recordEvent,
    } as unknown as MuonApiClient;

    const program = new Command();
    program.exitOverride();
    registerRunCommand(program, () => client);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await program.parseAsync([
      "node",
      "muon",
      "run",
      "--lane",
      "codex",
      "--task-id",
      "task-1",
      "--brief",
      "Fix auth",
      "--timeout",
      "45000",
      "--record",
    ]);

    expect(enqueueDispatch).toHaveBeenCalledWith({
      kind: "oneshot",
      vendor: "codex",
      taskId: "task-1",
      brief: "Fix auth",
      maxWallMs: 45_000,
      workspacePath: "/repo",
    });
    expect(client.assignTask).toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith("done");
  });
});
