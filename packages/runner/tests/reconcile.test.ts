import { describe, expect, it, vi } from "vitest";
import type { DispatchJobRecord, MuonApiClient } from "@muon/client";
import {
  BUDGET_EXHAUSTED_MARKER,
  budgetExhaustedResult,
} from "@muon/protocol";
import { AUTO_CONTINUE_CAP } from "@muon/orchestrator";
import { createRunnerReconciler } from "../src/reconcile.js";

/**
 * The runner-side reconcile wiring (task #127): when a delegated worker finishes,
 * the always-alive runner auto-resumes the orchestrator. These exercise the deps
 * the runner binds to its client — the durable cap read from the chat lane, the
 * cross-surface milestone CAS, and the uncertain→gate routing — with the nudge
 * turn itself stubbed (the shared core is tested in @muon/orchestrator).
 */

function job(overrides: Partial<DispatchJobRecord> = {}): DispatchJobRecord {
  return {
    id: "w1",
    kind: "task",
    vendor: "claude-code",
    taskId: "task-1",
    brief: "do the thing",
    chatId: "chat-1",
    parentJobId: "job-root",
    status: "done",
    dispatchedBy: "orchestrator",
    interruptRequested: false,
    steerMessages: [],
    createdAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  } as DispatchJobRecord;
}

/** A mock brain whose chat lane is a shared, appendable, chronological store. */
function makeClient(store: { content: string; kind: string }[]) {
  const approvals: Array<Record<string, unknown>> = [];
  const claimedKeys = new Set<string>();
  const client = {
    listStreamChunks: vi.fn(async () => [...store]),
    recordStreamChunks: vi.fn(
      async (chunks: { content: string; kind?: string }[]) => {
        // Preserve kind: the runner writes dedupe milestones as kind:"milestone",
        // which the durable, kind-gated cap counter depends on.
        for (const chunk of chunks)
          store.push({ content: chunk.content, kind: chunk.kind ?? "milestone" });
      }
    ),
    claimStreamChunk: vi.fn(
      async (chunk: {
        claimKey: string;
        content: string;
        kind: "milestone";
      }) => {
        if (claimedKeys.has(chunk.claimKey)) {
          return { claimed: false };
        }
        claimedKeys.add(chunk.claimKey);
        store.push({ content: chunk.content, kind: chunk.kind });
        return { claimed: true };
      }
    ),
    listApprovals: vi.fn(async () => [...approvals]),
    requestApproval: vi.fn(async (input: Record<string, unknown>) => {
      approvals.push({ ...input, status: "pending" });
      return input;
    }),
    getChat: vi.fn(async () => ({ id: "chat-1" })),
  } as unknown as MuonApiClient;
  return { client, approvals };
}

