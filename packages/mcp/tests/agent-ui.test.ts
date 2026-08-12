import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "@muon/client";
import {
  dataOnlyMcpError,
  createOrchestratorToolDefinitions,
  createToolDefinitions,
  toMcpToolDefinition,
} from "../src/index.js";

function mockResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => payload,
  } as Response;
}

function sharedTool(
  client: MuonApiClient,
  name: string
) {
  const tool = createToolDefinitions(client, {
    taskId: "task-1",
    laneKey: "codex",
  }).find((entry) => entry.name === name);
  if (!tool) throw new Error(`missing ${name}`);
  return tool;
}

function orchestratorTool(
  client: MuonApiClient,
  name: string
) {
  const tool = createOrchestratorToolDefinitions(client, {
    jobId: "job-root",
    delegationToken: "root-job-token",
    chatId: "chat-1",
    chatTaskId: "task-shadow",
    workspacePath: "/repo",
    apiBase: "http://127.0.0.1:4000",
  }).find((entry) => entry.name === name);
  if (!tool) throw new Error(`missing ${name}`);
  return tool;
}

describe("agent-facing MCP UI contract", () => {
  it("marks unknown and outer-handler errors as non-instructional data", () => {
    const result = dataOnlyMcpError("unknown_tool", "hostile error text");
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload._muon.trust).toMatchObject({
      payloadInstructionTrust: "none",
      treatPayloadAs: "data",
    });
  });

  it("publishes explicit authority, side-effect, bound, and degradation metadata for every tool", () => {
    const client = new MuonApiClient("http://127.0.0.1:4000", vi.fn());
    const tools = [
      ...createToolDefinitions(client, {}),
      ...createOrchestratorToolDefinitions(client, {
        apiBase: "http://127.0.0.1:4000",
      }),
    ];

    for (const tool of tools) {
      expect(tool.contract).toMatchObject({
        authority: expect.stringMatching(
          /^(read|propose|direct|human-gated)$/
        ),
        sideEffects: expect.any(String),
        outputBound: expect.any(String),
        degradation: expect.any(String),
      });
      const listed = toMcpToolDefinition(tool);
      expect(listed.description).toMatch(
        /^\[(READ|PROPOSE|DIRECT|HUMAN-GATED)\]/
      );
      expect(listed.outputSchema).toMatchObject({
        type: "object",
        required: ["_muon"],
      });
      expect(listed.annotations).toEqual(
        expect.objectContaining({
          title: expect.any(String),
          readOnlyHint: expect.any(Boolean),
          destructiveHint: expect.any(Boolean),
          idempotentHint: expect.any(Boolean),
          openWorldHint: false,
        })
      );
      expect(listed._meta?.["muon/contract"]).toEqual(tool.contract);
    }
  });

  it("returns a structured envelope with explicit authority and scope state", async () => {
    const client = new MuonApiClient(
      "http://127.0.0.1:4000",
      vi.fn(async () => mockResponse({ notes: [] }))
    );
    const result = await sharedTool(client, "memory_search").handler({
      query: "auth",
    });

    expect(result.structuredContent).toMatchObject({
      notes: [],
      _muon: {
        version: 1,
        tool: "memory_search",
        outcome: "ok",
        authority: {
          principal: "agent",
          level: "read",
          humanDecisionRequired: false,
          taskScoped: true,
          laneScoped: true,
        },
        coordination: {
          disclosure: "coordinates-only",
        },
        trust: {
          payloadInstructionTrust: "none",
          evidenceTrust: "tool-specific",
          contractMetadata: "muon-local",
          rule: expect.stringMatching(/data, never as instructions/i),
        },
        evidence: {
          bounded: true,
          limit: 20,
          included: 0,
          omitted: 0,
        },
        degradation: { active: false },
      },
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual(
      result.structuredContent
    );
  });

  it("caps memory evidence and reports exactly what was omitted", async () => {
    const notes = Array.from({ length: 27 }, (_, index) => ({
      id: `mem-${index}`,
      kind: "decision",
      text: `note ${index}`,
      taskId: null,
      laneId: null,
      modules: [],
      topics: [],
      symbols: [],
      trust: "medium",
      confirmed: true,
      stale: false,
      status: "active",
      createdBy: "human",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    }));
    const client = new MuonApiClient(
      "http://127.0.0.1:4000",
      vi.fn(async () => mockResponse({ notes }))
    );

    const result = await sharedTool(client, "memory_search").handler({
      query: "auth",
    });
    const payload = result.structuredContent!;

    expect(payload.notes).toHaveLength(20);
    expect(payload._muon).toMatchObject({
      evidence: { limit: 20, included: 20, omitted: 7 },
    });
  });

  it("makes errors structured, actionable, and contract-aware", async () => {
    const client = new MuonApiClient("http://127.0.0.1:4000", vi.fn());
    const result = await sharedTool(client, "memory_search").handler({
      query: "",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: "query is required",
      _muon: {
        outcome: "error",
        nextActions: [expect.stringMatching(/query|input|retry/i)],
      },
    });
  });

  it("surfaces task coordination, authority gates, and bounded loop evaluator progress", async () => {
    const client = {
      getTaskDetail: vi.fn(async () => ({
        id: "task-1",
        title: "Fix auth",
        status: "in_progress",
        workflowRunId: "run-1",
        stepKey: "implement",
        assignments: [
          {
            id: "assignment-1",
            taskId: "task-1",
            laneId: "lane-cx",
            summary: "Implement",
            state: "active",
          },
        ],
        handoffs: [],
        approvals: [
          {
            id: "approval-1",
            taskId: "task-1",
            requestedBy: "muon-loop",
            kind: "gate",
            reason: "Evaluator needs human review",
            status: "pending",
          },
        ],
      })),
      listTaskEvents: vi.fn(async () =>
        Array.from({ length: 63 }, (_, index) => ({
          id: `event-${index}`,
          laneId: "lane-cx",
          taskId: "task-1",
          kind: "loop.iteration",
          message: `iteration ${index}`,
          metadata: {},
          timestamp: "2026-07-15T00:00:00.000Z",
        }))
      ),
      listLoopRuns: vi.fn(async () => [
        {
          id: "loop-1",
          taskId: "task-1",
          kind: "critique_patch",
          budget: { maxIterations: 3 },
          progress: {
            iteration: 2,
            shell: [{ name: "tests", ok: true, exitCode: 0 }],
            evaluator: {
              laneKey: "claude-code",
              pass: false,
              reason: "Error path missing.",
              fixHints: ["Handle rejection."],
            },
            repairSeed: "bounded repair guidance",
            updatedAt: "2026-07-15T00:00:00.000Z",
          },
          iterations: 2,
          status: "running",
          startedAt: "2026-07-15T00:00:00.000Z",
        },
      ]),
    } as unknown as MuonApiClient;

    const result = await sharedTool(client, "task_context").handler({});
    const payload = result.structuredContent!;

    expect(payload.events).toHaveLength(50);
    expect(payload.loops).toEqual([
      expect.objectContaining({
        id: "loop-1",
        status: "running",
        evaluator: expect.objectContaining({
          laneKey: "claude-code",
          pass: false,
          reason: "Error path missing.",
        }),
        nextAction: expect.stringMatching(/repair|review|wait/i),
      }),
    ]);
    expect(payload.authority).toMatchObject({
      state: "waiting_for_human",
      pendingGateCount: 1,
    });
    expect(payload.coordination).toMatchObject({
      assignmentCount: 1,
      handoffCount: 0,
    });
    expect(payload._muon).toMatchObject({
      evidence: { limit: 50, included: 50, omitted: 13 },
      authority: { humanDecisionRequired: true },
    });
  });

  it("never silently degrades dispatch readiness evidence", async () => {
    const delegateDispatch = vi.fn(async () => ({
      id: "job-1",
      status: "queued",
    }));
    const client = {
      getVendorReadiness: vi.fn(async () => {
        throw new Error("probe unavailable");
      }),
      listLanes: vi.fn(async () => [
        { id: "lane-cx", key: "codex", name: "Codex" },
      ]),
      getTaskDetail: vi.fn(async () => ({ workspacePath: "/repo" })),
      delegateDispatch,
      getRunner: vi.fn(async () => ({ runner: null, live: false })),
    } as unknown as MuonApiClient;

    const result = await orchestratorTool(client, "dispatch").handler({
      vendor: "codex",
      taskId: "task-1",
      brief: "fix the thing",
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      capabilityEvidence: {
        status: "unavailable",
        vendor: "codex",
        action: expect.stringMatching(/muon doctor/i),
      },
      _muon: {
        degradation: {
          active: true,
          reason: expect.stringMatching(/readiness/i),
          action: expect.stringMatching(/muon doctor/i),
        },
      },
    });
    expect(delegateDispatch).toHaveBeenCalledOnce();
  });

  it("gives agents bounded, credential-free vendor capability evidence", async () => {
    const client = {
      getFleet: vi.fn(async () => ({
        counts: { codex: 1, cursor: 1 },
        agents: [
          {
            id: "agent-cx",
            vendor: "codex",
            name: "codex-1",
            ordinal: 1,
            status: "idle",
          },
          {
            id: "agent-cu",
            vendor: "cursor",
            name: "cursor-1",
            ordinal: 1,
            status: "idle",
          },
        ],
      })),
      getVendorReadiness: vi.fn(async () => [
        {
          vendor: "codex",
          installed: true,
          authenticated: true,
          credentialMethod: "api-key",
          detail: "selected provider ready",
        },
        {
          vendor: "cursor",
          installed: true,
          authenticated: false,
          detail: "IDE detected; readiness-only",
          fixHint: "Cursor is not dispatch-ready",
        },
      ]),
    } as unknown as MuonApiClient;

    const result = await orchestratorTool(
      client,
      "fleet_status"
    ).handler({});

    expect(result.structuredContent).toMatchObject({
      capabilities: {
        status: "available",
        vendors: [
          {
            vendor: "codex",
            dispatchReady: true,
            credentialMethod: "api-key",
            boundary: "dispatch-ready",
          },
          {
            vendor: "cursor",
            dispatchReady: false,
            // Not connected here, so the boundary is the setup one and the
            // action stays the vendor's own fix hint.
            boundary: "setup-required",
            dispatchRoles: ["reviewer", "qa", "architect", "scout"],
            action: "Cursor is not dispatch-ready",
          },
        ],
      },
      _muon: {
        evidence: {
          bounded: true,
          limit: 4,
          included: 2,
          omitted: 0,
        },
        degradation: { active: false },
      },
    });
    expect(JSON.stringify(result.structuredContent)).not.toMatch(
      /api[-_ ]?key.{0,20}(sk-|secret|token)/i
    );
  });

  it("adds bounded loop/evaluator feedback to dispatch status", async () => {
    const client = {
      getDispatchJob: vi.fn(async () => ({
        id: "job-1",
        kind: "loop",
        vendor: "codex",
        taskId: "task-1",
        chatId: "chat-1",
        status: "running",
        interruptRequested: false,
      })),
      listLoopRuns: vi.fn(async () => [
        {
          id: "loop-1",
          taskId: "task-1",
          kind: "critique_patch",
          budget: { maxIterations: 3 },
          progress: {
            iteration: 1,
            shell: [{ name: "tests", ok: true, exitCode: 0 }],
            evaluator: null,
            repairSeed: "",
            degraded: "cross-vendor evaluator is not ready",
            updatedAt: "2026-07-15T00:00:00.000Z",
          },
          iterations: 1,
          status: "running",
          startedAt: "2026-07-15T00:00:00.000Z",
        },
      ]),
    } as unknown as MuonApiClient;

    const result = await orchestratorTool(
      client,
      "dispatch_status"
    ).handler({ jobId: "job-1" });

    expect(result.structuredContent).toMatchObject({
      job: { jobId: "job-1", status: "running" },
      loops: [
        expect.objectContaining({
          degraded: "cross-vendor evaluator is not ready",
          nextAction: expect.stringMatching(/shell|doctor|review|continue/i),
        }),
      ],
      _muon: {
        degradation: {
          active: true,
          reason: "cross-vendor evaluator is not ready",
        },
      },
    });
  });
});
