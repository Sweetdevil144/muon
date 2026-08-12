import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyHarnessConfig, harnessConfigSchema } from "@muon/protocol";
import type { MuonApiClient } from "@muon/client";

// ── TODO 0.4: the harness memory-slice coordinates actually reach the read ───
//
// The defect this locks down: `harness.memorySlice.topics` / `.modules` were
// parsed, stored, editable — and read by NOTHING. A harness author setting
// `topics: ["auth"]` got the unfiltered slice with no error anywhere. The
// runner now compiles the spec into the shared bounded filter grammar and
// sends it on BOTH slice arms; these tests assert the filter is on the wire
// (the server re-validates it there), and that the default harness still
// sends none — byte-identical reads for every existing dispatch.

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

import { executeJob } from "../src/execute.js";

const SLICED_HARNESS = harnessConfigSchema.parse({
  description: "narrowed slice",
  memorySlice: { topics: ["auth"], modules: ["src/db.ts"], k: 5 },
});

/** The filter the runner must compile from SLICED_HARNESS — the union shape. */
const EXPECTED_FILTER = {
  or: [
    { field: "topics", op: "in", value: ["auth"] },
    { field: "modules", op: "in", value: ["src/db.ts"] },
  ],
};

function sessionJob(overrides: Record<string, unknown> = {}) {
  const workspace = process.cwd();
  const deadlineAt = new Date(Date.now() + 600_000).toISOString();
  const id = (overrides.id as string | undefined) ?? "job-slice";
  return {
    id,
    kind: "session",
    vendor: "claude-code",
    taskId: "task-slice",
    chatId: "chat-slice",
    brief: "narrow the memory slice to the harness coordinates",
    workspacePath: workspace,
    capabilityMode: "orchestrator",
    maxDelegationDepth: 3,
    maxChildren: 3,
    maxTotalDescendants: 8,
    maxDelegationIterations: 10,
    delegationDeadline: deadlineAt,
    delegationManifest: {
      version: 1,
      jobId: id,
      workspacePath: workspace,
      maxDepth: 3,
      maxChildrenPerParent: 3,
      maxTotalDescendants: 8,
      maxIterations: 10,
      deadlineAt,
      authority: "orchestrator",
      childAuthority: "work",
      narrowingRequired: true,
    },
    status: "running",
    interruptRequested: false,
    steerMessages: [],
    dispatchedBy: "orchestrator",
    ...overrides,
  };
}

function fakeClient(harness = emptyHarnessConfig) {
  const recallRelatedToTask = vi.fn(async () => []);
  const client = {
    listLanes: vi.fn(async () => [{ id: "lane-1", key: "claude-code" }]),
    getHarness: vi.fn(async () => ({ config: harness })),
    getTaskDetail: vi.fn(async () => undefined),
    getLaneProfile: vi.fn(async () => ({ profile: undefined })),
    recallRelatedToTask,
    markMemoryUsed: vi.fn(async () => undefined),
    updateAgent: vi.fn(async () => ({})),
    drainDispatchSteer: vi.fn(async () => []),
    getDispatchJob: vi.fn(async () => ({ interruptRequested: false })),
    recordStreamChunks: vi.fn(async () => ({ recorded: 0 })),
    updateChat: vi.fn(async () => ({})),
    recordEvent: vi.fn(async () => undefined),
    addMemoryNoteWithAction: vi.fn(async () => ({ action: "inserted" })),
    // Mining off: this file is about the slice READ, not the extractor.
    getMemoryMining: vi.fn(async () => false),
  };
  return { client: client as unknown as MuonApiClient, recallRelatedToTask };
}

async function run(client: MuonApiClient, overrides: Record<string, unknown>) {
  return executeJob(
    client,
    sessionJob(overrides) as never,
    { id: "agent-1", name: "claude-code-1" },
    { apiBase: "http://127.0.0.1:4000", delegationToken: "root-job-token", steerPollMs: 1 }
  );
}

beforeEach(() => {
  coreMocks.startManagedSession.mockReset();
  coreMocks.startManagedSession.mockResolvedValue({
    sessionId: "session-1",
    handle: {
      vendorSessionId: "claude-session-42",
      send: async () => undefined,
      interrupt: async () => undefined,
      wait: async () => ({ exitCode: 0, output: "done" }),
    },
  });
  coreMocks.runLaneTask.mockReset();
  coreMocks.runLaneTask.mockResolvedValue({ exitCode: 0, output: "{}" });
});

describe("TODO 0.4 — harness memory-slice coordinates reach the recall", () => {
  it("a harness with topics/modules sends the compiled union filter", async () => {
    const { client, recallRelatedToTask } = fakeClient(SLICED_HARNESS);
    const result = await run(client, { harnessKey: "sliced" });
    expect(result.status).toBe("done");
    expect(recallRelatedToTask).toHaveBeenCalledWith(
      "task-slice",
      "chat-slice",
      EXPECTED_FILTER
    );
  });

  it("the default harness sends NO filter — existing dispatches read byte-identically", async () => {
    const { client, recallRelatedToTask } = fakeClient();
    const result = await run(client, {});
    expect(result.status).toBe("done");
    expect(recallRelatedToTask).toHaveBeenCalledWith(
      "task-slice",
      "chat-slice",
      undefined
    );
  });
});
