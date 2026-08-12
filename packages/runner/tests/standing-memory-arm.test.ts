import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";

// ── TODO 4.1: the standing arm rides into every brief ───────────────────────
//
// The runner fetches the workspace's human-confirmed constraint/convention
// canon (no anchor, no query, chat-independent) and prepends it to the brief
// UNDER ITS OWN HEADING, before the task-relevant memory slice. A note that
// rides the standing section must not also spend a slice line (4.2's
// content-dedup, applied across arms). A client without the method degrades to
// an empty arm — the pre-4.1 brief, byte-identical.

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

const CANON = {
  id: "standing-1",
  kind: "constraint",
  text: "Never custody vendor tokens",
  confirmed: true,
  stale: false,
  modules: [],
  topics: [],
  symbols: [],
  trust: "high",
  status: "active",
  scope: "global",
};

/** The same statement under a DIFFERENT id, arriving through the task arm. */
const CANON_CLONE = { ...CANON, id: "task-clone-1" };

const DECISION_CANON = {
  ...CANON,
  id: "standing-decision-1",
  kind: "decision",
  text: "Use flat retrieval; the graph records provenance",
  pinned: true,
};

const TASK_NOTE = {
  id: "task-1",
  kind: "decision",
  text: "This task uses the v2 parser",
  confirmed: true,
  stale: false,
  modules: [],
  topics: [],
  symbols: [],
  trust: "high",
  status: "active",
  scope: "project",
};

function sessionJob(overrides: Record<string, unknown> = {}) {
  const workspace = process.cwd();
  const deadlineAt = new Date(Date.now() + 600_000).toISOString();
  const id = (overrides.id as string | undefined) ?? "job-standing";
  return {
    id,
    kind: "session",
    vendor: "claude-code",
    taskId: "task-standing",
    chatId: "chat-standing",
    brief: "do the task",
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

function fakeClient(options: {
  standing?: unknown[] | "absent";
  taskNotes?: unknown[];
}) {
  const client: Record<string, unknown> = {
    listLanes: vi.fn(async () => [{ id: "lane-1", key: "claude-code" }]),
    getTaskDetail: vi.fn(async () => undefined),
    getLaneProfile: vi.fn(async () => ({ profile: undefined })),
    recallRelatedToTask: vi.fn(async () => options.taskNotes ?? []),
    searchMemory: vi.fn(async () => []),
    markMemoryUsed: vi.fn(async () => undefined),
    updateAgent: vi.fn(async () => ({})),
    drainDispatchSteer: vi.fn(async () => []),
    getDispatchJob: vi.fn(async () => ({ interruptRequested: false })),
    recordStreamChunks: vi.fn(async () => ({ recorded: 0 })),
    updateChat: vi.fn(async () => ({})),
    recordEvent: vi.fn(async () => undefined),
    addMemoryNoteWithAction: vi.fn(async () => ({ action: "inserted" })),
    getMemoryMining: vi.fn(async () => false),
  };
  if (options.standing !== "absent") {
    client.recallStandingMemory = vi.fn(async () => options.standing ?? []);
  }
  return client as unknown as MuonApiClient;
}

async function run(client: MuonApiClient) {
  return executeJob(
    client,
    sessionJob() as never,
    { id: "agent-1", name: "claude-code-1" },
    {
      apiBase: "http://127.0.0.1:4000",
      delegationToken: "root-job-token",
      steerPollMs: 1,
      // The standing arm (like the objective arm) fires ONLY for the
      // capability-bound job client — production always supplies it.
      jobClient: client,
    }
  );
}

function sentBrief(): string {
  const call = coreMocks.startManagedSession.mock.calls.at(-1);
  return String((call?.[1] as { brief?: string })?.brief ?? "");
}

beforeEach(() => {
  coreMocks.startManagedSession.mockReset();
  coreMocks.startManagedSession.mockResolvedValue({
    sessionId: "session-1",
    handle: {
      vendorSessionId: "vendor-session-1",
      send: async () => undefined,
      interrupt: async () => undefined,
      wait: async () => ({ exitCode: 0, output: "done" }),
    },
  });
  coreMocks.runLaneTask.mockReset();
  coreMocks.runLaneTask.mockResolvedValue({ exitCode: 0, output: "{}" });
});

describe("TODO 4.1 — the standing arm in the runner", () => {
  it("prepends the standing canon under its own heading, before the slice", async () => {
    const client = fakeClient({
      standing: [DECISION_CANON, CANON],
      taskNotes: [TASK_NOTE],
    });
    const result = await run(client);
    expect(result.status).toBe("done");
    const brief = sentBrief();
    expect(brief).toContain("Standing workspace memory");
    expect(brief).toContain("Never custody vendor tokens");
    expect(brief).toContain("Use flat retrieval; the graph records provenance");
    expect(brief).toContain("This task uses the v2 parser");
    // Canon before the task-relevant slice.
    expect(brief.indexOf("Standing workspace memory")).toBeLessThan(
      brief.indexOf("Shared memory")
    );
  });

  it("cross-arm dedup: a statement riding the standing section never also spends a slice line", async () => {
    const client = fakeClient({
      standing: [CANON],
      taskNotes: [CANON_CLONE, TASK_NOTE],
    });
    await run(client);
    const brief = sentBrief();
    const occurrences = brief.split("Never custody vendor tokens").length - 1;
    expect(occurrences).toBe(1);
  });

  it("a client WITHOUT the method degrades to the pre-4.1 brief (no crash, no heading)", async () => {
    const client = fakeClient({ standing: "absent", taskNotes: [TASK_NOTE] });
    const result = await run(client);
    expect(result.status).toBe("done");
    const brief = sentBrief();
    expect(brief).not.toContain("Standing workspace memory");
    expect(brief).toContain("This task uses the v2 parser");
  });

  it("a failing standing fetch degrades to an empty arm, never a failed dispatch", async () => {
    const client = fakeClient({ taskNotes: [TASK_NOTE] });
    (client as unknown as Record<string, unknown>).recallStandingMemory = vi.fn(
      async () => {
        throw new Error("brain unreachable");
      }
    );
    const result = await run(client);
    expect(result.status).toBe("done");
    expect(sentBrief()).not.toContain("Standing workspace memory");
  });

  it("standing notes are NOT marked used (policy delivery is not retrieval)", async () => {
    const client = fakeClient({ standing: [CANON], taskNotes: [TASK_NOTE] });
    await run(client);
    const used = (client.markMemoryUsed as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .flat();
    expect(used).not.toContain("standing-1");
    expect(used).toContain("task-1");
  });
});
