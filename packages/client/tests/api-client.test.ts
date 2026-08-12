import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "../src/api-client.js";

function mockResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => payload,
  } as Response;
}

describe("MuonApiClient", () => {
  it("fetches and validates the exact-job governed memory projection", async () => {
    const payload = {
      schemaVersion: 1,
      source: "human_confirmed_gate",
      noteCount: 0,
      truncated: false,
      files: [
        {
          path: "README.md",
          content: "read only",
          mode: "0444",
          sha256: "a".repeat(64),
        },
        {
          path: "index.tsv",
          content: "id\n",
          mode: "0444",
          sha256: "b".repeat(64),
        },
      ],
      digest: "c".repeat(64),
    };
    const fetcher = vi.fn().mockResolvedValue(mockResponse(payload));
    const client = new MuonApiClient(
      "http://localhost:4000",
      fetcher,
      "job-token"
    );

    await expect(client.getMemoryDirectorySnapshot()).resolves.toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/memory/directory-snapshot",
      { headers: { Authorization: "Bearer job-token" } }
    );
  });

  it("bounds a hung request instead of hanging forever (no silent hang, Wave 0 charter)", async () => {
    // A backend that accepts the socket but never responds — the awaiting call
    // must SETTLE with a clear timeout error, never block forever (which would
    // silently defeat every caller's own deadline, e.g. the dispatch observer).
    const neverResolves = () => new Promise<Response>(() => {});
    const client = new MuonApiClient(
      "http://localhost:4000",
      neverResolves,
      undefined,
      20
    );
    await expect(client.health()).rejects.toThrow(
      /did not respond within 20ms/
    );
  });

  it("does not truncate a fast request when a timeout is configured", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        status: "ok",
        service: "muon-backend",
        timestamp: "2026-07-06T00:00:00.000Z",
      })
    );
    // A generous timeout must never interfere with a normal (immediate) call.
    const client = new MuonApiClient(
      "http://localhost:4000",
      fetcher,
      undefined,
      50
    );
    await expect(client.health()).resolves.toMatchObject({ status: "ok" });
    // The fetcher call shape is unchanged — no injected signal.
    expect(fetcher).toHaveBeenCalledWith("http://localhost:4000/health", {
      headers: {},
    });
  });

  it("hits health endpoint and parses response", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        status: "ok",
        service: "muon-backend",
        timestamp: "2026-07-06T00:00:00.000Z",
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const result = await client.health();

    expect(fetcher).toHaveBeenCalledWith("http://localhost:4000/health", {
      headers: {},
    });
    expect(result.status).toBe("ok");
    expect(result.service).toBe("muon-backend");
  });

  it("creates task using POST payload", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        task: {
          id: "task-1",
          title: "Build CLI",
          description: "Implement task and approval commands.",
          status: "backlog",
          priority: "high",
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const task = await client.createTask({
      title: "Build CLI",
      description: "Implement task and approval commands.",
      priority: "high",
    });

    expect(fetcher).toHaveBeenCalledWith("http://localhost:4000/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "Build CLI",
        description: "Implement task and approval commands.",
        priority: "high",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(task.id).toBe("task-1");
    expect(task.priority).toBe("high");
  });

  it("sends a JSON body when interrupting a dispatch", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse({ job: {} }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    await client.interruptDispatchJob("job-1");

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/dispatch/job-1/interrupt",
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      }
    );
  });

  it("throws when backend returns non-ok response", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse({}, 500));
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    await expect(client.listLanes()).rejects.toThrow("500 Error");
  });

  it("records a lane event in the backend event log", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        event: {
          id: "event-1",
          laneId: "codex",
          taskId: "task-1",
          kind: "task.started",
          message: "Running codex",
          metadata: { command: "codex" },
          timestamp: "2026-07-06T10:00:00.000Z",
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const event = await client.recordEvent({
      laneId: "codex",
      taskId: "task-1",
      kind: "task.started",
      message: "Running codex",
      metadata: { command: "codex" },
      timestamp: "2026-07-06T10:00:00.000Z",
    });

    expect(fetcher).toHaveBeenCalledWith("http://localhost:4000/api/events", {
      method: "POST",
      body: JSON.stringify({
        laneId: "codex",
        taskId: "task-1",
        kind: "task.started",
        message: "Running codex",
        metadata: { command: "codex" },
        timestamp: "2026-07-06T10:00:00.000Z",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(event.id).toBe("event-1");
  });

  it("claims a stream milestone without returning its content", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({ claimed: true }, 201)
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    await expect(
      client.claimStreamChunk({
        taskId: "chat-1",
        laneId: "muon-chat",
        claimKey: "terminal-job:w1",
        kind: "milestone",
        content: "[event] job w1 terminal",
      })
    ).resolves.toEqual({ claimed: true });

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/streams/claim",
      {
        method: "POST",
        body: JSON.stringify({
          taskId: "chat-1",
          laneId: "muon-chat",
          claimKey: "terminal-job:w1",
          kind: "milestone",
          content: "[event] job w1 terminal",
        }),
        headers: { "Content-Type": "application/json" },
      }
    );
  });

  it("fetches full task detail with relations", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        task: {
          id: "task-1",
          title: "Fix backend",
          description: "Make the API suite green.",
          status: "review",
          priority: "high",
          createdAt: "2026-07-06T09:00:00.000Z",
          updatedAt: "2026-07-06T11:00:00.000Z",
          assignments: [
            {
              id: "assignment-1",
              summary: "muon run: fix",
              state: "queued",
              createdAt: "2026-07-06T09:05:00.000Z",
              completedAt: null,
              lane: {
                id: "lane-1",
                key: "codex",
                name: "Codex",
                provider: "openai",
                role: "peer",
                status: "available",
              },
            },
          ],
          handoffs: [],
          approvals: [
            {
              id: "approval-1",
              requestedBy: "codex",
              kind: "command",
              reason: "muon run gate",
              status: "approved",
              decisionNotes: null,
              createdAt: "2026-07-06T09:01:00.000Z",
              decidedAt: "2026-07-06T09:02:00.000Z",
            },
          ],
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const task = await client.getTaskDetail("task-1");

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/tasks/task-1",
      { headers: {} }
    );
    expect(task.id).toBe("task-1");
    expect(task.assignments[0]?.lane?.name).toBe("Codex");
    expect(task.approvals[0]?.status).toBe("approved");
  });

  it("fetches aggregated coordination metrics", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        metrics: {
          approvals: {
            decided: 2,
            pending: 1,
            averageTurnaroundMs: 120000,
            medianTurnaroundMs: 120000,
          },
          handoffs: {
            total: 2,
            prepSamples: 1,
            averagePrepMs: 30000,
            medianPrepMs: 30000,
          },
          assignments: {
            total: 3,
            duplicateBriefings: 1,
            tasksWithDuplicates: 1,
          },
          tasks: {
            total: 2,
            completed: 1,
            averageCycleMs: 3600000,
            medianCycleMs: null,
          },
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const metrics = await client.getMetrics();

    expect(fetcher).toHaveBeenCalledWith("http://localhost:4000/api/metrics", {
      headers: {},
    });
    expect(metrics.approvals.decided).toBe(2);
    expect(metrics.tasks.medianCycleMs).toBeNull();
  });

  it("lists recorded events for a task", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        events: [
          {
            id: "event-1",
            laneId: "codex",
            taskId: "task-1",
            kind: "task.completed",
            message: "Command completed",
            metadata: { exitCode: 0 },
            timestamp: "2026-07-06T10:00:05.000Z",
            principalId: "agent:codex",
            principalKind: "agent",
            accountablePrincipalId: "human:local-operator",
            requestId: "approval-7",
            payloadDiff: { status: { before: "pending", after: "approved" } },
          },
        ],
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const events = await client.listTaskEvents("task-1");

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/tasks/task-1/events",
      { headers: {} }
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("task.completed");
    expect(events[0]).toMatchObject({
      principalId: "agent:codex",
      principalKind: "agent",
      accountablePrincipalId: "human:local-operator",
      requestId: "approval-7",
      payloadDiff: { status: { before: "pending", after: "approved" } },
    });
  });

  it("preEditContext POSTs the target + blast-radius and parses the fused context", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        target: { module: "src/auth/guard.ts", symbol: "validateUser" },
        blastRadius: {
          modules: ["src/auth/guard.ts", "src/auth/session.ts"],
          depth: 1,
          source: "provided",
        },
        memories: [
          {
            id: "mem-1",
            kind: "decision",
            text: "Auth guard runs before request logging",
            modules: ["src/auth/guard.ts"],
            topics: [],
            trust: "high",
            confirmed: true,
            stale: false,
            status: "active",
            createdBy: "human:carol",
            createdAt: "2026-07-09T00:00:00.000Z",
            updatedAt: "2026-07-09T00:00:00.000Z",
            // Extra ledger fields the backend sends are stripped by the schema.
            validFrom: "2026-07-09T00:00:00.000Z",
            accessCount: 0,
            proximity: 1,
            onTarget: true,
          },
        ],
        warnings: [
          {
            kind: "contradicts",
            noteId: "mem-1",
            relatedNoteId: "mem-9",
            detail: "flagged",
          },
        ],
        pendingProposals: [
          {
            proposalNoteId: "mem-5",
            victimNoteId: "mem-1",
            modules: ["src/auth/guard.ts"],
            detail: "An unconfirmed proposal contests a memory on the edit radius.",
          },
        ],
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const context = await client.preEditContext({
      module: "src/auth/guard.ts",
      symbol: "validateUser",
      blastRadiusModules: ["src/auth/guard.ts", "src/auth/session.ts"],
      blastRadiusDepth: 1,
    });

    expect(fetcher).toHaveBeenCalledWith("http://localhost:4000/api/memory/preedit", {
      method: "POST",
      body: JSON.stringify({
        module: "src/auth/guard.ts",
        symbol: "validateUser",
        blastRadiusModules: ["src/auth/guard.ts", "src/auth/session.ts"],
        blastRadiusDepth: 1,
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(context.blastRadius.source).toBe("provided");
    expect(context.memories).toHaveLength(1);
    expect(context.memories[0]?.onTarget).toBe(true);
    expect(context.memories[0]?.proximity).toBe(1);
    expect(context.warnings[0]?.kind).toBe("contradicts");
    expect(context.pendingProposals[0]?.proposalNoteId).toBe("mem-5");
    // KG-7 + KG-10 (ADR-0014): the activity + duplicate-work channels parse and
    // default to [] when a backend omits them (dense off / pre-KG-10) → today's hero.
    expect(context.activity).toEqual([]);
    expect(context.duplicateWork).toEqual([]);
  });

  it("getMemoryNote GETs a single note by id (the operator-tier note-by-id read incl. text)", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        note: {
          id: "mem-5",
          kind: "attempt",
          text: "Drop idempotency to speed up local charges",
          modules: ["src/pay/charge.ts"],
          topics: [],
          trust: "low",
          confirmed: false,
          stale: false,
          status: "active",
          createdBy: "agent:intruder",
          createdAt: "2026-07-09T00:00:00.000Z",
          updatedAt: "2026-07-09T00:00:00.000Z",
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const note = await client.getMemoryNote("mem-5");

    expect(fetcher).toHaveBeenCalledWith("http://localhost:4000/api/memory/mem-5", {
      headers: {},
    });
    // The human pulls the untrusted proposal's TEXT on demand to adjudicate it.
    expect(note.id).toBe("mem-5");
    expect(note.text).toBe("Drop idempotency to speed up local charges");
    expect(note.confirmed).toBe(false);
  });

  it("scopes an operator note-by-id read to a chat when requested", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        note: {
          id: "mem-5",
          kind: "attempt",
          text: "Scoped proposal",
          modules: [],
          topics: [],
          trust: "low",
          confirmed: false,
          stale: false,
          status: "active",
          createdBy: "agent:codex",
          chatId: "chat-a",
          createdAt: "2026-07-09T00:00:00.000Z",
          updatedAt: "2026-07-09T00:00:00.000Z",
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    await client.getMemoryNote("mem-5", { chatId: "chat-a" });

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/memory/mem-5?chatId=chat-a",
      { headers: {} }
    );
  });

  it("preserves provider readiness provenance while stripping unknown credential fields", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        vendors: [
          {
            vendor: "codex",
            installed: true,
            authenticated: true,
            credentialMethod: "custom-provider",
            detail: "configured with the active Codex provider",
            credentialValue: "azure-secret-must-not-cross-the-wire",
          },
        ],
        anyReady: true,
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const readiness = await client.getVendorReadiness();

    expect(readiness[0]).toMatchObject({
      vendor: "codex",
      authenticated: true,
      credentialMethod: "custom-provider",
    });
    expect(JSON.stringify(readiness)).not.toContain(
      "azure-secret-must-not-cross-the-wire"
    );
  });

  it("accepts readiness payloads from older backends without credential provenance", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        vendors: [
          {
            vendor: "claude-code",
            installed: true,
            authenticated: true,
            detail: "logged in",
          },
        ],
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const readiness = await client.getVendorReadiness({ refresh: true });

    expect(readiness[0]).toMatchObject({
      vendor: "claude-code",
      authenticated: true,
    });
    expect(readiness[0]).not.toHaveProperty("credentialMethod");
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/fleet/readiness?refresh=1",
      { headers: {} }
    );
  });

  it("getFleetReadinessReport keeps vendors, authState, warning, and probe freshness", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        vendors: [
          {
            vendor: "codex",
            installed: true,
            authenticated: false,
            detail: "auth probe could not run (timed out)",
            fixHint: "log into Codex first: `codex login`",
            authState: "unknown",
            credentialValue: "must-be-stripped-off-the-wire",
          },
        ],
        anyReady: false,
        warning: "No vendor is ready, configure or sign in to at least one installed agent before dispatching.",
        generatedAt: "2026-07-16T11:59:58.000Z",
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const report = await client.getFleetReadinessReport();

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/fleet/readiness",
      { headers: {} }
    );
    expect(report.vendors[0]).toMatchObject({
      vendor: "codex",
      authenticated: false,
      authState: "unknown",
    });
    expect(report.anyReady).toBe(false);
    expect(report.warning).toMatch(/No vendor is ready/);
    expect(report.generatedAt).toBe("2026-07-16T11:59:58.000Z");
    // Unknown credential-shaped fields never survive parsing.
    expect(JSON.stringify(report)).not.toContain(
      "must-be-stripped-off-the-wire"
    );
  });

  it("getFleetReadinessReport accepts old-backend payloads without authState or generatedAt", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        vendors: [
          {
            vendor: "claude-code",
            installed: true,
            authenticated: true,
            detail: "logged in",
          },
        ],
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const report = await client.getFleetReadinessReport({ refresh: true });

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/fleet/readiness?refresh=1",
      { headers: {} }
    );
    expect(report.vendors[0]).toMatchObject({
      vendor: "claude-code",
      authenticated: true,
    });
    expect(report.vendors[0]).not.toHaveProperty("authState");
    expect(report.generatedAt).toBeUndefined();
  });

  it("getVendorReadiness still returns the vendor rows (delegates to the report)", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        vendors: [
          {
            vendor: "codex",
            installed: true,
            authenticated: true,
            credentialMethod: "custom-provider",
            detail: "configured with the active Codex provider",
            authState: "confirmed",
          },
        ],
        anyReady: true,
        generatedAt: "2026-07-16T11:59:58.000Z",
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const readiness = await client.getVendorReadiness();

    expect(readiness).toHaveLength(1);
    expect(readiness[0]).toMatchObject({
      vendor: "codex",
      authenticated: true,
      credentialMethod: "custom-provider",
      authState: "confirmed",
    });
  });

  // ---- P0.3 typed handoff packets ----

  const V2_PACKET = {
    taskGoal: "Fix the parser crash",
    whatChanged: "Lane 'codex' completed the step.",
    whatFailed: "Nothing reported failing.",
    nextLaneRequest: "Review the run result and continue.",
    commandsRun: ["(command not captured)"],
    checksStatus: ["run: completed"],
    openQuestions: [],
    provenance: { lane: "codex", createdAt: "2026-07-16T00:00:00.000Z" },
    schemaVersion: 2,
    changedFiles: ["src/a.ts"],
    diffHash: `sha256:${"a".repeat(64)}`,
    diffVerified: true,
    checks: [
      { name: "tests", outcome: "passed" as const, summary: "12 passed" },
    ],
    artifacts: [],
    uncertainties: [],
    unresolvedDecisions: [],
    recommendedNextAction: "Continue in the review lane.",
    memoryProposals: [],
    degraded: { flag: false, reasons: [] },
  };

  it("createHandoff forwards the typed packet and omits the key otherwise", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse({ handoff: {} }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    await client.createHandoff({
      taskId: "task-1",
      fromLaneId: "lane-1",
      toLaneId: "lane-2",
      packetTitle: "Run handoff: codex -> claude-code",
      packetBody: "## Task goal\nFix the parser crash",
      packet: V2_PACKET,
    });
    const withPacket = JSON.parse(
      (fetcher.mock.calls[0]![1] as { body: string }).body
    );
    expect(withPacket.packet).toEqual(V2_PACKET);

    fetcher.mockResolvedValue(mockResponse({ handoff: {} }));
    await client.createHandoff({
      taskId: "task-1",
      fromLaneId: "lane-1",
      toLaneId: "lane-2",
      packetTitle: "Legacy handoff",
      packetBody: "Prose-only legacy body.",
    });
    const withoutPacket = JSON.parse(
      (fetcher.mock.calls[1]![1] as { body: string }).body
    );
    expect("packet" in withoutPacket).toBe(false);
  });

  it("parses task-detail handoffs with packetJson present, null, and absent", async () => {
    const baseHandoff = {
      id: "handoff-1",
      packetTitle: "Handoff",
      packetBody: "Body text",
      status: "pending",
      createdAt: "2026-07-16T09:00:00.000Z",
    };
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        task: {
          id: "task-1",
          title: "Fix backend",
          description: "Make the API suite green.",
          status: "review",
          priority: "high",
          createdAt: "2026-07-16T09:00:00.000Z",
          updatedAt: "2026-07-16T11:00:00.000Z",
          assignments: [],
          handoffs: [
            { ...baseHandoff, id: "handoff-typed", packetJson: V2_PACKET },
            { ...baseHandoff, id: "handoff-null", packetJson: null },
            { ...baseHandoff, id: "handoff-legacy" },
          ],
          approvals: [],
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const task = await client.getTaskDetail("task-1");

    expect(task.handoffs).toHaveLength(3);
    expect(task.handoffs[0]?.packetJson).toEqual(V2_PACKET);
    expect(task.handoffs[1]?.packetJson).toBeNull();
    // Old backends omit the column entirely: the lenient pipe defaults to null.
    expect(task.handoffs[2]?.packetJson).toBeNull();
  });

  it("updateDispatchJobForLease forwards the terminal packet and tolerates a missing packetJson", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        job: {
          id: "job-1",
          kind: "oneshot",
          vendor: "codex",
          taskId: "task-1",
          brief: "do the thing",
          status: "done",
          dispatchedBy: "orchestrator",
          interruptRequested: false,
          steerMessages: [],
          createdAt: "2026-07-16T09:00:00.000Z",
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const job = await client.updateDispatchJobForLease({
      jobId: "job-1",
      host: "desktop-mac",
      leaseToken: `lease-${"a".repeat(58)}`,
      status: "done",
      result: "ok",
      exitCode: 0,
      packet: V2_PACKET,
    });

    const body = JSON.parse(
      (fetcher.mock.calls[0]![1] as { body: string }).body
    );
    expect(body.packet).toEqual(V2_PACKET);
    // An old backend that never returns packetJson still parses.
    expect(job.id).toBe("job-1");
  });

  it("wraps a network failure with the attempted base+path, never the token", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4000");
    });
    const secret = "operator-token-should-never-appear";
    const client = new MuonApiClient("http://127.0.0.1:4000", fetcher, secret);

    let thrown: unknown;
    try {
      await client.health();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    // Names the loopback base + path we tried (makes "Control offline" actionable)…
    expect(message).toContain("http://127.0.0.1:4000/health");
    expect(message).toContain("connect ECONNREFUSED");
    // …but NEVER the bearer token or an Authorization header.
    expect(message).not.toContain(secret);
    expect(message.toLowerCase()).not.toContain("authorization");
    expect(message.toLowerCase()).not.toContain("bearer");
    // The original error is preserved as `cause`.
    expect((thrown as Error).cause).toBeInstanceOf(Error);
  });

  // ── P0.1 Slice A: checkpoint-edge plumbing ─────────────────────────────────

  it("requestApproval carries jobId on the wire and parses it back", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        approval: {
          id: "approval-1",
          taskId: "task-1",
          requestedBy: "claude-code",
          kind: "command",
          reason: "session tool 'Bash' (session session-1)",
          status: "pending",
          jobId: "job-42",
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const approval = await client.requestApproval({
      taskId: "task-1",
      requestedBy: "claude-code",
      kind: "command",
      reason: "session tool 'Bash' (session session-1)",
      jobId: "job-42",
    });

    const body = JSON.parse(
      (fetcher.mock.calls[0]![1] as { body: string }).body
    );
    expect(body.jobId).toBe("job-42");
    // The zod schema must not strip the new binding (zod drops unknown keys).
    expect(approval.jobId).toBe("job-42");
  });

  it("consumeCommandApproval posts the single-use delivery stamp", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse({ consumed: true }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    await client.consumeCommandApproval("approval-1");

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/approvals/approval-1/consume",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("consumeCommandApproval throws on a 409 (already consumed / undecided)", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        mockResponse({ message: "Approval is not consumable." }, 409)
      );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    await expect(client.consumeCommandApproval("approval-1")).rejects.toThrow();
  });

  it("loads bounded server-derived merge review coordinates", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        certification: {
          status: "blocked",
          blockCode: "review-blind",
          reason: "REVIEW BLIND: inspect the new file.",
          changedFiles: ["src/new.ts"],
          blindFiles: ["src/new.ts"],
          artifactDigest: "a".repeat(64),
          indexedCommit: "abc1234",
          headCommit: "abc1234",
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const certification =
      await client.getApprovalReviewCertification("approval-1");

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/approvals/approval-1/review",
      { headers: {} }
    );
    expect(certification).toMatchObject({
      status: "blocked",
      blockCode: "review-blind",
      blindFiles: ["src/new.ts"],
    });
  });

  it("createSession carries jobId on the wire and parses it back", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        session: {
          id: "session-1",
          laneId: "lane-1",
          taskId: "task-1",
          status: "running",
          startedAt: "2026-07-16T00:00:00.000Z",
          jobId: "job-42",
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const session = await client.createSession({
      laneId: "lane-1",
      taskId: "task-1",
      jobId: "job-42",
    });

    const body = JSON.parse(
      (fetcher.mock.calls[0]![1] as { body: string }).body
    );
    expect(body.jobId).toBe("job-42");
    expect(session.jobId).toBe("job-42");
  });

  it("dispatch job records round-trip resumedFromJobId (resume lineage)", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        jobs: [
          {
            id: "job-2",
            kind: "oneshot",
            vendor: "claude-code",
            taskId: "task-1",
            brief: "resume the work",
            status: "queued",
            dispatchedBy: "orchestrator",
            interruptRequested: false,
            steerMessages: [],
            resumedFromJobId: "job-1",
            createdAt: "2026-07-16T00:00:00.000Z",
          },
        ],
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const jobs = await client.listDispatchJobs();

    expect(jobs[0]!.resumedFromJobId).toBe("job-1");
  });

  // ── P0.4 slice 2: policy profiles + receipts wire shapes ────────────────────

  it("getWorkspacePolicy encodes the workspace and optional task scope", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        profile: { version: 1, label: "default" },
        scope: "workspace",
        version: 2,
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const record = await client.getWorkspacePolicy({
      workspacePath: "/Users/me/repo",
      taskId: "task-1",
    });

    const url = fetcher.mock.calls[0]![0] as string;
    expect(url).toContain("/api/policy/profile?");
    expect(url).toContain(`workspacePath=${encodeURIComponent("/Users/me/repo")}`);
    expect(url).toContain("taskId=task-1");
    expect(record.scope).toBe("workspace");
    expect(record.version).toBe(2);
    expect(record.profile).toMatchObject({ label: "default" });
  });

  it("getWorkspacePolicy carries a null profile through (no row = today's behavior)", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({ profile: null, scope: null, version: 0 })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const record = await client.getWorkspacePolicy({
      workspacePath: "/Users/me/repo",
    });

    expect(record.profile).toBeNull();
    expect(record.scope).toBeNull();
  });

  it("redeemReceipt POSTs the exact binding and parses a hit", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        redeemed: true,
        receipt: {
          id: "rcpt-1",
          expiresAt: "2026-07-17T01:00:00.000Z",
          useCount: 2,
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const input = {
      taskId: "task-1",
      jobId: "job-1",
      sessionId: "session-1",
      workspacePath: "/Users/me/repo",
      toolName: "Edit",
      payloadDigest: "a".repeat(64),
    };
    const result = await client.redeemReceipt(input);

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/receipts/redeem",
      {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
      }
    );
    expect(result.redeemed).toBe(true);
    expect(result.receipt).toMatchObject({ id: "rcpt-1", useCount: 2 });
  });

  it("redeemReceipt surfaces a non-2xx as an error (the runner wraps it to a miss)", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(mockResponse({ message: "not found" }, 404));
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    await expect(
      client.redeemReceipt({
        taskId: "task-1",
        jobId: "job-1",
        sessionId: "session-1",
        workspacePath: "/Users/me/repo",
        toolName: "Edit",
        payloadDigest: "a".repeat(64),
      })
    ).rejects.toThrow();
  });

  it("listReceipts passes filters and parses receipt rows", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        receipts: [
          {
            id: "rcpt-1",
            approvalId: "approval-1",
            taskId: "task-1",
            jobId: "job-1",
            sessionId: "session-1",
            workspacePath: "/Users/me/repo",
            actionClass: "edit",
            toolName: "Edit",
            payloadDigest: "a".repeat(64),
            manifestFingerprint: null,
            expiresAt: "2026-07-17T01:00:00.000Z",
            revokedAt: null,
            useCount: 0,
            lastUsedAt: null,
            createdAt: "2026-07-17T00:00:00.000Z",
          },
        ],
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const receipts = await client.listReceipts({
      activeOnly: true,
      workspacePath: "/Users/me/repo",
    });

    const url = fetcher.mock.calls[0]![0] as string;
    expect(url).toContain("/api/receipts?");
    expect(url).toContain("activeOnly=true");
    expect(receipts[0]!.actionClass).toBe("edit");
  });

  it("revokeReceipt POSTs the one-way revocation", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        receipt: {
          id: "rcpt-1",
          approvalId: "approval-1",
          taskId: "task-1",
          jobId: "job-1",
          sessionId: null,
          workspacePath: "/Users/me/repo",
          actionClass: "edit",
          toolName: "Edit",
          payloadDigest: "a".repeat(64),
          manifestFingerprint: null,
          expiresAt: "2026-07-17T01:00:00.000Z",
          revokedAt: "2026-07-17T00:30:00.000Z",
          useCount: 1,
          lastUsedAt: null,
          createdAt: "2026-07-17T00:00:00.000Z",
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const receipt = await client.revokeReceipt("rcpt-1");

    expect(fetcher.mock.calls[0]![0]).toBe(
      "http://localhost:4000/api/receipts/rcpt-1/revoke"
    );
    expect(receipt.revokedAt).toBe("2026-07-17T00:30:00.000Z");
  });

  it("resolveApproval sends the opt-in receipt request only when present", async () => {
    const approvalPayload = {
      approval: {
        id: "approval-1",
        taskId: "task-1",
        requestedBy: "claude-code",
        kind: "command",
        reason: "session tool 'Edit'",
        status: "approved",
      },
    };
    const fetcher = vi.fn().mockResolvedValue(mockResponse(approvalPayload));
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    await client.resolveApproval({
      approvalId: "approval-1",
      status: "approved",
      receipt: { ttlMs: 900_000 },
    });
    const withReceipt = JSON.parse(
      (fetcher.mock.calls[0]![1] as { body: string }).body
    );
    expect(withReceipt.receipt).toEqual({ ttlMs: 900_000 });

    await client.resolveApproval({
      approvalId: "approval-1",
      status: "approved",
    });
    const without = JSON.parse(
      (fetcher.mock.calls[1]![1] as { body: string }).body
    );
    expect(without).not.toHaveProperty("receipt");
  });

  it("resolveApproval sends an explicit exact-artifact manual review attestation", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        approval: {
          id: "approval-merge",
          taskId: "task-1",
          requestedBy: "codex",
          kind: "merge",
          reason: "ship review passed",
          status: "approved",
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    await client.resolveApproval({
      approvalId: "approval-merge",
      status: "approved",
      manualReview: {
        acknowledged: true,
        artifactDigest: "b".repeat(64),
        blindFiles: ["src/new.ts"],
      },
    });

    const body = JSON.parse(
      (fetcher.mock.calls[0]![1] as { body: string }).body
    );
    expect(body.manualReview).toEqual({
      acknowledged: true,
      artifactDigest: "b".repeat(64),
      blindFiles: ["src/new.ts"],
    });
  });

  it("BUG 1: resolveApproval tolerates + surfaces the soft receiptSkipped signal", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        approval: {
          id: "approval-1",
          taskId: "task-1",
          requestedBy: "claude-code",
          kind: "command",
          reason: "session tool 'Bash'",
          status: "approved",
        },
        // The decision landed but the receipt was NOT minted (best-effort).
        receiptSkipped: true,
        receiptSkippedReason:
          "This action can't be remembered — only reads, edits inside the task radius, and configured checks can.",
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const result = await client.resolveApproval({
      approvalId: "approval-1",
      status: "approved",
      receipt: { ttlMs: 900_000 },
    });

    // The approve/reject decision still succeeded (never a thrown 400)…
    expect(result.status).toBe("approved");
    // …and the soft signal is surfaced for the UI to show gently.
    expect(result.receiptSkipped).toBe(true);
    expect(result.receiptSkippedReason).toMatch(/can't be remembered/i);
  });

  it("resolveApproval parses the merge outcome so a land can report its sha, not just 'approved'", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        approval: {
          id: "approval-merge",
          taskId: "task-1",
          requestedBy: "codex",
          kind: "merge",
          reason: "ship requested from MUON desktop",
          status: "approved",
        },
        // The route has always returned this half; the client used to drop it.
        merge: {
          status: "merged",
          sha: "0123456789abcdef0123456789abcdef01234567",
          message: "MUON: land task-1",
          changedFiles: 3,
          mergeCommit: "fedcba9876543210fedcba9876543210fedcba98",
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const result = await client.resolveApproval({
      approvalId: "approval-merge",
      status: "approved",
    });

    expect(result.status).toBe("approved");
    expect(result.merge).toEqual({
      status: "merged",
      sha: "0123456789abcdef0123456789abcdef01234567",
      message: "MUON: land task-1",
      changedFiles: 3,
      mergeCommit: "fedcba9876543210fedcba9876543210fedcba98",
    });
  });

  it("resolveApproval parses every merge outcome the brain can report, not just success", async () => {
    for (const merge of [
      { status: "no-op", reason: "The task has no governed workspace." },
      { status: "conflict", reason: "git merge --no-ff left conflicts." },
      { status: "blocked", reason: "The primary checkout changed branches." },
      { status: "failed", reason: "Merge executor returned success without a commit." },
    ] as const) {
      const fetcher = vi.fn().mockResolvedValue(
        mockResponse({
          approval: {
            id: "approval-merge",
            taskId: "task-1",
            requestedBy: "codex",
            kind: "merge",
            reason: "ship",
            status: "rejected",
          },
          merge,
        })
      );
      const client = new MuonApiClient("http://localhost:4000", fetcher);
      const result = await client.resolveApproval({
        approvalId: "approval-merge",
        status: "rejected",
      });
      expect(result.merge).toEqual(merge);
    }
  });

  it("resolveApproval still parses an older backend response that carries NO merge field (additive, never breaking)", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        approval: {
          id: "approval-1",
          taskId: "task-1",
          requestedBy: "claude-code",
          kind: "command",
          reason: "session tool 'Edit'",
          status: "approved",
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const result = await client.resolveApproval({
      approvalId: "approval-1",
      status: "approved",
    });

    expect(result.status).toBe("approved");
    // Absent, never invented — a non-merge approval landed nothing.
    expect(result).not.toHaveProperty("merge");
  });

  it("F-1: a body-less mutation (DELETE archiveChat) sends NO Content-Type so Fastify does not 400 on an empty JSON body", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        chat: {
          id: "chat-1",
          title: "Old chat",
          workspacePath: "/tmp/ws",
          status: "archived",
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    await client.archiveChat("chat-1");

    const init = fetcher.mock.calls[0]![1] as {
      method?: string;
      body?: unknown;
      headers: Record<string, string>;
    };
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    // The regression: a DELETE with no body must NOT declare application/json,
    // or the embedded Fastify rejects it 400 "Body cannot be empty …".
    expect(init.headers).not.toHaveProperty("Content-Type");
  });

  it("still declares Content-Type when a body IS sent", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(mockResponse({ task: { id: "t1" } }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    await client.createTask({ title: "x", description: "y" }).catch(() => {});
    const init = fetcher.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers["Content-Type"]).toBe("application/json");
  });
});

