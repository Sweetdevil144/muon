import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "@muon/client";
import {
  applyWorkflowGateTag,
  budgetRaiseGateTag,
  canonicalCounts,
  CHILD_BRIEF_HEADINGS,
  childBriefSkeleton,
  fleetGateTag,
  fleetVendorIds,
  gateTag,
  missingBriefHeadings,
  vendorsWhere,
} from "@muon/protocol";
import { createOrchestratorToolDefinitions } from "../src/orchestrator-tools.js";

// ADR-0010 Part B moved gate REDEMPTION from the MCP tool to the ROUTE (an
// atomic validate+single-use-consume; the client `consumeApproval` method +
// `/consume` route were removed, review F-3). These tests verify the tool now
// (a) files a gate carrying the structured `gateTag` and (b) on retry FORWARDS
// the approval id to the route (`setFleet(counts, id)` /
// `applyWorkflowRun(runId,"human",id)`), and maps a route 403 to a friendly
// "already used / file a fresh gate" message. The mismatch/foreign/replay
// REJECTIONS themselves are now proven at the route (backend route tests).

function makeClient(overrides: Partial<Record<string, unknown>> = {}) {
  const base = {
    requestApproval: vi.fn(async (input: { reason: string }) => ({
      id: "approval-new",
      reason: input.reason,
      kind: "gate",
      status: "pending",
    })),
    listApprovals: vi.fn(async () => []),
    setFleet: vi.fn(async () => ({ counts: {}, agents: [] })),
    applyWorkflowRun: vi.fn(async () => ({ run: {}, tasks: [] })),
    getDispatchJob: vi.fn(async (jobId: string) => ({
      id: jobId,
      chatId: "chat-1",
    })),
  };
  return { ...base, ...overrides } as unknown as MuonApiClient;
}

