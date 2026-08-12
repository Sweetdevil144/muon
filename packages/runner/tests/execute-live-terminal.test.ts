import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyHarnessConfig, type MuonApiClient } from "@muon/client";

const coreMocks = vi.hoisted(() => ({
  startManagedSession: vi.fn(),
  runLaneTask: vi.fn(),
  runLoop: vi.fn(),
}));

vi.mock("@muon/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muon/core")>();
  return {
    ...actual,
    startManagedSession: coreMocks.startManagedSession,
    runLaneTask: coreMocks.runLaneTask,
    runLoop: coreMocks.runLoop,
  };
});
vi.mock("../src/preflight-coverage.js", () => ({
  verifyEditPreflightCoverage: vi.fn(async () => ({
    ok: true,
    changedFiles: [],
    coveredFiles: [],
    uncoveredFiles: [],
  })),
}));

import { executeJob } from "../src/execute.js";
import { jobIdFromTerminalSessionId } from "../src/pty/job-terminal.js";

type Publish = {
  jobId: string;
  sessionId: string;
  frames: { seq: number; data: string }[];
  dropped: number;
};

function client() {
  return {
    listLanes: vi.fn(async () => [{ id: "lane-1", key: "codex" }]),
    getHarness: vi.fn(async () => ({ config: emptyHarnessConfig })),
    getTaskDetail: vi.fn(async () => undefined),
    getLaneProfile: vi.fn(async () => ({ profile: undefined })),
    recallRelatedToTask: vi.fn(async () => []),
    markMemoryUsed: vi.fn(async () => undefined),
    recordStreamChunks: vi.fn(async () => ({ recorded: 0 })),
    recordEvent: vi.fn(async () => undefined),
    addMemoryNoteWithAction: vi.fn(async () => ({ action: "inserted" })),
    updateAgent: vi.fn(async () => undefined),
    getDispatchJob: vi.fn(async () => null),
  } as unknown as MuonApiClient;
}

function job(kind: "oneshot" | "loop" | "session" = "oneshot") {
  return {
    id: "job-live",
    kind,
    vendor: "codex",
    taskId: "task-live",
    brief: "Do the bounded task",
    status: "running",
    interruptRequested: false,
    steerMessages: [],
    dispatchedBy: "orchestrator",
  };
}

beforeEach(() => {
  coreMocks.runLaneTask.mockReset();
  coreMocks.runLoop.mockReset();
  coreMocks.startManagedSession.mockReset();
  coreMocks.startManagedSession.mockRejectedValue(
    new Error("interactive vendor launch must not be reached")
  );
});

describe("executeJob live terminal — attach returns the bytes the job produced", () => {
  it("relays the vendor child's console, stdout and stderr, in order", async () => {
    const published: Publish[] = [];
    coreMocks.runLaneTask.mockImplementation(async (input: {
      onBytes?: (frame: { stream: "stdout" | "stderr"; data: string }) => void;
    }) => {
      input.onBytes?.({ stream: "stdout", data: "compiling…\n" });
      input.onBytes?.({ stream: "stderr", data: "note: 1 warning\n" });
      input.onBytes?.({ stream: "stdout", data: "done\n" });
      return { exitCode: 0, output: "done", errorOutput: "", durationMs: 3 };
    });

    const result = await executeJob(client(), job(), {
      id: "agent-1",
      name: "codex-1",
    }, {
      apiBase: "http://127.0.0.1:4000",
      jobTerminalSink: async (input) => {
        published.push({ ...input, frames: [...input.frames] });
      },
    });

    expect(result.status).toBe("done");
    const text = published.flatMap((b) => b.frames).map((f) => f.data).join("");
    expect(text).toBe("compiling…\nnote: 1 warning\ndone\n");
    expect(jobIdFromTerminalSessionId(published[0]!.sessionId)).toBe("job-live");
    expect(published[0]?.jobId).toBe("job-live");
  });

  it("relays every loop iteration onto the SAME session, not one per iteration", async () => {
    const published: Publish[] = [];
    coreMocks.runLoop.mockImplementation(async (input: {
      onBytes?: (frame: { stream: "stdout" | "stderr"; data: string }) => void;
    }) => {
      input.onBytes?.({ stream: "stdout", data: "iteration 1\n" });
      input.onBytes?.({ stream: "stdout", data: "iteration 2\n" });
      return {
        status: "passed",
        iterations: 2,
        stopReason: "checks passed",
        finalOutput: "ok",
        lastChecks: [],
      };
    });

    const loopJob = {
      ...job("loop"),
      harnessKey: undefined,
      checks: [{ name: "unit", command: "npm", args: ["test"] }],
    };
    await executeJob(client(), loopJob, { id: "agent-1", name: "codex-1" }, {
      apiBase: "http://127.0.0.1:4000",
      jobTerminalSink: async (input) => {
        published.push({ ...input, frames: [...input.frames] });
      },
    });

    const sessions = new Set(published.map((b) => b.sessionId));
    expect(sessions.size).toBe(1);
    expect(jobIdFromTerminalSessionId([...sessions][0]!)).toBe("job-live");
    const text = published.flatMap((b) => b.frames).map((f) => f.data).join("");
    expect(text).toBe("iteration 1\niteration 2\n");
  });

  it("carries no token into the stream even when the vendor printed one", async () => {
    const published: Publish[] = [];
    coreMocks.runLaneTask.mockImplementation(async (input: {
      onBytes?: (frame: { stream: "stdout" | "stderr"; data: string }) => void;
    }) => {
      input.onBytes?.({
        stream: "stderr",
        data: "debug env: MUON_API_TOKEN=muon_live_secret_value\n",
      });
      return { exitCode: 0, output: "ok", errorOutput: "", durationMs: 1 };
    });

    await executeJob(client(), job(), { id: "agent-1", name: "codex-1" }, {
      apiBase: "http://127.0.0.1:4000",
      jobTerminalSink: async (input) => {
        published.push({ ...input, frames: [...input.frames] });
      },
    });

    const text = published.flatMap((b) => b.frames).map((f) => f.data).join("");
    expect(text).not.toContain("muon_live_secret_value");
    expect(text).toContain("[redacted]");
  });
});