describe("listStreamChunks carries tool detail (zod strips what it does not declare)", () => {
  const chunk = (detail?: unknown) => ({
    seq: 1,
    taskId: "t1",
    laneId: "claude-code",
    kind: "activity",
    content: "Bash started",
    timestamp: "2026-07-26T00:00:00.000Z",
    ...(detail === undefined ? {} : { detail }),
  });

  it("preserves the bounded tool args/result through validation", async () => {
    // The trap this pins: zod's default is to STRIP unknown keys. Every other
    // hop — adapter capture, recorder redaction, the migration, the route —
    // can be correct and the transcript still renders an empty tool card,
    // because the read schema quietly dropped the field.
    const detail = {
      args: "command: npm test",
      result: "Test Files 1 failed",
      resultTruncated: true,
    };
    const client = new MuonApiClient(
      "http://localhost:4000",
      async () => mockResponse({ chunks: [chunk(detail)] })
    );
    const [got] = await client.listStreamChunks({ taskId: "t1" });
    expect(got?.detail).toEqual(detail);
    expect(got?.detail?.resultTruncated).toBe(true);
  });

  it("still reads a chunk written before the detail column existed", async () => {
    // Every row persisted before migration 0036 has no `detail`. It must parse,
    // not throw, or the whole transcript disappears for older chats.
    const client = new MuonApiClient(
      "http://localhost:4000",
      async () => mockResponse({ chunks: [chunk()] })
    );
    const [got] = await client.listStreamChunks({ taskId: "t1" });
    expect(got?.content).toBe("Bash started");
    expect(got?.detail ?? null).toBeNull();
  });
});