function tool(client: MuonApiClient, name: string) {
  const t = createOrchestratorToolDefinitions(client, {
    jobId: "job-root",
    delegationToken: "root-job-token",
    chatId: "chat-1",
    chatTaskId: "task-shadow",
    apiBase: "http://localhost:4000",
  }).find((entry) => entry.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

describe("the superagent's vendor surfaces are registry projections (ADR-0022 C2)", () => {
  it("dispatch.vendor === the public dispatchable set, and never the dev/test seam", () => {
    const vendor = (
      tool(makeClient(), "dispatch").inputSchema as {
        properties?: { vendor?: { enum?: string[] } };
      }
    ).properties?.vendor;
    // The independent expectation, written by hand…
    expect(vendor?.enum).toEqual(["claude-code", "codex", "cursor", "opencode"]);
    // …and the derivation it must equal. Two statements, so a wrong
    // `dispatchable` boolean fails here rather than silently telling the
    // superagent a lane it cannot reach exists (or hiding one it can).
    expect(vendor?.enum).toEqual([
      ...vendorsWhere(
        (entry) => entry.visibility === "public" && entry.authority.dispatchable
      ),
    ]);
    expect(vendor?.enum).not.toContain("fake");
  });

  it("set_fleet.counts names exactly the fleet-sizeable lanes", () => {
    // A resize key the schema omits is a lane the superagent cannot size; a key
    // it invents is a lane the route will reject. Both are the same drift.
    const counts = (
      tool(makeClient(), "set_fleet").inputSchema as {
        properties?: { counts?: { properties?: Record<string, unknown> } };
      }
    ).properties?.counts;
    expect(Object.keys(counts?.properties ?? {})).toEqual([
      ...fleetVendorIds(),
    ]);
  });
});

describe("@muon/protocol gate helpers (filer/redeemer agreement)", () => {
  it("canonicalCounts binds EVERY vendor in the payload, not a hardcoded three", () => {
    // The completeness rule: a count the tag does not mention is a count the
    // human never approved. A vendor the fleet learns later must not ride along
    // unbound inside an approval for the vendors that existed before it.
    expect(canonicalCounts({ "claude-code": 1, opencode: 3 })).toBe(
      "claude-code=1,opencode=3"
    );
    expect(fleetGateTag({ "claude-code": 1 })).not.toBe(
      fleetGateTag({ "claude-code": 1, opencode: 3 })
    );
  });

  it("canonicalCounts: fixed vendor order, omits undefined counts", () => {
    expect(canonicalCounts({ "claude-code": 2, codex: 0, cursor: 0 })).toBe(
      "claude-code=2,codex=0,cursor=0"
    );
    // Input key order does not matter, the vendor order is fixed.
    expect(canonicalCounts({ codex: 1, "claude-code": 3 })).toBe(
      "claude-code=3,codex=1"
    );
    expect(canonicalCounts({ "claude-code": 2 })).toBe("claude-code=2");
  });

  it("gateTag/fleetGateTag/applyWorkflowGateTag build the exact bound tag the route redeems", () => {
    expect(gateTag("set_fleet", "claude-code=2")).toBe(
      "[gate:set_fleet claude-code=2]"
    );
    expect(fleetGateTag({ "claude-code": 2 })).toBe(
      "[gate:set_fleet claude-code=2]"
    );
    expect(applyWorkflowGateTag("run-1")).toBe(
      "[gate:apply_workflow runId=run-1]"
    );
  });
});

describe("orchestrator gate binding (tool files, route redeems)", () => {
  it("binds workflow proposals to the current chat and exact caller capability", async () => {
    const createWorkflowRun = vi.fn(async () => ({
      id: "run-1",
      status: "proposed",
    }));
    const client = makeClient({
      createWorkflowRun,
      suggestLanes: vi.fn(async () => []),
    });

    const result = await tool(client, "propose_workflow").handler({
      request: "Fix the parser and verify it.",
    });

    expect(result.isError).not.toBe(true);
    expect(createWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-1",
        proposedBy: "muon-orchestrator",
      }),
      {
        callerJobId: "job-root",
        delegationToken: "root-job-token",
      }
    );
  });

  it("set_fleet without approvalId FILES a gate carrying the structured gateTag, and does not apply", async () => {
    const requestApproval = vi.fn(async (input: { reason: string }) => ({
      id: "approval-fleet",
      reason: input.reason,
      kind: "gate",
      status: "pending",
    }));
    const setFleet = vi.fn(async () => ({ counts: {}, agents: [] }));
    const client = makeClient({ requestApproval, setFleet });

    const filed = await tool(client, "set_fleet").handler({
      counts: { "claude-code": 2 },
    });
    expect(JSON.parse(filed.content[0]!.text).applied).toBe(false);
    expect(setFleet).not.toHaveBeenCalled();
    // The structured tag is filed so the ROUTE can redeem the exact payload.
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "gate",
        gateTag: fleetGateTag({ "claude-code": 2 }),
      })
    );
  });

  it("set_fleet with approvalId FORWARDS the id to the route (the route is the single consume point)", async () => {
    const setFleet = vi.fn(async () => ({ counts: { "claude-code": 2 }, agents: [] }));
    const client = makeClient({ setFleet });

    const applied = await tool(client, "set_fleet").handler({
      counts: { "claude-code": 2 },
      approvalId: "approval-fleet",
    });
    expect(JSON.parse(applied.content[0]!.text).applied).toBe(true);
    // No client-side consume exists anymore, the route validates+consumes.
    expect(setFleet).toHaveBeenCalledWith({ "claude-code": 2 }, "approval-fleet");
  });

  it("set_fleet maps a route 403 (used/mismatched/unapproved) to a friendly message", async () => {
    const setFleet = vi.fn(async () => {
      throw new Error("403 Forbidden, a used, mismatched, or non-gate approval is rejected");
    });
    const client = makeClient({ setFleet });

    const result = await tool(client, "set_fleet").handler({
      counts: { "claude-code": 2 },
      approvalId: "approval-stale",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("file a fresh gate");
  });

  it("apply_workflow without approvalId FILES a gate carrying the runId gateTag", async () => {
    const requestApproval = vi.fn(async (input: { reason: string }) => ({
      id: "approval-wf",
      reason: input.reason,
      kind: "gate",
      status: "pending",
    }));
    const applyWorkflowRun = vi.fn();
    const client = makeClient({ requestApproval, applyWorkflowRun });

    const filed = await tool(client, "apply_workflow").handler({ runId: "run-1" });
    expect(JSON.parse(filed.content[0]!.text).applied).toBe(false);
    expect(applyWorkflowRun).not.toHaveBeenCalled();
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "gate",
        gateTag: applyWorkflowGateTag("run-1"),
      })
    );
  });

  it("apply_workflow with approvalId FORWARDS the id to the route (the route is the single consume point)", async () => {
    const applyWorkflowRun = vi.fn(async () => ({ run: {}, tasks: [] }));
    const client = makeClient({ applyWorkflowRun });

    const applied = await tool(client, "apply_workflow").handler({
      runId: "run-1",
      approvalId: "approval-wf",
    });
    expect(JSON.parse(applied.content[0]!.text).applied).toBe(true);
    expect(applyWorkflowRun).toHaveBeenCalledWith(
      "run-1",
      "human",
      "approval-wf",
      {
        callerJobId: "job-root",
        delegationToken: "root-job-token",
      }
    );
  });

  it("workflow_status reads only through the current caller capability", async () => {
    const getWorkflowRun = vi.fn(async () => ({
      run: {
        id: "run-1",
        status: "proposed",
        workspacePath: "/repo",
        proposal: { summary: "Scoped plan", steps: [] },
      },
      tasks: [],
    }));
    const client = makeClient({ getWorkflowRun });

    const result = await tool(client, "workflow_status").handler({
      runId: "run-1",
    });

    expect(result.isError).not.toBe(true);
    expect(getWorkflowRun).toHaveBeenCalledWith("run-1", {
      callerJobId: "job-root",
      delegationToken: "root-job-token",
    });
  });

  it("apply_workflow maps a route 403 to a friendly message", async () => {
    const applyWorkflowRun = vi.fn(async () => {
      throw new Error("403 Forbidden, a used, mismatched, or non-gate approval is rejected");
    });
    const client = makeClient({ applyWorkflowRun });

    const result = await tool(client, "apply_workflow").handler({
      runId: "run-1",
      approvalId: "approval-stale",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("file a fresh gate");
  });
});

