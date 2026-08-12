import { describe, expect, it, vi } from "vitest";
import {
  BUDGET_EXHAUSTED_MARKER,
  MuonApiClient,
  type DispatchJobRecord,
} from "@muon/client";
import {
  AUTO_CONTINUE_CAP,
  createJobTerminalMonitor,
  decideContinuation,
  isWatchedWorkerJob,
  reconcileTerminalJob,
  type JobTerminalMonitorState,
  type ReconcileDeps,
  type TerminalJobEvent,
} from "../src/lib/job-terminal-monitor.js";

function mockResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => payload,
  } as Response;
}

const CHAT = {
  id: "chat-1",
  title: "chat",
  workspacePath: "/tmp/ws",
  status: "active",
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
};

// The monitor polls listChats() then listDispatchJobs({chatId}) per chat; route
// the mock fetcher accordingly (a single chat "chat-1" hosts every fixture).
function routedFetcher(jobsRef: () => DispatchJobRecord[]) {
  return vi.fn(async (url: string) => {
    if (typeof url === "string" && url.includes("/api/chats")) {
      return mockResponse({ chats: [CHAT] });
    }
    return mockResponse({ jobs: jobsRef() });
  });
}

// A terminal result exactly as the runner commits one for a wall-budget kill:
// `failed` (MUON ended it, no human did) with the machine marker leading. Built
// from the shared marker rather than the writer helper — the desktop classifies
// these rows, it never writes one.
const BUDGET_KILL_RESULT =
  `${BUDGET_EXHAUSTED_MARKER} MUON stopped claude-code: its own wall-clock ` +
  "budget of 600s ran out after 603s of work.";

