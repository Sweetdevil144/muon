import { describe, expect, it, vi } from "vitest";
import {
  cleanupQuickstartTasks,
  isQuickstartTask,
  type QuickstartCleanupClient,
} from "../src/quickstart-cleanup.js";
import { QUICKSTART_SAMPLE, QUICKSTART_TASK_MARKER } from "../src/quickstart.js";
import type {
  ApprovalRequest,
  DispatchJobRecord,
  Task,
  TaskStatus,
} from "../src/types.js";

// BUG 1(b): the boot cleanup that retires a quickstart first-task stranded in an
// earlier session — its non-terminal jobs + pending approvals — so it can't be
// re-picked and re-fire approval modals. Deterministic over a fully mocked
// operator client; marker-scoped and idempotent.

function task(id: string, title: string, status: TaskStatus = "backlog"): Task {
  return { id, title, description: "", status, priority: "low" };
}
function job(
  id: string,
  taskId: string,
  status: string,
  interruptRequested = false
): DispatchJobRecord {
  return {
    id,
    kind: "auto",
    vendor: "claude-code",
    taskId,
    brief: "",
    status,
    dispatchedBy: "human:quickstart",
    interruptRequested,
    steerMessages: [],
    createdAt: "2026-07-16T00:00:00.000Z",
  } as DispatchJobRecord;
}
function approval(
  id: string,
  taskId: string,
  status: ApprovalRequest["status"] = "pending"
): ApprovalRequest {
  return { id, taskId, requestedBy: "claude-code", kind: "command", reason: "", status };
}

function fakeClient(seed: {
  tasks: Task[];
  jobs: DispatchJobRecord[];
  approvals: ApprovalRequest[];
}): {
  client: QuickstartCleanupClient;
  interrupted: string[];
  rejected: string[];
  parked: Array<{ taskId: string; status: TaskStatus }>;
} {
  const interrupted: string[] = [];
  const rejected: string[] = [];
  const parked: Array<{ taskId: string; status: TaskStatus }> = [];
  const client: QuickstartCleanupClient = {
    listTasks: vi.fn(async () => seed.tasks),
    listDispatchJobs: vi.fn(async () => seed.jobs),
    listApprovals: vi.fn(async () => seed.approvals),
    interruptDispatchJob: vi.fn(async (jobId: string) => {
      interrupted.push(jobId);
    }),
    resolveApproval: vi.fn(async (input) => {
      rejected.push(input.approvalId);
      return {};
    }),
    updateTaskStatus: vi.fn(async (taskId: string, status: TaskStatus) => {
      parked.push({ taskId, status });
      return task(taskId, "x", status);
    }),
  };
  return { client, interrupted, rejected, parked };
}

describe("isQuickstartTask", () => {
  it("matches the current sample AND an older 'greet helper' sample by the marker", () => {
    expect(isQuickstartTask(QUICKSTART_SAMPLE)).toBe(true);
    expect(
      isQuickstartTask({ title: "MUON quickstart: add a greet() helper + test" })
    ).toBe(true);
    expect(QUICKSTART_SAMPLE.title.startsWith(QUICKSTART_TASK_MARKER)).toBe(true);
  });
  it("never matches unrelated work", () => {
    expect(isQuickstartTask({ title: "Refactor the runner loop" })).toBe(false);
    expect(isQuickstartTask({ title: "Add a MUON quickstart guide to the docs" })).toBe(
      false
    );
  });
});

describe("cleanupQuickstartTasks", () => {
  it("clears a seeded quickstart task + its queued job + pending approval, and parks the task", async () => {
    const { client, interrupted, rejected, parked } = fakeClient({
      // The founder's stuck task carries the OLD title; cleanup still matches it.
      tasks: [task("qs-1", "MUON quickstart: add a greet() helper + test")],
      jobs: [job("job-1", "qs-1", "queued")],
      approvals: [approval("ap-1", "qs-1")],
    });

    const result = await cleanupQuickstartTasks(client);

    expect(interrupted).toEqual(["job-1"]);
    expect(rejected).toEqual(["ap-1"]);
    expect(parked).toEqual([{ taskId: "qs-1", status: "blocked" }]);
    expect(result).toEqual({
      tasks: ["qs-1"],
      jobs: ["job-1"],
      approvals: ["ap-1"],
    });
  });

  it("never touches non-quickstart work", async () => {
    const { client, interrupted, rejected, parked } = fakeClient({
      tasks: [
        task("qs-1", QUICKSTART_SAMPLE.title),
        task("real-1", "Ship the release pipeline", "in_progress"),
      ],
      jobs: [
        job("job-qs", "qs-1", "queued"),
        job("job-real", "real-1", "running"),
      ],
      approvals: [
        approval("ap-qs", "qs-1"),
        approval("ap-real", "real-1"),
      ],
    });

    const result = await cleanupQuickstartTasks(client);

    // Only the quickstart ids are ever acted on.
    expect(interrupted).toEqual(["job-qs"]);
    expect(rejected).toEqual(["ap-qs"]);
    expect(parked).toEqual([{ taskId: "qs-1", status: "blocked" }]);
    expect(result.jobs).not.toContain("job-real");
    expect(result.approvals).not.toContain("ap-real");
    expect(result.tasks).not.toContain("real-1");
  });

  it("is idempotent: a second run over already-cleared work is a no-op", async () => {
    const { client, interrupted, rejected, parked } = fakeClient({
      // Job already interrupted, approval already decided, task already blocked.
      tasks: [task("qs-1", QUICKSTART_SAMPLE.title, "blocked")],
      jobs: [job("job-1", "qs-1", "interrupted", true)],
      approvals: [approval("ap-1", "qs-1", "rejected")],
    });

    const result = await cleanupQuickstartTasks(client);

    expect(interrupted).toEqual([]);
    expect(rejected).toEqual([]);
    expect(parked).toEqual([]);
    expect(result).toEqual({ tasks: [], jobs: [], approvals: [] });
  });

  it("does nothing when there is no quickstart task", async () => {
    const { client } = fakeClient({
      tasks: [task("real-1", "Real work")],
      jobs: [job("job-real", "real-1", "queued")],
      approvals: [approval("ap-real", "real-1")],
    });
    expect(await cleanupQuickstartTasks(client)).toEqual({
      tasks: [],
      jobs: [],
      approvals: [],
    });
  });

  it("degrades to a no-op (never throws) when the brain is unreachable", async () => {
    const client: QuickstartCleanupClient = {
      listTasks: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
      listDispatchJobs: vi.fn(),
      listApprovals: vi.fn(),
      interruptDispatchJob: vi.fn(),
      resolveApproval: vi.fn(),
      updateTaskStatus: vi.fn(),
    };
    await expect(cleanupQuickstartTasks(client)).resolves.toEqual({
      tasks: [],
      jobs: [],
      approvals: [],
    });
  });
});