describe("orchestrator dispatch guards", () => {
  it("refuses loop:true when the harness has no checks", async () => {
    const client = makeClient({
      listLanes: vi.fn(async () => [{ id: "lane-cx", key: "codex", name: "Codex" }]),
      getHarness: vi.fn(async () => ({
        config: {
          checks: [],
          requires: { interactive: false, worktree: false },
          profileOverlay: {},
          preauthorizedTools: [],
          budget: {},
          memorySlice: { topics: [], modules: [], k: 5 },
        },
      })),
    });

    const result = await tool(client, "dispatch").handler({
      vendor: "codex",
      taskId: "task-1",
      brief: "fix the thing",
      harnessKey: "review",
      loop: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("needs a harness with checks");
    // No leak: a refused dispatch enqueues nothing. (The client can no longer
    // claim a fleet seat at all — see the §C absence tests in @muon/client.)
    expect(result.isError).toBe(true);
  });

  it("does not claim an agent when the harness key is unknown (no leak)", async () => {
    const delegateDispatch = vi.fn();
    const client = makeClient({
      listLanes: vi.fn(async () => [{ id: "lane-cx", key: "codex", name: "Codex" }]),
      getHarness: vi.fn(async () => {
        throw new Error("404 Not Found");
      }),
      delegateDispatch,
    });

    const result = await tool(client, "dispatch").handler({
      vendor: "codex",
      taskId: "task-1",
      brief: "fix the thing",
      harnessKey: "does-not-exist",
    });
    expect(result.isError).toBe(true);
    // A bad harness key must fail in chat, never enqueue a doomed job.
    expect(delegateDispatch).not.toHaveBeenCalled();
  });
});

// ── Crew role on dispatch (VISION §2) ────────────────────────────────────────
//
// The tool passes an explicit role through to the route, which is the authority
// on whether the vendor may hold it. The four managed lanes are all reachable;
// what each may DO is bounded by its role, not by this enum.
describe("orchestrator dispatch role passthrough", () => {
  function dispatchClient(delegateDispatch: ReturnType<typeof vi.fn>) {
    return makeClient({
      getVendorReadiness: vi.fn(async () => [
        {
          vendor: "cursor",
          installed: true,
          authenticated: true,
          detail: "cursor-agent connected",
        },
        {
          vendor: "opencode",
          installed: true,
          authenticated: true,
          detail: "logged in (1 stored credential)",
        },
      ]),
      listLanes: vi.fn(async () => [
        { id: "lane-cu", key: "cursor", name: "Cursor" },
        { id: "lane-oc", key: "opencode", name: "OpenCode" },
      ]),
      getTaskDetail: vi.fn(async () => ({ workspacePath: "/repo" })),
      getRunner: vi.fn(async () => ({ runner: null, live: false })),
      delegateDispatch,
    });
  }

  it("forwards an explicit role to the delegate route", async () => {
    const delegateDispatch = vi.fn(async () => ({ id: "job-1", status: "queued" }));
    const result = await tool(dispatchClient(delegateDispatch), "dispatch").handler({
      vendor: "cursor",
      taskId: "task-1",
      brief: "second opinion on the parser diff",
      role: "reviewer",
    });

    expect(result.isError).toBeUndefined();
    expect(delegateDispatch).toHaveBeenCalledWith(
      "job-root",
      expect.objectContaining({ vendor: "cursor", role: "reviewer" }),
      "root-job-token"
    );
  });

  it("omits role entirely when none is named (the route resolves it)", async () => {
    const delegateDispatch = vi.fn(async () => ({ id: "job-1", status: "queued" }));
    await tool(dispatchClient(delegateDispatch), "dispatch").handler({
      vendor: "opencode",
      taskId: "task-1",
      brief: "locate the parser entry point",
    });

    expect(delegateDispatch).toHaveBeenCalledOnce();
    expect(delegateDispatch.mock.calls[0]![1]).not.toHaveProperty("role");
  });

  it("refuses a role outside the taxonomy without enqueuing", async () => {
    const delegateDispatch = vi.fn();
    const result = await tool(dispatchClient(delegateDispatch), "dispatch").handler({
      vendor: "cursor",
      taskId: "task-1",
      brief: "do whatever you want",
      role: "superuser",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("role must be one of");
    expect(delegateDispatch).not.toHaveBeenCalled();
  });

  it("refuses a vendor outside the managed set, and admits all four that are in it", async () => {
    const delegateDispatch = vi.fn();
    const result = await tool(dispatchClient(delegateDispatch), "dispatch").handler({
      vendor: "some-other-cli",
      taskId: "task-1",
      brief: "fix the thing",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(
      "vendor must be one of claude-code|codex|cursor|opencode"
    );
    expect(delegateDispatch).not.toHaveBeenCalled();
  });
});

describe("orchestrator dispatch readiness gate (P2)", () => {
  it("refuses to dispatch to an un-authenticated vendor with the actionable fixHint, no enqueue, no claim", async () => {
    const delegateDispatch = vi.fn();
    const client = makeClient({
      getVendorReadiness: vi.fn(async () => [
        {
          vendor: "codex",
          installed: true,
          authenticated: false,
          detail: "not logged in",
          fixHint: "log into Codex first: `codex login`",
        },
      ]),
      listLanes: vi.fn(async () => [{ id: "lane-cx", key: "codex", name: "Codex" }]),
      delegateDispatch,
    });

    const result = await tool(client, "dispatch").handler({
      vendor: "codex",
      taskId: "task-1",
      brief: "fix the thing",
    });

    expect(result.isError).toBe(true);
    // Actionable: the exact login command, not a cryptic runtime failure.
    expect(result.content[0]!.text).toContain("codex login");
    // Never enqueue a doomed job / never claim an agent.
    expect(delegateDispatch).not.toHaveBeenCalled();
  });

  it("refuses to dispatch to a not-installed vendor with the install fixHint", async () => {
    const delegateDispatch = vi.fn();
    const client = makeClient({
      getVendorReadiness: vi.fn(async () => [
        {
          vendor: "cursor",
          installed: false,
          authenticated: false,
          detail: "Cursor CLI not found",
          fixHint: "install the Cursor agent CLI",
        },
      ]),
      delegateDispatch,
    });

    const result = await tool(client, "dispatch").handler({
      vendor: "cursor",
      taskId: "task-1",
      brief: "fix the thing",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("install the Cursor agent CLI");
    expect(delegateDispatch).not.toHaveBeenCalled();
  });

  it("allows dispatch when the vendor is installed AND authenticated", async () => {
    const delegateDispatch = vi.fn(async () => ({ id: "job-1", status: "queued" }));
    const client = makeClient({
      getVendorReadiness: vi.fn(async () => [
        { vendor: "claude-code", installed: true, authenticated: true, detail: "logged in" },
      ]),
      listLanes: vi.fn(async () => [
        { id: "lane-cc", key: "claude-code", name: "Claude" },
      ]),
      getTaskDetail: vi.fn(async () => ({ workspacePath: "/repo" })),
      delegateDispatch,
      getRunner: vi.fn(async () => ({ runner: { id: "r1" }, live: true })),
    });

    const result = await tool(client, "dispatch").handler({
      vendor: "claude-code",
      taskId: "task-1",
      brief: "implement the widget",
    });

    expect(result.isError).toBeUndefined();
    expect(delegateDispatch).toHaveBeenCalled();
  });

  it("re-probes fresh before blocking, a just-logged-in vendor is allowed to dispatch (F4)", async () => {
    const delegateDispatch = vi.fn(async () => ({ id: "job-1", status: "queued" }));
    // Cached probe says logged out; the fresh (refresh:true) re-probe reflects
    // the just-completed login → dispatch must proceed, not be blocked.
    const getVendorReadiness = vi.fn(async (opts?: { refresh?: boolean }) => [
      {
        vendor: "codex",
        installed: true,
        authenticated: Boolean(opts?.refresh),
        detail: opts?.refresh ? "logged in" : "not logged in",
        fixHint: "log into Codex first: `codex login`",
      },
    ]);
    const client = makeClient({
      getVendorReadiness,
      listLanes: vi.fn(async () => [{ id: "lane-cx", key: "codex", name: "Codex" }]),
      getTaskDetail: vi.fn(async () => ({ workspacePath: "/repo" })),
      delegateDispatch,
      getRunner: vi.fn(async () => ({ runner: { id: "r1" }, live: true })),
    });

    const result = await tool(client, "dispatch").handler({
      vendor: "codex",
      taskId: "task-1",
      brief: "fix the thing",
    });

    expect(getVendorReadiness).toHaveBeenCalledWith({ refresh: true });
    expect(result.isError).toBeUndefined();
    expect(delegateDispatch).toHaveBeenCalled();
  });

  it("degrades gracefully: if the readiness probe is unavailable, it does not block dispatch", async () => {
    const delegateDispatch = vi.fn(async () => ({ id: "job-9", status: "queued" }));
    const client = makeClient({
      // Probe route missing / errors → the gate must not block.
      getVendorReadiness: vi.fn(async () => {
        throw new Error("404 Not Found");
      }),
      listLanes: vi.fn(async () => [
        { id: "lane-cc", key: "claude-code", name: "Claude" },
      ]),
      getTaskDetail: vi.fn(async () => undefined),
      delegateDispatch,
      getRunner: vi.fn(async () => ({ runner: null, live: false })),
    });

    const result = await tool(client, "dispatch").handler({
      vendor: "claude-code",
      taskId: "task-1",
      brief: "implement the widget",
    });

    expect(result.isError).toBeUndefined();
    expect(delegateDispatch).toHaveBeenCalled();
    expect(result.content[0]!.text).toContain("muon doctor");
    expect(result.content[0]!.text).toContain("unavailable");
  });
});

describe("orchestrator async dispatch (R1 persistent runner)", () => {
  it("bounds pre-enqueue admission and proves a stalled tool call created no child", async () => {
    vi.useFakeTimers();
    try {
      const delegateDispatch = vi.fn();
      const client = makeClient({
        getVendorReadiness: vi.fn(async () => []),
        listLanes: vi.fn(
          () => new Promise<never>(() => undefined)
        ),
        delegateDispatch,
      });

      const pending = tool(client, "dispatch").handler({
        vendor: "claude-code",
        taskId: "task-filed-only",
        brief: "implement the widget",
      });
      await vi.advanceTimersByTimeAsync(15_001);
      const result = await pending;

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(
        "dispatch admission timed out during lane lookup"
      );
      expect(result.content[0]!.text).toContain("No child job was created");
      expect(delegateDispatch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an admitted child when only post-enqueue runner observation stalls", async () => {
    vi.useFakeTimers();
    try {
      const delegateDispatch = vi.fn(async () => ({
        id: "job-admitted",
        status: "queued",
      }));
      const client = makeClient({
        getVendorReadiness: vi.fn(async () => []),
        listLanes: vi.fn(async () => [
          { id: "lane-cc", key: "claude-code", name: "Claude" },
        ]),
        getTaskDetail: vi.fn(async () => ({ workspacePath: "/repo" })),
        delegateDispatch,
        getRunner: vi.fn(
          () => new Promise<never>(() => undefined)
        ),
      });

      const pending = tool(client, "dispatch").handler({
        vendor: "claude-code",
        taskId: "task-1",
        brief: "implement the widget",
      });
      await vi.advanceTimersByTimeAsync(2_001);
      const result = await pending;
      const payload = JSON.parse(result.content[0]!.text);

      expect(result.isError).toBeUndefined();
      expect(delegateDispatch).toHaveBeenCalledOnce();
      expect(payload.jobId).toBe("job-admitted");
      expect(payload.runnerObserved).toBe(false);
      expect(payload.coordination.runnerState).toBe("unknown");
      expect(payload.note).toContain("The child job exists");
      expect(payload._muon.nextActions[0]).toContain("do not retry dispatch");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads only the exact same-chat dispatch stream by immutable job id", async () => {
    const listStreamChunks = vi.fn(async () => [
      { seq: 7, kind: "output", content: "working" },
    ]);
    const client = makeClient({ listStreamChunks });

    const result = await tool(client, "read_stream").handler({
      jobId: "job-1",
      afterSeq: 4,
    });

    expect(result.isError).toBeUndefined();
    expect(listStreamChunks).toHaveBeenCalledWith({
      runId: "job-1",
      afterSeq: 4,
      limit: 100,
    });
  });

  it("refuses stream access to an unscoped job while bound to a chat", async () => {
    const listStreamChunks = vi.fn();
    const client = makeClient({
      getDispatchJob: vi.fn(async () => ({
        id: "job-cli",
        chatId: null,
      })),
      listStreamChunks,
    });

    const result = await tool(client, "read_stream").handler({
      jobId: "job-cli",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("outside the current chat");
    expect(listStreamChunks).not.toHaveBeenCalled();
  });

  it("enqueues a queued job (does not run it) and reports whether a runner is live", async () => {
    const delegateDispatch = vi.fn(async () => ({
      id: "job-1",
      status: "queued",
      kind: "auto",
      vendor: "claude-code",
      taskId: "task-1",
      interruptRequested: false,
      steerMessages: [],
      dispatchedBy: "orchestrator",
    }));
    const client = makeClient({
      listLanes: vi.fn(async () => [
        { id: "lane-cc", key: "claude-code", name: "Claude" },
      ]),
      getTaskDetail: vi.fn(async () => ({ workspacePath: "/repo" })),
      delegateDispatch,
      getRunner: vi.fn(async () => ({ runner: { id: "r1" }, live: true })),
    });

    const result = await tool(client, "dispatch").handler({
      vendor: "claude-code",
      taskId: "task-1",
      brief: "implement the widget",
    });

    const payload = JSON.parse(result.content[0]!.text);
    expect(result.isError).toBeUndefined();
    expect(payload.jobId).toBe("job-1");
    expect(payload.status).toBe("queued");
    expect(payload.runnerLive).toBe(true);
    expect(delegateDispatch).toHaveBeenCalledWith(
      "job-root",
      expect.objectContaining({
        kind: "auto",
        vendor: "claude-code",
        taskId: "task-1",
        workspacePath: "/repo",
      }),
      "root-job-token"
    );
  });

  it("warns when no runner is live (job would sit queued)", async () => {
    const client = makeClient({
      listLanes: vi.fn(async () => [
        { id: "lane-cc", key: "claude-code", name: "Claude" },
      ]),
      getTaskDetail: vi.fn(async () => undefined),
      delegateDispatch: vi.fn(async () => ({ id: "job-2", status: "queued" })),
      getRunner: vi.fn(async () => ({ runner: null, live: false })),
    });

    const result = await tool(client, "dispatch").handler({
      vendor: "claude-code",
      taskId: "task-1",
      brief: "implement the widget",
    });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.runnerLive).toBe(false);
    expect(payload.note).toContain("NO runner is live");
  });

  // S0. The tool now reports the WHOLE dispatch contract, not a substring test
  // for two of its twelve headings. `runChatTurn` stays the only place that
  // REFUSES — an externally launched coordinator never sees that chat turn, so
  // the boundary it CAN see has to name what went wrong at the moment it does.
  function dispatchingClient() {
    return makeClient({
      listLanes: vi.fn(async () => [
        { id: "lane-cc", key: "claude-code", name: "Claude" },
      ]),
      getTaskDetail: vi.fn(async () => ({ workspacePath: "/repo" })),
      delegateDispatch: vi.fn(async () => ({ id: "job-1", status: "queued" })),
      getRunner: vi.fn(async () => ({ runner: { id: "r1" }, live: true })),
    });
  }

  it("names every missing heading in the result, and does NOT refuse the dispatch", async () => {
    const result = await tool(dispatchingClient(), "dispatch").handler({
      vendor: "claude-code",
      taskId: "task-1",
      brief: "implement the widget",
    });
    // Reports, never refuses: duplicating `childBriefDeficiency`'s refusal in a
    // second place is how the two-vocabulary bug happened.
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.jobId).toBe("job-1");
    expect(payload.briefContract.satisfied).toBe(false);
    expect(payload.briefContract.missing).toEqual([...CHILD_BRIEF_HEADINGS]);
    // The remedy it hands out is one the verifier itself accepts.
    expect(missingBriefHeadings(payload.briefContract.skeleton)).toEqual([]);
    expect(payload._muon.nextActions).toEqual(
      expect.arrayContaining([expect.stringContaining("declares no ROLE")])
    );
  });

  it("REGRESSION (drift 4): a ten-heading brief is told it missed COORDINATION and FINAL REPORT", async () => {
    // Exactly the brief a coordinator wrote by following the drifted `dispatch`
    // description verbatim. It used to dispatch with no signal at all, and the
    // coordinator learned "the dispatch contract failed" one chat turn later,
    // in a turn an attached session never sees.
    const tenOfTwelve = [
      "ROLE: implementer",
      "OWNED SCOPE: packages/core/**",
      "GOAL: ship the widget",
      "MODE: implement",
      "CONTEXT: the prior decision is docs/adr/0022",
      "GRAPH DISCIPLINE: code_query the flows first",
      "DELIVERABLES: the widget module",
      "CHECKS: npm test -- packages/core",
      "AUTHORITY: no commit without approval",
      "STOP CONDITION: when the checks pass",
    ].join("\n");

    const result = await tool(dispatchingClient(), "dispatch").handler({
      vendor: "claude-code",
      taskId: "task-1",
      brief: tenOfTwelve,
    });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.briefContract.missing).toEqual([
      "COORDINATION",
      "FINAL REPORT",
    ]);
    // What it DID declare, so a near-miss is visible rather than inferred.
    expect(payload.briefContract.declared).toContain("GRAPH DISCIPLINE");
    expect(payload._muon.nextActions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("no COORDINATION, FINAL REPORT"),
      ])
    );
  });

  it("reports the contract satisfied — and coaches nothing — for a compliant brief", async () => {
    const result = await tool(dispatchingClient(), "dispatch").handler({
      vendor: "claude-code",
      taskId: "task-1",
      brief: childBriefSkeleton(),
    });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.briefContract).toEqual({ satisfied: true, missing: [] });
    expect(
      payload._muon.nextActions.some((action: string) =>
        action.includes("dispatch contract")
      )
    ).toBe(false);
  });

  it("steer routes to the job's control queue by jobId (cross-turn)", async () => {
    const steerDispatchJob = vi.fn(async () => undefined);
    const client = makeClient({
      steerDispatchJob,
      getDispatchJob: vi.fn(async () => ({ id: "job-1", chatId: "chat-1" })),
    });
    const result = await tool(client, "steer").handler({
      jobId: "job-1",
      message: "also add tests",
    });
    expect(result.isError).toBeUndefined();
    expect(steerDispatchJob).toHaveBeenCalledWith(
      "job-1",
      "also add tests",
      {
        callerJobId: "job-root",
        delegationToken: "root-job-token",
      }
    );
  });

  it("refuses to steer a job dispatched from another chat", async () => {
    const steerDispatchJob = vi.fn(async () => undefined);
    const client = makeClient({
      steerDispatchJob,
      getDispatchJob: vi.fn(async () => ({ id: "job-9", chatId: "other-chat" })),
    });
    const result = await tool(client, "steer").handler({
      jobId: "job-9",
      message: "hijack",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("outside the current chat");
    expect(steerDispatchJob).not.toHaveBeenCalled();
  });

  it("interrupt flags the job by jobId", async () => {
    const interruptDispatchJob = vi.fn(async () => undefined);
    const client = makeClient({
      interruptDispatchJob,
      getDispatchJob: vi.fn(async () => ({ id: "job-1", chatId: "chat-1" })),
    });
    const interruptTool = tool(client, "interrupt");
    expect(interruptTool.description).toContain(
      "interactive sessions, loops, and one-shot jobs"
    );
    expect(interruptTool.description).not.toContain("not yet honored");
    const result = await interruptTool.handler({ jobId: "job-1" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain(
      "runner propagates cancellation to the active execution"
    );
    expect(interruptDispatchJob).toHaveBeenCalledWith("job-1", {
      callerJobId: "job-root",
      delegationToken: "root-job-token",
    });
  });

  it("dispatch_status returns one job's compact status by jobId", async () => {
    const client = makeClient({
      getDispatchJob: vi.fn(async () => ({
        id: "job-1",
        chatId: "chat-1",
        kind: "auto",
        vendor: "claude-code",
        taskId: "task-1",
        status: "done",
        agentId: "agent-1",
        exitCode: 0,
        interruptRequested: false,
        result: "all green",
      })),
    });
    const result = await tool(client, "dispatch_status").handler({
      jobId: "job-1",
    });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.job.jobId).toBe("job-1");
    expect(payload.job.status).toBe("done");
    expect(payload.job.exitCode).toBe(0);
  });

  it("keeps dispatch_status task filters inside the current chat", async () => {
    const listDispatchJobs = vi.fn(async () => []);
    const client = makeClient({ listDispatchJobs });

    await tool(client, "dispatch_status").handler({ taskId: "task-1" });

    expect(listDispatchJobs).toHaveBeenCalledWith({
      status: undefined,
      taskId: "task-1",
      chatId: "chat-1",
    });
  });

  // ── S9: mission budget visibility + operator raise ──────────────────────────
  const BUDGET = {
    jobId: "job-root",
    capabilityMode: "orchestrator",
    rootWallMs: 1_800_000,
    maxDescendantWallMs: 4_800_000,
    poolMs: 4_800_000,
    reservedMs: 600_000,
    consumedMs: 0,
    remainingMs: 4_200_000,
    deadlineAt: "2026-07-16T00:30:00.000Z",
    childrenIssued: 1,
    maxChildren: 3,
    descendantsIssued: 1,
    maxDescendants: 8,
    depth: 0,
    maxDepth: 3,
    children: [
      {
        jobId: "child-a",
        vendor: "codex",
        status: "running",
        depth: 1,
        reservedMs: 600_000,
        consumedMs: 120_000,
      },
    ],
  };

  it("S9 budget_status returns the mission budget as read-only evidence", async () => {
    const getDispatchBudget = vi.fn(async () => BUDGET);
    const client = makeClient({ getDispatchBudget });
    const result = await tool(client, "budget_status").handler({
      jobId: "job-root",
    });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.budget.remainingMs).toBe(4_200_000);
    expect(payload.budget.children).toHaveLength(1);
    expect(getDispatchBudget).toHaveBeenCalledWith("job-root");
    // Read authority (evidence), never a write.
    expect(payload._muon.contract.authority).toBe("read");
  });

  it("S9 budget_status falls back to the scope jobId when none is passed", async () => {
    const getDispatchBudget = vi.fn(async () => BUDGET);
    const client = makeClient({ getDispatchBudget });
    await tool(client, "budget_status").handler({});
    expect(getDispatchBudget).toHaveBeenCalledWith("job-root");
  });

  it("S9 budget_status flags an exhausted pool with a raise next-action", async () => {
    const getDispatchBudget = vi.fn(async () => ({ ...BUDGET, remainingMs: 0 }));
    const client = makeClient({ getDispatchBudget });
    const result = await tool(client, "budget_status").handler({
      jobId: "job-root",
    });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload._muon.nextActions.join(" ")).toContain("raise_budget");
  });

  it("S9 raise_budget without approvalId FILES a gate carrying the structured tag", async () => {
    const requestApproval = vi.fn(async (input: { reason: string }) => ({
      id: "approval-budget",
      reason: input.reason,
      kind: "gate",
      status: "pending",
    }));
    const raiseDispatchBudget = vi.fn();
    const client = makeClient({ requestApproval, raiseDispatchBudget });

    const filed = await tool(client, "raise_budget").handler({
      jobId: "job-root",
      maxDescendantWallMs: 6_000_000,
    });
    expect(JSON.parse(filed.content[0]!.text).applied).toBe(false);
    expect(raiseDispatchBudget).not.toHaveBeenCalled();
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "gate",
        gateTag: budgetRaiseGateTag("job-root", 6_000_000),
      })
    );
  });

  it("S9 raise_budget with approvalId FORWARDS the id to the route (single consume point)", async () => {
    const raiseDispatchBudget = vi.fn(async () => ({
      ...BUDGET,
      maxDescendantWallMs: 6_000_000,
      poolMs: 6_000_000,
      remainingMs: 5_400_000,
    }));
    const client = makeClient({ raiseDispatchBudget });

    const applied = await tool(client, "raise_budget").handler({
      jobId: "job-root",
      maxDescendantWallMs: 6_000_000,
      approvalId: "approval-budget",
    });
    expect(JSON.parse(applied.content[0]!.text).applied).toBe(true);
    expect(raiseDispatchBudget).toHaveBeenCalledWith("job-root", {
      maxDescendantWallMs: 6_000_000,
      gateApprovalId: "approval-budget",
    });
  });

  it("S9 raise_budget maps a route 403 to a friendly file-a-fresh-gate message", async () => {
    const raiseDispatchBudget = vi.fn(async () => {
      throw new Error("403 Forbidden, a used/mismatched/non-gate approval");
    });
    const client = makeClient({ raiseDispatchBudget });
    const result = await tool(client, "raise_budget").handler({
      jobId: "job-root",
      maxDescendantWallMs: 6_000_000,
      approvalId: "stale",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("file a fresh gate");
  });

  it("S9 raise_budget rejects a non-positive amount without filing anything", async () => {
    const requestApproval = vi.fn();
    const raiseDispatchBudget = vi.fn();
    const client = makeClient({ requestApproval, raiseDispatchBudget });
    const result = await tool(client, "raise_budget").handler({
      jobId: "job-root",
      maxDescendantWallMs: 0,
    });
    expect(result.isError).toBe(true);
    expect(requestApproval).not.toHaveBeenCalled();
    expect(raiseDispatchBudget).not.toHaveBeenCalled();
  });

  // ── S6: per-dispatch model override ─────────────────────────────────────────
  it("S6 passes a model override through to the delegate route", async () => {
    const delegateDispatch = vi.fn(async () => ({ id: "job-1", status: "queued" }));
    const client = makeClient({
      listLanes: vi.fn(async () => [
        { id: "lane-cc", key: "claude-code", name: "Claude" },
      ]),
      getTaskDetail: vi.fn(async () => ({ workspacePath: "/repo" })),
      delegateDispatch,
      getRunner: vi.fn(async () => ({ runner: { id: "r1" }, live: true })),
    });

    const result = await tool(client, "dispatch").handler({
      vendor: "claude-code",
      taskId: "task-1",
      brief: "implement the widget",
      model: "opus",
    });

    expect(result.isError).toBeUndefined();
    expect(delegateDispatch).toHaveBeenCalledWith(
      "job-root",
      expect.objectContaining({ model: "opus" }),
      "root-job-token"
    );
  });

  it("S6 exposes a model parameter on the dispatch tool schema", () => {
    const dispatchTool = createOrchestratorToolDefinitions(makeClient(), {
      jobId: "job-root",
      delegationToken: "root-job-token",
      chatId: "chat-1",
      chatTaskId: "task-shadow",
      apiBase: "http://localhost:4000",
    }).find((entry) => entry.name === "dispatch");
    const props = (
      dispatchTool!.inputSchema as { properties: Record<string, unknown> }
    ).properties;
    expect(props.model).toMatchObject({ type: "string" });
  });

  it("S6 surfaces a route 400 for a refused model as a tool error (no silent pass)", async () => {
    const delegateDispatch = vi.fn(async () => {
      throw new Error(
        "400 Bad Request: model is a guarded value and cannot be passed to the vendor"
      );
    });
    const client = makeClient({
      listLanes: vi.fn(async () => [
        { id: "lane-cc", key: "claude-code", name: "Claude" },
      ]),
      getTaskDetail: vi.fn(async () => ({ workspacePath: "/repo" })),
      delegateDispatch,
      getRunner: vi.fn(async () => ({ runner: { id: "r1" }, live: true })),
    });

    const result = await tool(client, "dispatch").handler({
      vendor: "claude-code",
      taskId: "task-1",
      brief: "implement the widget",
      model: "--strict-mcp-config",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("could not enqueue dispatch");
    expect(result.content[0]!.text).toContain("guarded value");
  });
});

describe("dispatch & create_task descriptions carry the crew + graph mandate", () => {
  it("dispatch defaults to a role-specialized crew and code_query FIRST", () => {
    const desc = tool(makeClient(), "dispatch").description ?? "";
    expect(desc).toMatch(/role-specialized crew/);
    expect(desc).toMatch(/different vendor/);
    expect(desc).toMatch(/code_query FIRST/);
  });
  it("create_task hints one role/scope per task", () => {
    const desc = tool(makeClient(), "create_task").description ?? "";
    expect(desc).toMatch(/one role\/scope per task/);
  });
});

// ── F1: fleet_status must answer "how many can run at once" ──────────────────
describe("fleet_status parallel capacity", () => {
  const FLEET = fleetVendorIds();

  function seatedFleet(seatsByVendor: Record<string, number>) {
    return {
      counts: seatsByVendor,
      agents: Object.entries(seatsByVendor).flatMap(([vendor, seats]) =>
        Array.from({ length: seats }, (_unused, index) => ({
          id: `${vendor}-${index + 1}`,
          vendor,
          name: `${vendor}-${index + 1}`,
          ordinal: index + 1,
          status: "idle",
        }))
      ),
    };
  }

  function fleetClient(seatsByVendor: Record<string, number>) {
    return makeClient({
      getFleet: vi.fn(async () => seatedFleet(seatsByVendor)),
      getVendorReadiness: vi.fn(async () =>
        FLEET.map((vendor) => ({
          vendor,
          installed: true,
          authenticated: true,
          detail: "ready",
        }))
      ),
    });
  }

  it("echoes EVERY seat of a full fleet — the old flat 9 dropped three of twelve", async () => {
    const seats = Object.fromEntries(FLEET.map((vendor) => [vendor, 3]));
    const result = await tool(fleetClient(seats), "fleet_status").handler({});
    const structured = result.structuredContent as Record<string, any>;

    // 4 lanes × 3 seats. A bound narrower than the fleet hides real capacity.
    expect(structured.agents).toHaveLength(FLEET.length * 3);
  });

  it("states the concurrent capacity per vendor, not just the seat total", async () => {
    const seats = Object.fromEntries(FLEET.map((vendor) => [vendor, 3]));
    const result = await tool(fleetClient(seats), "fleet_status").handler({});
    const structured = result.structuredContent as Record<string, any>;

    for (const entry of structured.parallelCapacity) {
      expect(entry.seats).toBe(3);
      expect(entry.idleSeats).toBe(3);
      expect(entry.maxConcurrentChildren).toBe(3);
      expect(entry.serializesAtFullFanout).toBe(false);
    }
  });

  it("WARNS, in nextActions, that a one-seat lane serializes a full fan-out", async () => {
    // The founder's fleet: one dispatchable seat per vendor.
    const seats = Object.fromEntries(FLEET.map((vendor) => [vendor, 1]));
    const result = await tool(fleetClient(seats), "fleet_status").handler({});
    const structured = result.structuredContent as Record<string, any>;

    const claude = structured.parallelCapacity.find(
      (entry: any) => entry.vendor === "claude-code"
    );
    expect(claude).toMatchObject({
      seats: 1,
      maxConcurrentChildren: 1,
      serializesAtFullFanout: true,
    });
    // The coordinator planned a 3-way parallel crew because nothing told it
    // this would queue. Now the tool's own nextActions say so, per vendor.
    const nextActions = (structured._muon as any).nextActions as string[];
    expect(nextActions).toEqual(
      expect.arrayContaining(
        FLEET.map((vendor) =>
          expect.stringContaining(
            `${vendor}: 1 seat(s), so at most 1 of its children run at once`
          )
        )
      )
    );
    expect(nextActions.join(" ")).toMatch(/QUEUES/);
  });

  it("says nothing about serialization once the fleet can honour a full fan-out", async () => {
    const seats = Object.fromEntries(FLEET.map((vendor) => [vendor, 3]));
    const result = await tool(fleetClient(seats), "fleet_status").handler({});
    const structured = result.structuredContent as Record<string, any>;
    const nextActions = (structured._muon as any).nextActions as string[];
    expect(nextActions.join(" ")).not.toMatch(/QUEUES/);
  });
});

// ── F4: the coordinator's view of a worker's report must not be a stub ───────
describe("dispatch_status result bounds", () => {
  const report = `${"r".repeat(5_431)}FINAL VERDICT`;

  function jobClient(result: string) {
    return makeClient({
      getDispatchJob: vi.fn(async (jobId: string) => ({
        id: jobId,
        chatId: "chat-1",
        kind: "oneshot",
        vendor: "claude-code",
        taskId: "task-1",
        status: "done",
        exitCode: 0,
        interruptRequested: false,
        result,
      })),
      listLoopRuns: vi.fn(async () => []),
      listDispatchJobs: vi.fn(async () => [
        {
          id: "job-a",
          chatId: "chat-1",
          kind: "oneshot",
          vendor: "claude-code",
          taskId: "task-1",
          status: "done",
          exitCode: 0,
          interruptRequested: false,
          result,
        },
      ]),
    });
  }

  it("carries a REAL closing report when asked about one job (1 200 chars was a stub)", async () => {
    const result = await tool(jobClient(report), "dispatch_status").handler({
      jobId: "job-a",
    });
    const job = (result.structuredContent as any).job;

    // The founder's lost reports measured 5 431 and 4 910 characters; the old
    // 1 200-char envelope could not carry either.
    expect(job.result).toContain(report);
    expect(job.result).not.toContain("[muon:truncated");
    expect(job.result.endsWith("FINAL VERDICT")).toBe(true);
  });

  it("marks the cut, and keeps the TAIL, when a report really is oversized", async () => {
    const huge = `${"h".repeat(20_000)}THE VERDICT`;
    const result = await tool(jobClient(huge), "dispatch_status").handler({
      jobId: "job-a",
    });
    const job = (result.structuredContent as any).job;

    expect(job.result).toContain("[muon:truncated to the last");
    expect(job.result).toContain("handoff_read");
    expect(job.result.endsWith("THE VERDICT")).toBe(true);
  });

  it("keeps the LIST shape compact — a roster is not twenty reports", async () => {
    const result = await tool(jobClient(report), "dispatch_status").handler({});
    const jobs = (result.structuredContent as any).jobs;

    expect(jobs[0].result).toContain("[muon:truncated to the last 1200 chars");
    expect(jobs[0].result.length).toBeLessThan(2_000);
  });
});
