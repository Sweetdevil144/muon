import { describe, expect, it, vi } from "vitest";
import {
  QUICKSTART_SAMPLE,
  QUICKSTART_TASK_MARKER,
  pickQuickstartVendor,
  seedQuickstartTask,
  type QuickstartClient,
} from "../src/quickstart.js";
import type { DispatchJobRecord, Task, VendorReadiness } from "../src/types.js";

// P6, the guided first task. Deterministic: pure vendor pick + a seed helper
// over a fully mocked client (no real dispatch, no vendor CLI).

const ready: VendorReadiness = {
  vendor: "claude-code",
  installed: true,
  authenticated: true,
  detail: "logged in as dev@example.com",
};
const notAuth: VendorReadiness = {
  vendor: "codex",
  installed: true,
  authenticated: false,
  detail: "not logged in",
  fixHint: "log into Codex first: `codex login`",
};
const cursorReady: VendorReadiness = {
  vendor: "cursor",
  installed: true,
  authenticated: true,
  detail: "logged in",
};

function fakeClient(): {
  client: QuickstartClient;
  created: unknown[];
  dispatched: unknown[];
} {
  const created: unknown[] = [];
  const dispatched: unknown[] = [];
  const client: QuickstartClient = {
    createTask: vi.fn(async (input) => {
      created.push(input);
      return { id: "task-1", ...input, status: "backlog" } as unknown as Task;
    }),
    enqueueDispatch: vi.fn(async (input) => {
      dispatched.push(input);
      return { id: "job-1", status: "queued", ...input } as unknown as DispatchJobRecord;
    }),
  };
  return { client, created, dispatched };
}

describe("pickQuickstartVendor", () => {
  it("returns the first ready vendor in onboarding order", () => {
    expect(pickQuickstartVendor([notAuth, ready])).toBe("claude-code");
  });
  it("returns null when nothing is ready", () => {
    expect(pickQuickstartVendor([notAuth])).toBeNull();
    expect(pickQuickstartVendor([cursorReady])).toBeNull();
    expect(pickQuickstartVendor(null)).toBeNull();
    expect(pickQuickstartVendor(undefined)).toBeNull();
  });
});

describe("seedQuickstartTask", () => {
  it("ready vendor → seeds the sample task workspace-scoped + dispatches it", async () => {
    const { client, created, dispatched } = fakeClient();
    const outcome = await seedQuickstartTask(client, {
      workspacePath: "/home/dev/project",
      readiness: [notAuth, ready],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.vendor).toBe("claude-code");
    expect(outcome.task.id).toBe("task-1");
    expect(outcome.job.id).toBe("job-1");

    // The seeded task is the safe additive sample, scoped to the chosen folder.
    expect(created).toEqual([
      {
        title: QUICKSTART_SAMPLE.title,
        description: QUICKSTART_SAMPLE.description,
        priority: "low",
        workspacePath: "/home/dev/project",
      },
    ]);
    // Dispatched to the ready vendor, in the chosen workspace, with the brief,
    // as a ONESHOT under the read-only RESEARCH harness so the first task can
    // never write a file (no spurious approval) — BUG 1.
    expect(dispatched).toEqual([
      {
        kind: "oneshot",
        harnessKey: "research",
        vendor: "claude-code",
        taskId: "task-1",
        brief: QUICKSTART_SAMPLE.brief,
        workspacePath: "/home/dev/project",
        dispatchedBy: "human:quickstart",
      },
    ]);
  });

  it("no vendor ready → routes to onboarding (no dead-end, no task created)", async () => {
    const { client, created, dispatched } = fakeClient();
    const outcome = await seedQuickstartTask(client, {
      workspacePath: "/home/dev/project",
      readiness: [notAuth],
    });
    expect(outcome).toEqual({ ok: false, reason: "no-vendor-ready" });
    // Never seeds/dispatches when it can't run, the caller sends the user to onboarding.
    expect(created).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
  });

  it("the sample brief is strictly READ-ONLY (never writes) and never handles a token", () => {
    // The brief forbids every mutating verb and never handles a credential.
    expect(QUICKSTART_SAMPLE.brief).toMatch(
      /do not\s+create, edit, move, or delete/i
    );
    expect(QUICKSTART_SAMPLE.brief.toLowerCase()).toContain("read-only");
    expect(JSON.stringify(QUICKSTART_SAMPLE)).not.toMatch(/token|secret|bearer|sk-/i);
  });

  it("BUG 1: the sample writes NOTHING — no greet()/muon-hello/.muon-quickstart anywhere", () => {
    // The founder is emphatic: no greet() helper, no muon-hello file, no
    // throwaway folder may be seeded or referenced anywhere in the sample.
    const serialized = JSON.stringify(QUICKSTART_SAMPLE);
    expect(serialized).not.toMatch(/muon-hello/i);
    expect(serialized).not.toMatch(/\.muon-quickstart/i);
    expect(serialized).not.toMatch(/greet\s*\(/i);
    // It reads and reports; it never creates a file.
    expect(QUICKSTART_SAMPLE.brief).not.toMatch(/create a new file/i);
    expect(QUICKSTART_SAMPLE.brief.toLowerCase()).toContain("summarize");
  });

  it("the title carries the stable quickstart marker (so cleanup can match it)", () => {
    expect(QUICKSTART_SAMPLE.title.startsWith(QUICKSTART_TASK_MARKER)).toBe(true);
  });
});