describe("createRunnerReconciler", () => {
  it("(a) fires exactly ONE reconciliation turn for a watched worker going done", async () => {
    const store: { content: string; kind: string }[] = [
      { content: "[you] build it", kind: "user.message" },
    ];
    const { client } = makeClient(store);
    const nudged: Array<[string, string]> = [];
    const reconciler = createRunnerReconciler({
      client,
      apiBase: "http://localhost:4000",
      apiToken: "agent-token",
      autoContinue: true,
      runningTurns: new Set<string>(),
      runNudgeTurn: async (chatId, j) => {
        nudged.push([chatId, j.id]);
      },
    });

    const outcome = await reconciler.reconcile(job({ id: "w1", status: "done" }));

    expect(outcome).toBe("nudged");
    expect(nudged).toEqual([["chat-1", "w1"]]);
    // One durable dedupe milestone written to the chat lane.
    expect(store.filter((c) => c.content === "[event] job w1 terminal")).toHaveLength(1);
  });

  it("(d) routes an interrupted (uncertain) worker to a human gate, never a replay", async () => {
    const store: { content: string; kind: string }[] = [
      { content: "[you] go", kind: "user.message" },
    ];
    const { client, approvals } = makeClient(store);
    const nudged: string[] = [];
    const reconciler = createRunnerReconciler({
      client,
      apiBase: "http://localhost:4000",
      autoContinue: true,
      runningTurns: new Set<string>(),
      runNudgeTurn: async (_c, j) => {
        nudged.push(j.id);
      },
    });

    const outcome = await reconciler.reconcile(
      job({ id: "w1", status: "interrupted" })
    );

    expect(outcome).toBe("gated");
    expect(nudged).toEqual([]); // never auto-replayed
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ kind: "gate", jobId: "w1" });
  });

  it("(d2) routes MUON'S OWN wall-budget kill to the same human gate, with the honest reason", async () => {
    // The regression this pins: the budget kill was reclassified from
    // `interrupted` to `failed` (correctly — nobody interrupted it), and the
    // uncertain test here was a status-string comparison, so the whole class
    // silently lost its human approval and became one autonomous coordinator
    // turn. `failed` says why it ENDED; it says nothing about the half-written
    // edits in its worktree.
    const store: { content: string; kind: string }[] = [
      { content: "[you] go", kind: "user.message" },
    ];
    const { client, approvals } = makeClient(store);
    const nudged: string[] = [];
    const reconciler = createRunnerReconciler({
      client,
      apiBase: "http://localhost:4000",
      autoContinue: true,
      runningTurns: new Set<string>(),
      runNudgeTurn: async (_c, j) => {
        nudged.push(j.id);
      },
    });

    const outcome = await reconciler.reconcile(
      job({
        id: "w-budget",
        status: "failed",
        result: budgetExhaustedResult({
          vendor: "claude-code",
          budgetMs: 600_000,
          elapsedMs: 603_297,
        }),
      })
    );

    expect(outcome).toBe("gated");
    expect(nudged).toEqual([]);
    expect(approvals).toHaveLength(1);
    const reason = String(approvals[0]!.reason);
    // ACCURACY AND the gate: the reason states what actually happened instead
    // of the old generic "ended 'failed' with an unknown outcome"…
    expect(reason).toContain("wall-clock budget of 600s ran out after 603s");
    expect(reason).toContain("No human interrupted this run");
    expect(reason).toContain("unverified");
    // …without leaking the machine classifier into the operator's prose.
    expect(reason).not.toContain(BUDGET_EXHAUSTED_MARKER);
  });

  it("(d3) still NUDGES a vendor that failed on its own merits", async () => {
    // The other half of the boundary: widening "uncertain" must not swallow an
    // ordinary failure, which the coordinator is supposed to react to itself.
    const store: { content: string; kind: string }[] = [
      { content: "[you] go", kind: "user.message" },
    ];
    const { client, approvals } = makeClient(store);
    const nudged: string[] = [];
    const reconciler = createRunnerReconciler({
      client,
      apiBase: "http://localhost:4000",
      autoContinue: true,
      runningTurns: new Set<string>(),
      runNudgeTurn: async (_c, j) => {
        nudged.push(j.id);
      },
    });

    const outcome = await reconciler.reconcile(
      job({ id: "w-failed", status: "failed", result: "the tests did not pass" })
    );

    expect(outcome).toBe("nudged");
    expect(nudged).toEqual(["w-failed"]);
    expect(approvals).toEqual([]);
  });

  it("(c) enforces AUTO_CONTINUE_CAP from the durable lane, SURVIVING a runner restart", async () => {
    const store: { content: string; kind: string }[] = [
      { content: "[you] start", kind: "user.message" },
    ];
    const { client } = makeClient(store);
    const nudged: string[] = [];
    const runNudgeTurn = async (_c: string, j: DispatchJobRecord) => {
      nudged.push(j.id);
    };

    // Incarnation #1 spends the whole allowance (each writes its milestone).
    // Driven FROM AUTO_CONTINUE_CAP, so this asserts the cap holds rather than
    // asserting what the cap happens to be today.
    const allowed = Array.from(
      { length: AUTO_CONTINUE_CAP },
      (_, index) => `w${index + 1}`
    );
    const first = createRunnerReconciler({
      client,
      apiBase: "http://localhost:4000",
      autoContinue: true,
      runningTurns: new Set<string>(),
      runNudgeTurn,
    });
    for (const id of allowed) {
      expect(await first.reconcile(job({ id, status: "done" }))).toBe("nudged");
    }

    // Runner restarts: a FRESH reconciler with EMPTY in-memory turn slots. The
    // cap must still hold because it is derived from the persisted chat lane.
    const afterRestart = createRunnerReconciler({
      client,
      apiBase: "http://localhost:4000",
      autoContinue: true,
      runningTurns: new Set<string>(),
      runNudgeTurn,
    });
    expect(
      await afterRestart.reconcile(job({ id: "w-over", status: "done" }))
    ).toBe("affordance");

    expect(nudged).toEqual(allowed); // nothing past the cap → no storm
  });

  it("(e) an OUTPUT chunk echoing '[you] ' does NOT reset the durable cap (side-channel)", async () => {
    const store: { content: string; kind: string }[] = [
      { content: "[you] start", kind: "user.message" },
    ];
    const { client } = makeClient(store);
    const nudged: string[] = [];
    const runNudgeTurn = async (_c: string, j: DispatchJobRecord) => {
      nudged.push(j.id);
    };
    const reconciler = createRunnerReconciler({
      client,
      apiBase: "http://localhost:4000",
      autoContinue: true,
      runningTurns: new Set<string>(),
      runNudgeTurn,
    });

    // Exhaust the cap with certain workers (each writes its milestone).
    const allowed = Array.from(
      { length: AUTO_CONTINUE_CAP },
      (_, index) => `w${index + 1}`
    );
    for (const id of allowed) {
      expect(await reconciler.reconcile(job({ id, status: "done" }))).toBe("nudged");
    }

    // The orchestrator streams an OUTPUT chunk that happens to echo "[you] " (e.g.
    // quoting a worker resultTail). A kind-blind counter would treat it as a human
    // reset and re-open the cap → unbounded auto-continue. It must NOT.
    store.push({ content: "[you] worker said: please retry", kind: "output" });

    // The cap still holds: the poisoned echo is not a real human milestone.
    expect(await reconciler.reconcile(job({ id: "w-over", status: "done" }))).toBe(
      "affordance"
    );
    expect(nudged).toEqual(allowed);
  });

  it("(b) a runner and a still-open desktop observing the SAME event never double-fire", async () => {
    const store: { content: string; kind: string }[] = [
      { content: "[you] go", kind: "user.message" },
    ];
    const { client } = makeClient(store);
    const nudged: string[] = [];
    const runNudgeTurn = async (_c: string, j: DispatchJobRecord) => {
      nudged.push(j.id);
    };
    // Two independent reconcilers over the SAME shared brain lane.
    const runner = createRunnerReconciler({
      client,
      apiBase: "http://localhost:4000",
      autoContinue: true,
      runningTurns: new Set<string>(),
      runNudgeTurn,
    });
    const desktopPeer = createRunnerReconciler({
      client,
      apiBase: "http://localhost:4000",
      autoContinue: true,
      runningTurns: new Set<string>(),
      runNudgeTurn,
    });

    const terminal = job({ id: "w1", status: "done" });
    expect(await runner.reconcile(terminal)).toBe("nudged");
    expect(await desktopPeer.reconcile(terminal)).toBe("skipped");

    expect(nudged).toEqual(["w1"]); // exactly one turn across both surfaces
  });

  it("atomically arbitrates simultaneous runner peers", async () => {
    const store: { content: string; kind: string }[] = [
      { content: "[you] go", kind: "user.message" },
    ];
    const { client } = makeClient(store);
    const nudged: string[] = [];
    const options = {
      client,
      apiBase: "http://localhost:4000",
      autoContinue: true,
      runNudgeTurn: async (_chatId: string, worker: DispatchJobRecord) => {
        nudged.push(worker.id);
      },
    };
    const event = job({ id: "w1", status: "done" });
    const outcomes = await Promise.all([
      createRunnerReconciler({
        ...options,
        runningTurns: new Set<string>(),
      }).reconcile(event),
      createRunnerReconciler({
        ...options,
        runningTurns: new Set<string>(),
      }).reconcile(event),
    ]);

    expect(outcomes.sort()).toEqual(["nudged", "skipped"]);
    expect(nudged).toEqual(["w1"]);
  });

  it("shows no autonomous turn when auto-continue is disabled", async () => {
    const store: { content: string; kind: string }[] = [
      { content: "[you] go", kind: "user.message" },
    ];
    const { client } = makeClient(store);
    const nudged: string[] = [];
    const reconciler = createRunnerReconciler({
      client,
      apiBase: "http://localhost:4000",
      autoContinue: false,
      runningTurns: new Set<string>(),
      runNudgeTurn: async (_c, j) => {
        nudged.push(j.id);
      },
    });

    const outcome = await reconciler.reconcile(job({ id: "w1", status: "done" }));

    expect(outcome).toBe("affordance");
    expect(nudged).toEqual([]);
  });

  it("does not write a milestone, gate, or nudge for an archived chat", async () => {
    const store: { content: string; kind: string }[] = [
      { content: "[you] old mission", kind: "user.message" },
    ];
    const { client, approvals } = makeClient(store);
    vi.mocked(client.getChat).mockResolvedValue({
      id: "chat-1",
      status: "archived",
    } as Awaited<ReturnType<MuonApiClient["getChat"]>>);
    const runNudgeTurn = vi.fn(async () => undefined);
    const reconciler = createRunnerReconciler({
      client,
      apiBase: "http://localhost:4000",
      autoContinue: true,
      runningTurns: new Set<string>(),
      runNudgeTurn,
    });

    expect(await reconciler.reconcile(job())).toBe("skipped");
    expect(runNudgeTurn).not.toHaveBeenCalled();
    expect(approvals).toEqual([]);
    expect(store).toEqual([
      { content: "[you] old mission", kind: "user.message" },
    ]);
  });

  it("rechecks archive state at the durable milestone boundary", async () => {
    const store: { content: string; kind: string }[] = [
      { content: "[you] old mission", kind: "user.message" },
    ];
    const { client } = makeClient(store);
    vi.mocked(client.getChat)
      .mockResolvedValueOnce({
        id: "chat-1",
        status: "active",
      } as Awaited<ReturnType<MuonApiClient["getChat"]>>)
      .mockResolvedValueOnce({
        id: "chat-1",
        status: "archived",
      } as Awaited<ReturnType<MuonApiClient["getChat"]>>);
    const runNudgeTurn = vi.fn(async () => undefined);
    const reconciler = createRunnerReconciler({
      client,
      apiBase: "http://localhost:4000",
      autoContinue: true,
      runningTurns: new Set<string>(),
      runNudgeTurn,
    });

    expect(await reconciler.reconcile(job())).toBe("deferred");
    expect(runNudgeTurn).not.toHaveBeenCalled();
    expect(store).toEqual([
      { content: "[you] old mission", kind: "user.message" },
    ]);
  });

  it("rechecks archive state before filing an uncertain-result gate", async () => {
    const store: { content: string; kind: string }[] = [
      { content: "[you] old mission", kind: "user.message" },
    ];
    const { client, approvals } = makeClient(store);
    vi.mocked(client.getChat)
      .mockResolvedValueOnce({
        id: "chat-1",
        status: "active",
      } as Awaited<ReturnType<MuonApiClient["getChat"]>>)
      .mockResolvedValueOnce({
        id: "chat-1",
        status: "active",
      } as Awaited<ReturnType<MuonApiClient["getChat"]>>)
      .mockResolvedValueOnce({
        id: "chat-1",
        status: "archived",
      } as Awaited<ReturnType<MuonApiClient["getChat"]>>);
    const reconciler = createRunnerReconciler({
      client,
      apiBase: "http://localhost:4000",
      autoContinue: true,
      runningTurns: new Set<string>(),
    });

    expect(
      await reconciler.reconcile(job({ status: "interrupted" }))
    ).toBe("skipped");
    expect(approvals).toEqual([]);
  });
});
