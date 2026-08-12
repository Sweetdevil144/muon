import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";

const coreMocks = vi.hoisted(() => ({
  startManagedSession: vi.fn(),
}));

vi.mock("@muon/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muon/core")>();
  return {
    ...actual,
    startManagedSession: coreMocks.startManagedSession,
  };
});

import { registerSessionCommands } from "../src/commands/session.js";

describe("muon session persistent dispatch", () => {
  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  it("enqueues resumable sessions without launching one locally", async () => {
    const enqueueDispatch = vi.fn(async () => ({
      id: "job-session",
      status: "queued",
    }));
    const client = {
      listLanes: vi.fn(async () => [
        {
          id: "lane-claude",
          key: "claude-code",
          name: "Claude",
          provider: "anthropic",
          role: "peer",
          status: "available",
        },
      ]),
      getTaskDetail: vi.fn(async () => ({ workspacePath: "/repo" })),
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
            laneId: "lane-claude",
            kind: "output",
            content: "working",
            timestamp: "2026-07-16T00:00:00.000Z",
          },
        ]),
      getDispatchJob: vi.fn(async () => ({
        id: "job-session",
        status: "done",
        exitCode: 0,
        result: "session complete",
        createdAt: "2026-07-16T00:00:00.000Z",
      })),
    } as unknown as MuonApiClient;

    const program = new Command();
    program.exitOverride();
    registerSessionCommands(program, () => client);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await program.parseAsync([
      "node",
      "muon",
      "session",
      "start",
      "--lane",
      "claude-code",
      "--task-id",
      "task-1",
      "--brief",
      "Continue auth work",
      "--resume",
      "claude-session-42",
      "--approval-timeout",
      "90000",
    ]);

    expect(enqueueDispatch).toHaveBeenCalledWith({
      kind: "session",
      vendor: "claude-code",
      taskId: "task-1",
      brief: "Continue auth work",
      resumeVendorSessionId: "claude-session-42",
      approvalTimeoutMs: 90_000,
      workspacePath: "/repo",
    });
    expect(client.assignTask).toHaveBeenCalled();
    expect(coreMocks.startManagedSession).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith("session complete");
  });
});