describe("executeJob live terminal — never a dependency", () => {
  it("a live-terminal failure leaves the job's outcome untouched", async () => {
    coreMocks.runLaneTask.mockImplementation(async (input: {
      onBytes?: (frame: { stream: "stdout" | "stderr"; data: string }) => void;
    }) => {
      input.onBytes?.({ stream: "stdout", data: "working\n" });
      return {
        exitCode: 0,
        output: "the real answer",
        errorOutput: "",
        durationMs: 4,
      };
    });

    const result = await executeJob(client(), job(), {
      id: "agent-1",
      name: "codex-1",
    }, {
      apiBase: "http://127.0.0.1:4000",
      jobTerminalSink: async () => {
        throw new Error("brain refused the console publish");
      },
    });

    expect(result.status).toBe("done");
    expect(result.result).toBe("the real answer");
    expect(result.packet).toBeDefined();
  });

  it("runs identically with no live terminal at all (no sink, no lease)", async () => {
    const seen: unknown[] = [];
    coreMocks.runLaneTask.mockImplementation(async (input: Record<string, unknown>) => {
      seen.push(input.onBytes);
      return {
        exitCode: 0,
        output: "the real answer",
        errorOutput: "",
        durationMs: 4,
      };
    });

    const result = await executeJob(client(), job(), {
      id: "agent-1",
      name: "codex-1",
    }, { apiBase: "http://127.0.0.1:4000" });

    // The option is ABSENT, not undefined-valued: the adapter seam below is
    // spread-guarded, so today's run is byte-identical.
    expect(seen).toEqual([undefined]);
    expect(result.status).toBe("done");
    expect(result.result).toBe("the real answer");
  });

  it("publishes nothing for a lane with no console, so ptySessionId stays null", async () => {
    const published: Publish[] = [];
    // The interactive branch (claude-code SDK / codex app-server) never calls
    // onBytes: there is no console child to relay. Nothing is published, so the
    // brain never stamps ptySessionId and the viewer falls back honestly.
    coreMocks.startManagedSession.mockResolvedValue({
      sessionId: "vendor-session",
      handle: {
        wait: async () => ({ exitCode: 0, output: "sdk answer" }),
        send: async () => undefined,
        interrupt: async () => undefined,
        vendorSessionId: undefined,
      },
    });

    const result = await executeJob(
      client(),
      { ...job("session"), vendor: "codex" },
      { id: "agent-1", name: "codex-1" },
      {
        apiBase: "http://127.0.0.1:4000",
        steerPollMs: 5,
        jobTerminalSink: async (input) => {
          published.push({ ...input, frames: [...input.frames] });
        },
      }
    );

    expect(result.status).toBe("done");
    expect(published).toEqual([]);
  });
});