function job(overrides: Partial<DispatchJobRecord> = {}): DispatchJobRecord {
  return {
    id: "job-1",
    kind: "task",
    vendor: "claude-code",
    taskId: "task-1",
    brief: "do the thing",
    chatId: "chat-1",
    parentJobId: "job-root",
    status: "running",
    dispatchedBy: "orchestrator",
    interruptRequested: false,
    steerMessages: [],
    createdAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("decideContinuation", () => {
  it("routes uncertain (reclaimed/interrupted) outcomes to a gate, even when enabled", () => {
    expect(
      decideContinuation({
        uncertain: true,
        autoContinueEnabled: true,
        autoTurnsUsed: 0,
      })
    ).toBe("gate");
  });

  it("auto-nudges a certain outcome while enabled and under the cap", () => {
    expect(
      decideContinuation({
        uncertain: false,
        autoContinueEnabled: true,
        autoTurnsUsed: AUTO_CONTINUE_CAP - 1,
      })
    ).toBe("nudge");
  });

  it("suppresses the 4th consecutive auto-turn → affordance", () => {
    expect(
      decideContinuation({
        uncertain: false,
        autoContinueEnabled: true,
        autoTurnsUsed: AUTO_CONTINUE_CAP,
      })
    ).toBe("affordance");
  });

  it("shows the affordance instead of auto-continuing when disabled", () => {
    expect(
      decideContinuation({
        uncertain: false,
        autoContinueEnabled: false,
        autoTurnsUsed: 0,
      })
    ).toBe("affordance");
  });
});

describe("isWatchedWorkerJob", () => {
  it("matches a delegated worker (chatId + parentJobId), not the chat root", () => {
    expect(isWatchedWorkerJob(job())).toBe(true);
    // The chat's own session turn: chatId but no parent.
    expect(
      isWatchedWorkerJob(job({ id: "root", parentJobId: null }))
    ).toBe(false);
    // A chatless direct dispatch: no home chat to nudge.
    expect(isWatchedWorkerJob(job({ chatId: null }))).toBe(false);
  });
});

describe("job terminal monitor", () => {
  it("adopts jobs terminal at startup, then nudges only newly-terminal workers once", async () => {
    let jobs: DispatchJobRecord[] = [
      job({ id: "old", status: "done" }),
      job({ id: "live", status: "running" }),
    ];
    const fetcher = routedFetcher(() => jobs);
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const fired: string[] = [];
    const monitor = createJobTerminalMonitor(client, {
      onTerminalJob: (event: TerminalJobEvent) => {
        fired.push(event.job.id);
        return true;
      },
    });

    // Startup: "old" is already terminal → adopted silently.
    await monitor.poll();
    expect(fired).toEqual([]);

    // "live" finishes → nudged once.
    jobs = [job({ id: "old", status: "done" }), job({ id: "live", status: "done" })];
    await monitor.poll();
    expect(fired).toEqual(["live"]);

    // Repeated polls never re-announce a handled job.
    await monitor.poll();
    expect(fired).toEqual(["live"]);
  });

  it("(FIX 2) defers ENTIRELY to a live runner, then reconciles once it dies", async () => {
    let jobs: DispatchJobRecord[] = [job({ id: "w", status: "running" })];
    const fetcher = routedFetcher(() => jobs);
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const fired: string[] = [];
    let runnerLive = true;
    const monitor = createJobTerminalMonitor(
      client,
      {
        onTerminalJob: (event) => {
          fired.push(event.job.id);
          return true;
        },
      },
      { isRunnerLive: async () => runnerLive }
    );

    await monitor.poll(); // startup adopts "w" while running
    jobs = [job({ id: "w", status: "done" })];

    // Runner live → the desktop is the redundant peer and defers ENTIRELY (the
    // runner is the durable reconcile driver), so nothing fires here.
    await monitor.poll();
    expect(fired).toEqual([]);

    // Runner dies → the desktop was still TRACKING the job (never marked handled)
    // and now picks reconciliation back up.
    runnerLive = false;
    await monitor.poll();
    expect(fired).toEqual(["w"]);
  });

  it("ignores the chat root turn and chatless jobs", async () => {
    let jobs: DispatchJobRecord[] = [job({ id: "worker", status: "running" })];
    const fetcher = routedFetcher(() => jobs);
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const fired: string[] = [];
    const monitor = createJobTerminalMonitor(client, {
      onTerminalJob: (event) => {
        fired.push(event.job.id);
        return true;
      },
    });

    await monitor.poll(); // startup

    jobs = [
      job({ id: "worker", status: "done" }),
      job({ id: "root", status: "done", parentJobId: null }),
      job({ id: "loose", status: "done", chatId: null }),
    ];
    await monitor.poll();
    expect(fired).toEqual(["worker"]);
  });

  it("marks interrupted/reclaimed jobs uncertain so the caller can route to a gate", async () => {
    let jobs: DispatchJobRecord[] = [job({ id: "w", status: "running" })];
    const fetcher = routedFetcher(() => jobs);
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const events: TerminalJobEvent[] = [];
    const monitor = createJobTerminalMonitor(client, {
      onTerminalJob: (event) => {
        events.push(event);
        return true;
      },
    });

    await monitor.poll(); // startup
    jobs = [job({ id: "w", status: "interrupted" })];
    await monitor.poll();

    expect(events).toHaveLength(1);
    expect(events[0]!.uncertain).toBe(true);
  });

  it("marks MUON's own wall-budget kill uncertain too — the runner and this monitor must agree", async () => {
    // Cross-surface parity. The runner classifies a budget kill (a `failed` row
    // carrying the marker) as uncertain; if this poll — the peer that reconciles
    // whenever no runner is live — called it certain, the SAME event would reach
    // a human on one surface and an autonomous coordinator turn on the other.
    let jobs: DispatchJobRecord[] = [job({ id: "w", status: "running" })];
    const fetcher = routedFetcher(() => jobs);
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const events: TerminalJobEvent[] = [];
    const monitor = createJobTerminalMonitor(client, {
      onTerminalJob: (event) => {
        events.push(event);
        return true;
      },
    });

    await monitor.poll(); // startup
    jobs = [
      job({ id: "w", status: "failed", result: BUDGET_KILL_RESULT }),
      job({ id: "w-real-failure", status: "failed", result: "tests failed" }),
    ];
    await monitor.poll();

    expect(events.map((event) => [event.job.id, event.uncertain])).toEqual([
      ["w", true],
      // …and an ordinary vendor failure is still certain: one bounded nudge.
      ["w-real-failure", false],
    ]);
  });

  it("retries a deferred job on the next poll (a turn was busy)", async () => {
    const jobs: DispatchJobRecord[] = [job({ id: "w", status: "running" })];
    const fetcher = routedFetcher(() => jobs);
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    let deferOnce = true;
    let attempts = 0;
    const monitor = createJobTerminalMonitor(client, {
      onTerminalJob: () => {
        attempts += 1;
        if (deferOnce) {
          deferOnce = false;
          return false; // busy → defer
        }
        return true;
      },
    });

    await monitor.poll(); // startup adopts "w" while running
    jobs[0] = job({ id: "w", status: "done" });
    await monitor.poll(); // deferred
    expect(attempts).toBe(1);
    await monitor.poll(); // retried, now handled
    expect(attempts).toBe(2);
    await monitor.poll(); // handled → no more
    expect(attempts).toBe(2);
  });

  it("nudges once for a done worker and writes the durable dedupe milestone", async () => {
    const chunks: { content: string; kind: string }[] = [];
    const slots = new Set<string>();
    const nudged: string[] = [];
    let counted = 0;
    const deps: ReconcileDeps = {
      milestoneFor: (jobId) => `[event] job ${jobId} terminal`,
      claimMilestone: async (_chatId, _claimKey, content) => {
        chunks.push({ content, kind: "milestone" });
        return true;
      },
      autoContinueEnabled: true,
      autoTurnsUsed: 0,
      tryClaimTurnSlot: (chatId) => {
        if (slots.has(chatId)) return false;
        slots.add(chatId);
        return true;
      },
      releaseTurnSlot: (chatId) => slots.delete(chatId),
      onNudge: () => {
        counted += 1;
      },
      runNudgeTurn: async (chatId) => {
        nudged.push(chatId);
      },
      fileGate: async () => undefined,
      showAffordance: () => undefined,
    };

    const outcome = await reconcileTerminalJob(
      { job: job({ id: "A", status: "done" }), uncertain: false },
      deps
    );

    expect(outcome).toBe("nudged");
    expect(nudged).toEqual(["chat-1"]);
    expect(counted).toBe(1);
    expect(chunks).toEqual([
      { content: "[event] job A terminal", kind: "milestone" },
    ]);
    expect(slots.size).toBe(0); // slot released
  });

  it("skips when the dedupe milestone already exists (no double-nudge)", async () => {
    const chunks = [{ content: "[event] job A terminal", kind: "milestone" }];
    const nudged: string[] = [];
    const deps: ReconcileDeps = {
      milestoneFor: (jobId) => `[event] job ${jobId} terminal`,
      claimMilestone: async () => false,
      autoContinueEnabled: true,
      autoTurnsUsed: 0,
      tryClaimTurnSlot: () => true,
      releaseTurnSlot: () => undefined,
      onNudge: () => undefined,
      runNudgeTurn: async (chatId) => {
        nudged.push(chatId);
      },
      fileGate: async () => undefined,
      showAffordance: () => undefined,
    };

    const outcome = await reconcileTerminalJob(
      { job: job({ id: "A", status: "done" }), uncertain: false },
      deps
    );

    expect(outcome).toBe("skipped");
    expect(nudged).toEqual([]);
    expect(chunks).toHaveLength(1); // no second milestone
  });

  it("defers (writes nothing) when a turn is already running", async () => {
    const chunks: { content: string; kind: string }[] = [];
    const deps: ReconcileDeps = {
      milestoneFor: (jobId) => `[event] job ${jobId} terminal`,
      claimMilestone: async (_chatId, _claimKey, content) => {
        chunks.push({ content, kind: "milestone" });
        return true;
      },
      autoContinueEnabled: true,
      autoTurnsUsed: 0,
      tryClaimTurnSlot: () => false, // busy
      releaseTurnSlot: () => undefined,
      onNudge: () => undefined,
      runNudgeTurn: async () => undefined,
      fileGate: async () => undefined,
      showAffordance: () => undefined,
    };

    const outcome = await reconcileTerminalJob(
      { job: job({ id: "A", status: "done" }), uncertain: false },
      deps
    );

    expect(outcome).toBe("deferred");
    expect(chunks).toEqual([]); // nothing written → clean retry next poll
  });

  it("routes an uncertain outcome to a gate, never a turn", async () => {
    const gated: string[] = [];
    const nudged: string[] = [];
    const deps: ReconcileDeps = {
      milestoneFor: (jobId) => `[event] job ${jobId} terminal`,
      claimMilestone: async () => true,
      autoContinueEnabled: true,
      autoTurnsUsed: 0,
      tryClaimTurnSlot: () => true,
      releaseTurnSlot: () => undefined,
      onNudge: () => undefined,
      runNudgeTurn: async (chatId) => {
        nudged.push(chatId);
      },
      fileGate: async (_chatId, j) => {
        gated.push(j.id);
      },
      showAffordance: () => undefined,
    };

    const outcome = await reconcileTerminalJob(
      { job: job({ id: "A", status: "interrupted" }), uncertain: true },
      deps
    );

    expect(outcome).toBe("gated");
    expect(gated).toEqual(["A"]);
    expect(nudged).toEqual([]);
  });

  it("shows the affordance (no turn) when auto-continue is disabled", async () => {
    const shown: Array<[string, string]> = [];
    const nudged: string[] = [];
    const deps: ReconcileDeps = {
      milestoneFor: (jobId) => `[event] job ${jobId} terminal`,
      claimMilestone: async () => true,
      autoContinueEnabled: false,
      autoTurnsUsed: 0,
      tryClaimTurnSlot: () => true,
      releaseTurnSlot: () => undefined,
      onNudge: () => undefined,
      runNudgeTurn: async (chatId) => {
        nudged.push(chatId);
      },
      fileGate: async () => undefined,
      showAffordance: (chatId, jobId) => shown.push([chatId, jobId]),
    };

    const outcome = await reconcileTerminalJob(
      { job: job({ id: "A", status: "done" }), uncertain: false },
      deps
    );

    expect(outcome).toBe("affordance");
    expect(shown).toEqual([["chat-1", "A"]]);
    expect(nudged).toEqual([]);
  });

  it("reports offline on error and recovers", async () => {
    // First poll: listChats() rejects → offline. Recovery: listChats() returns
    // no chats → the sweep is a no-op → online.
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue(mockResponse({ chats: [] }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const states: JobTerminalMonitorState[] = [];
    const monitor = createJobTerminalMonitor(client, {
      onState: (state) => states.push(state),
      onTerminalJob: () => true,
    });

    await monitor.poll();
    expect(states[0]).toMatchObject({ online: false });
    expect(states[0]?.lastError).toContain("ECONNREFUSED");

    await monitor.poll();
    expect(states[1]).toMatchObject({ online: true });
  });
});

// ── P0.1 checkpoint+resume (Slice C5): uncertain-gate durability repair ───────
//
// The uncertain path is acceptance-critical: a reclaimed job MUST durably end
// as a pending human gate. Two historical swallows are closed: (1) a failed
// milestone write no longer silently claims the event (tri-state claim), and
// (2) losing the milestone race no longer skips gate filing — fileGate is
// idempotent per jobId, so the repair call is safe.

import { fileJobTerminalGate } from "../src/lib/job-terminal-monitor.js";

function gateDeps(overrides: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    milestoneFor: (jobId) => `[event] job ${jobId} terminal`,
    claimMilestone: async () => true,
    autoContinueEnabled: true,
    autoTurnsUsed: 0,
    tryClaimTurnSlot: () => true,
    releaseTurnSlot: () => undefined,
    onNudge: () => undefined,
    runNudgeTurn: async () => undefined,
    fileGate: async () => undefined,
    showAffordance: () => undefined,
    ...overrides,
  };
}

describe("uncertain-gate durability (P0.1 Slice C5)", () => {
  it("a milestone-WRITE failure defers (nothing durable was claimed; retried next poll)", async () => {
    const outcome = await reconcileTerminalJob(
      { job: job({ id: "A", status: "interrupted" }), uncertain: true },
      gateDeps({
        claimMilestone: async () => {
          throw new Error("brain hiccup");
        },
      })
    );
    expect(outcome).toBe("deferred");
  });

  it("LOST milestone race on the gate path still invokes fileGate (repair), then skips", async () => {
    const gated: string[] = [];
    const outcome = await reconcileTerminalJob(
      { job: job({ id: "A", status: "interrupted" }), uncertain: true },
      gateDeps({
        claimMilestone: async () => false,
        fileGate: async (_chatId, j) => {
          gated.push(j.id);
        },
      })
    );
    expect(outcome).toBe("skipped");
    expect(gated).toEqual(["A"]); // the repair: milestone landed but the gate may not have
  });

  it("fileGate throwing after a WON claim surfaces the error and skips (never claims 'gated')", async () => {
    const errors: string[] = [];
    const outcome = await reconcileTerminalJob(
      { job: job({ id: "A", status: "interrupted" }), uncertain: true },
      gateDeps({
        fileGate: async () => {
          throw new Error("400 from approvals");
        },
        onError: (_chatId, message) => {
          errors.push(message);
        },
      })
    );
    expect(outcome).toBe("skipped");
    expect(errors.some((message) => message.includes("400"))).toBe(true);
  });

  it("a gate that 400s once is eventually filed via the lost-race repair path", async () => {
    const chunks: { content: string; kind: string }[] = [];
    const claims = new Set<string>();
    let filings = 0;
    const deps = gateDeps({
      claimMilestone: async (_chatId, claimKey, content) => {
        if (claims.has(claimKey)) {
          return false;
        }
        claims.add(claimKey);
        chunks.push({ content, kind: "milestone" });
        return true;
      },
      fileGate: async () => {
        filings += 1;
        if (filings === 1) throw new Error("400 unrecognized gateTag");
      },
      onError: () => undefined,
    });
    const event = { job: job({ id: "A", status: "interrupted" }), uncertain: true };
    // First pass: wins the milestone, fileGate 400s → skipped.
    expect(await reconcileTerminalJob(event, deps)).toBe("skipped");
    // Later pass (peer surface / next session): milestone exists → lost race →
    // the repair path files the gate successfully.
    expect(await reconcileTerminalJob(event, deps)).toBe("skipped");
    expect(filings).toBe(2);
  });
});

describe("fileJobTerminalGate — jobId-bound, cross-restart idempotent", () => {
  const terminalJob = job({ id: "job-A", status: "interrupted" });

  it("files a gateTag-LESS gate bound to the job (the sanctioned inert escalation shape)", async () => {
    const filed: Record<string, unknown>[] = [];
    const result = await fileJobTerminalGate(
      {
        listApprovals: async () => [],
        requestApproval: async (input) => {
          filed.push(input as Record<string, unknown>);
        },
      },
      "chat-1",
      terminalJob
    );
    expect(result).toBe("filed");
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      taskId: "task-1",
      kind: "gate",
      jobId: "job-A",
    });
    // NEVER a gateTag: `job-terminal:<id>` fails parseGateTag → 400, and a
    // tag-less gate can never redeem at any route (inert escalation only).
    expect("gateTag" in filed[0]!).toBe(false);
    expect(String(filed[0]!.reason)).toMatch(/job-A/);
  });

  it("skips when a pending jobId-bound gate already exists (dedupe across surfaces/restarts)", async () => {
    let filedCount = 0;
    const result = await fileJobTerminalGate(
      {
        listApprovals: async () => [
          {
            id: "approval-1",
            taskId: "task-1",
            kind: "gate",
            status: "pending",
            jobId: "job-A",
          } as never,
        ],
        requestApproval: async () => {
          filedCount += 1;
        },
      },
      "chat-1",
      terminalJob
    );
    expect(result).toBe("exists");
    expect(filedCount).toBe(0);
  });

  it("a decided (non-pending) gate does not suppress a fresh filing", async () => {
    let filedCount = 0;
    await fileJobTerminalGate(
      {
        listApprovals: async () => [
          {
            id: "approval-1",
            taskId: "task-1",
            kind: "gate",
            status: "rejected",
            jobId: "job-A",
          } as never,
        ],
        requestApproval: async () => {
          filedCount += 1;
        },
      },
      "chat-1",
      terminalJob
    );
    expect(filedCount).toBe(1);
  });
});
