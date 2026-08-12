import { describe, expect, it } from "vitest";
import type { DispatchJobRecord, MuonApiClient } from "@muon/client";
import { AUTO_CONTINUE_CAP } from "@muon/orchestrator";
import { createRunnerReconciler } from "../src/reconcile.js";

/**
 * E2E: child terminal → orchestrator continuation → final operator summary.
 *
 * The founder's live failure, end to end. Two governed children were dispatched
 * onto a worker lane, the coordinator posted "jobs run in the background; I
 * reconcile on the next turn", and its chat went idle. Both children reached
 * terminal and produced real work. Nothing woke the coordinator: no
 * continuation turn, the queued sequential reviewer was never dispatched, and
 * no summary was ever posted to the operator.
 *
 * The wake path EXISTED. Two things stopped it, and this test covers both by
 * running the REAL `runChatTurn` (not the `runNudgeTurn` test seam — that seam
 * is exactly why the suite stayed green while production was silent):
 *
 *   1. ADMISSION. Chat roots are operator-only and the runner holds the shared
 *      AGENT bearer, so every auto-resume it ever fired was refused 403 by
 *      `POST /api/dispatch`. `fakeBrain` below re-implements that fence, so a
 *      continuation missing its marker fails here the way it failed live.
 *   2. INSTRUCTION. A wake turn with no directive is answered with a status
 *      line. The continuation control block now names the finished children and
 *      demands one of exactly two endings.
 */

const CHAT_ID = "chat-mission";
const ROOT_ID = "job-root";
const LANE = "claude-code";

type FakeJob = {
  id: string;
  taskId: string;
  vendor: string;
  status: string;
  parentJobId: string | null;
  /** The mission this row belongs to — a chat holds many over its life. */
  rootJobId?: string | null;
  chatId: string | null;
  result?: string;
  capabilityMode?: string;
  /** How the route persists a resolved vendor action (model / effort). */
  action?: string;
  actionProfilePatch?: Record<string, unknown>;
};

type Chunk = {
  seq: number;
  taskId: string;
  laneId: string;
  kind: string;
  content: string;
};

/**
 * A brain that behaves like the backend on the two axes this test is about:
 * it enforces the operator-only chat-root fence, and its worker lane is the
 * dev/test `fake` vendor.
 *
 * The coordinator seat is scripted rather than real: it reads the brief MUON
 * actually sent and does what the brief tells it to. That is the honest E2E
 * boundary — MUON owns waking the seat and carrying the evidence; the vendor
 * writes the prose.
 */
function fakeBrain(options: { tier: "operator" | "agent" }) {
  const jobs: FakeJob[] = [
    {
      id: ROOT_ID,
      taskId: "task-shadow",
      vendor: LANE,
      status: "done",
      parentJobId: null,
      chatId: CHAT_ID,
      capabilityMode: "orchestrator",
    },
    {
      id: "child-impl",
      taskId: "task-impl",
      vendor: "fake",
      status: "done",
      parentJobId: ROOT_ID,
      rootJobId: ROOT_ID,
      chatId: CHAT_ID,
      result: "implementer: added the dispatch-contract validator tests",
    },
    {
      id: "child-docs",
      taskId: "task-docs",
      vendor: "fake",
      status: "done",
      parentJobId: ROOT_ID,
      rootJobId: ROOT_ID,
      chatId: CHAT_ID,
      result: "docs: rewrote apps/cli/README.md",
    },
  ];
  // The typed final report each child left behind — what the summary must quote.
  const handoffs: Record<string, string> = {
    "task-impl": "HANDOFF task-impl: 3 files changed, `npm test` green, 0 uncertainties",
    "task-docs": "HANDOFF task-docs: apps/cli/README.md rewritten, no checks required",
  };
  const chunks: Chunk[] = [
    {
      seq: 1,
      taskId: CHAT_ID,
      laneId: "muon-chat",
      kind: "user.message",
      content: "[you] implement the CLI docs and review the result",
    },
  ];
  const claimed = new Set<string>();
  const rootBriefs: string[] = [];
  /** Every chat-root dispatch body the wake path sent, verbatim. */
  const rootDispatches: Record<string, unknown>[] = [];
  const refusals: string[] = [];
  let seq = chunks.length;
  let enqueueAttempts = 0;
  let failOnce: string | undefined;
  let failAlways: string | undefined;

  const append = (chunk: Omit<Chunk, "seq">): Chunk => {
    seq += 1;
    const row = { ...chunk, seq };
    chunks.push(row);
    return row;
  };

  /**
   * The scripted coordinator seat. It reads the roster MUON injected and obeys
   * the control block: still-live children → a status line; nothing live → the
   * FINAL MISSION SUMMARY, quoting every child's typed handoff packet.
   */
  const runCoordinatorTurn = (brief: string): void => {
    const roster = brief.match(
      /<mission_children encoding="json">(.*?)<\/mission_children>/s
    );
    const mission = roster
      ? (JSON.parse(roster[1]!) as {
          finished: Array<{ jobId: string; taskId: string; vendor: string }>;
          live: number;
        })
      : { finished: [], live: 0 };
    if (mission.live > 0) {
      append({
        taskId: CHAT_ID,
        laneId: "muon-chat",
        kind: "output.message",
        content: `next: ${mission.live} worker(s) still running; reconciling on their terminal event.`,
      });
      return;
    }
    const collected = mission.finished
      .map(
        (child) =>
          `- ${child.vendor} job ${child.jobId} (${child.taskId}): ${
            handoffs[child.taskId] ?? "no packet — UNVERIFIED"
          }`
      )
      .join("\n");
    append({
      taskId: CHAT_ID,
      laneId: "muon-chat",
      kind: "output.message",
      content: `FINAL MISSION SUMMARY\n${collected}\nverdict: mission complete; nothing left runnable.`,
    });
  };

  const client = {
    getRunner: async () => ({ live: true, runner: { id: "runner-1" } }),
    getChat: async () => ({
      id: CHAT_ID,
      title: "mission",
      workspacePath: "/tmp/ws",
      taskId: "task-shadow",
      status: "active",
      vendorSessionId: null,
      vendorSessionVendor: null,
      vendorSessionRootJobId: null,
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
    }),
    listDispatchJobs: async (filter?: {
      chatId?: string;
      activeRootOnly?: boolean;
      latest?: boolean;
      limit?: number;
    }) => {
      let rows = jobs.filter(
        (job) => !filter?.chatId || job.chatId === filter.chatId
      );
      if (filter?.activeRootOnly) {
        rows = rows.filter(
          (job) => ["queued", "running"].includes(job.status) && !job.parentJobId
        );
      }
      // Mirrors the backend: insertion order is createdAt ASC, and `latest`
      // takes the NEWEST `limit` rows and returns them chronologically. Without
      // this the fixture could not show that a paged window fills with the
      // OLDEST (previous mission's) children.
      const limit = filter?.limit ?? rows.length;
      return (
        filter?.latest ? rows.slice(-limit) : rows.slice(0, limit)
      ) as unknown as DispatchJobRecord[];
    },
    getDispatchJob: async (jobId: string) =>
      jobs.find((job) => job.id === jobId) as unknown as DispatchJobRecord,
    listStreamChunks: async (filter?: {
      latest?: boolean;
      afterSeq?: number;
      limit?: number;
    }) => {
      if (filter?.latest) return chunks.slice(-(filter.limit ?? 500));
      return chunks.filter((chunk) => chunk.seq > (filter?.afterSeq ?? 0));
    },
    recordStreamChunks: async (rows: Omit<Chunk, "seq">[]) => {
      // Deferred by a MACROTASK on purpose: a floating `void record(...)` would
      // not have landed by the time the caller's await resolves, so a test that
      // reads the chunk right after reconcile proves the write is flushed.
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const row of rows) append(row);
      return { recorded: rows.length };
    },
    claimStreamChunk: async (input: {
      taskId: string;
      laneId: string;
      claimKey: string;
      kind: string;
      content: string;
    }) => {
      if (claimed.has(input.claimKey)) return { claimed: false };
      claimed.add(input.claimKey);
      append(input);
      return { claimed: true };
    },
    updateChat: async () => undefined,
    listApprovals: async () => [],
    requestApproval: async () => undefined,
    // THE FENCE, as backend/src/routes/dispatch.ts enforces it.
    enqueueDispatch: async (input: {
      chatId?: string;
      brief: string;
      kind?: string;
      vendor?: string;
      humanMessage?: string;
      continuation?: string;
      continuationJobId?: string;
    }) => {
      enqueueAttempts += 1;
      if (failAlways) throw new Error(failAlways);
      if (failOnce) {
        const message = failOnce;
        failOnce = undefined;
        throw new Error(message);
      }
      if (input.chatId && options.tier !== "operator") {
        const child = jobs.find((job) => job.id === input.continuationJobId);
        const admitted =
          input.continuation === "job-terminal" &&
          input.kind === "session" &&
          input.humanMessage === undefined &&
          Boolean(child) &&
          child!.chatId === input.chatId &&
          Boolean(child!.parentJobId) &&
          ["done", "failed", "interrupted"].includes(child!.status);
        if (!admitted) {
          refusals.push(input.continuation ?? "none");
          throw new Error(
            "Only the human/operator surface may create a root orchestrator chat job."
          );
        }
      }
      rootBriefs.push(input.brief);
      rootDispatches.push(input as Record<string, unknown>);
      const id = `root-${rootBriefs.length}`;
      jobs.push({
        id,
        taskId: "task-shadow",
        vendor: LANE,
        status: "done",
        parentJobId: null,
        chatId: CHAT_ID,
        capabilityMode: "orchestrator",
      });
      runCoordinatorTurn(input.brief);
      return { id, status: "done" } as unknown as DispatchJobRecord;
    },
  };
  return {
    client: client as unknown as MuonApiClient,
    jobs,
    chunks,
    rootBriefs,
    rootDispatches,
    refusals,
    get enqueueAttempts() {
      return enqueueAttempts;
    },
    failNextEnqueue: (message: string) => {
      failOnce = message;
    },
    failEveryEnqueue: (message: string) => {
      failAlways = message;
    },
    setStatus: (id: string, status: string) => {
      jobs.find((job) => job.id === id)!.status = status;
    },
    addChild: (id: string, status: string, rootId: string = ROOT_ID) => {
      jobs.push({
        id,
        taskId: `task-${id}`,
        vendor: "fake",
        status,
        parentJobId: rootId,
        rootJobId: rootId,
        chatId: CHAT_ID,
        result: `${id} finished`,
      });
    },
    setRootVendor: (vendor: string) => {
      jobs.find((job) => job.id === ROOT_ID)!.vendor = vendor;
    },
    setRootModel: (model: string) => {
      const root = jobs.find((job) => job.id === ROOT_ID)!;
      root.actionProfilePatch = { ...(root.actionProfilePatch ?? {}), model };
    },
    /** As the route persists an `effort` action for each lane's channel shape. */
    setRootEffort: (level: string) => {
      const root = jobs.find((job) => job.id === ROOT_ID)!;
      root.action = "effort";
      root.actionProfilePatch =
        root.vendor === "codex"
          ? {
              ...(root.actionProfilePatch ?? {}),
              rawConfig: { model_reasoning_effort: level },
            }
          : {
              ...(root.actionProfilePatch ?? {}),
              extraArgs: ["--effort", level],
            };
    },
    /** A LATER mission in the SAME chat — the second thing the human asked for. */
    addMissionRoot: (id: string) => {
      jobs.push({
        id,
        taskId: "task-shadow",
        vendor: LANE,
        status: "done",
        parentJobId: null,
        rootJobId: null,
        chatId: CHAT_ID,
        capabilityMode: "orchestrator",
      });
    },
  };
}

const child = (brain: ReturnType<typeof fakeBrain>, id: string) =>
  brain.jobs.find((job) => job.id === id) as unknown as DispatchJobRecord;

describe("E2E: two fake-vendor children terminal → continuation → final summary", () => {
  it("wakes the coordinator for EACH child and ends with the operator summary", async () => {
    const brain = fakeBrain({ tier: "agent" });
    // Child 2 is still running when child 1 finishes — the real interleaving.
    brain.setStatus("child-docs", "running");
    const reconciler = createRunnerReconciler({
      client: brain.client,
      apiBase: "http://localhost:4000",
      apiToken: "agent-token",
      autoContinue: true,
      runningTurns: new Set<string>(),
    });

    // ── child 1 goes terminal while a sibling is still live ──────────────────
    expect(await reconciler.reconcile(child(brain, "child-impl"))).toBe("nudged");
    expect(brain.refusals).toEqual([]);
    expect(brain.rootBriefs).toHaveLength(1);
    const first = brain.rootBriefs[0]!;
    expect(first).toContain('<muon_control kind="job-terminal-continuation">');
    expect(first).toContain('"live":1');
    // The coordinator, obeying it, reports rather than declaring victory.
    expect(
      brain.chunks.some((chunk) => chunk.content.startsWith("next: 1 worker(s)"))
    ).toBe(true);

    // ── child 2 goes terminal: nothing runnable left ─────────────────────────
    brain.setStatus("child-docs", "done");
    expect(await reconciler.reconcile(child(brain, "child-docs"))).toBe("nudged");
    expect(brain.rootBriefs).toHaveLength(2);
    const second = brain.rootBriefs[1]!;
    expect(second).toContain('"live":0');
    // The roster on the LAST wake names BOTH children, so the summary can
    // collect the whole crew and not just the child whose event fired.
    expect(second).toContain("child-impl");
    expect(second).toContain("child-docs");
    expect(second).toContain("post the FINAL MISSION SUMMARY");

    // ── the operator-facing deliverable, embedding each child's report ───────
    const summary = brain.chunks.find((chunk) =>
      chunk.content.startsWith("FINAL MISSION SUMMARY")
    );
    expect(summary).toBeDefined();
    expect(summary!.content).toContain("HANDOFF task-impl");
    expect(summary!.content).toContain("HANDOFF task-docs");
    expect(summary!.content).toContain("verdict: mission complete");
  });

  it("REGRESSION: without the continuation marker the agent-tier wake is refused", async () => {
    // The live bug, reproduced. A wake that does not declare itself is exactly
    // what the runner used to send, and the brain answers it the way the route
    // did: 403, swallowed, silence.
    const brain = fakeBrain({ tier: "agent" });
    const reconciler = createRunnerReconciler({
      client: brain.client,
      apiBase: "http://localhost:4000",
      autoContinue: true,
      runningTurns: new Set<string>(),
      // Same turn, minus the one field that declares it a continuation.
      runNudgeTurn: async (chatId, job) => {
        await brain.client.enqueueDispatch({
          kind: "session",
          vendor: LANE,
          taskId: "task-shadow",
          brief: "resumed turn",
          chatId,
          continuationJobId: job.id,
        } as Parameters<MuonApiClient["enqueueDispatch"]>[0]);
      },
    });

    await reconciler.reconcile(child(brain, "child-impl"));

    // Refused on both bounded attempts — never retried into a loop.
    expect(brain.refusals).toEqual(["none", "none"]);
    expect(brain.rootBriefs).toHaveLength(0);
    // And the failure is now VISIBLE where the human is looking, instead of
    // reaching a runner log line and nowhere else.
    expect(
      brain.chunks.some((chunk) =>
        chunk.content.startsWith("[reconcile.failed] MUON could not auto-continue")
      )
    ).toBe(true);
  });

  it("F9: a TRANSIENT failure does not end autonomous continuation", async () => {
    // The claim is written before the turn, a throw was caught and reported
    // "nudged", and every retry then found the claim taken and returned
    // "skipped" forever. One 409 or one timeout permanently ended continuation
    // for that child — and still spent a unit of cap doing it.
    const brain = fakeBrain({ tier: "agent" });
    brain.setStatus("child-docs", "done");
    brain.failNextEnqueue("Chat acquired another active root dispatch concurrently.");
    const reconciler = createRunnerReconciler({
      client: brain.client,
      apiBase: "http://localhost:4000",
      autoContinue: true,
      runningTurns: new Set<string>(),
    });

    expect(await reconciler.reconcile(child(brain, "child-impl"))).toBe("nudged");

    // The bounded retry got the turn through, so the mission continued.
    expect(brain.rootBriefs).toHaveLength(1);
    expect(
      brain.chunks.some((chunk) =>
        chunk.content.startsWith("[reconcile.failed]")
      )
    ).toBe(false);
  });

  it("F9: a PERMANENT failure still explains itself durably, and the write is flushed", async () => {
    // The explanation used to be a floating `void recordStreamChunks(...)` fired
    // from a synchronous callback: on runner shutdown — exactly when a wake is
    // most likely to fail — the one chunk telling the human why continuation
    // stopped could be lost. The fake defers its write by a macrotask, so a
    // floating promise would not have landed by the time reconcile resolves.
    const brain = fakeBrain({ tier: "agent" });
    brain.setStatus("child-docs", "done");
    brain.failEveryEnqueue("Only the human/operator surface may create a root.");
    const reconciler = createRunnerReconciler({
      client: brain.client,
      apiBase: "http://localhost:4000",
      autoContinue: true,
      runningTurns: new Set<string>(),
    });

    await reconciler.reconcile(child(brain, "child-impl"));

    const failure = brain.chunks.find((chunk) =>
      chunk.content.startsWith("[reconcile.failed]")
    );
    expect(failure).toBeDefined();
    expect(failure!.content).toContain("Only the human/operator surface");
    // Bounded: two attempts, never a retry loop.
    expect(brain.enqueueAttempts).toBe(2);
  });

  it("F7: the wake runs on the MISSION's lane, model, effort and Full-Auto block", async () => {
    // The desktop's event turn has always passed vendor/model/effort/fullAuto;
    // the runner's passed none. That was invisible while every runner wake
    // 403'd. Now that they land, a wake would have run on the DEFAULT lane —
    // not the mission's coordinator — and, worse, WITHOUT the Full-Auto safety
    // block while its gates were still being auto-approved.
    const previous = process.env.MUON_FULL_AUTO;
    process.env.MUON_FULL_AUTO = "1";
    try {
      const brain = fakeBrain({ tier: "agent" });
      brain.setStatus("child-docs", "done");
      // This mission's coordinator is codex, NOT the default lane.
      brain.setRootVendor("codex");
      brain.setRootModel("gpt-5-codex");
      brain.setRootEffort("high");
      const reconciler = createRunnerReconciler({
        client: brain.client,
        apiBase: "http://localhost:4000",
        autoContinue: true,
        runningTurns: new Set<string>(),
      });

      expect(await reconciler.reconcile(child(brain, "child-impl"))).toBe("nudged");

      const dispatched = brain.rootDispatches[0]!;
      expect(dispatched.vendor).toBe("codex");
      expect(dispatched.model).toBe("gpt-5-codex");
      expect(dispatched.action).toBe("effort");
      expect(dispatched.actionArgs).toEqual(["high"]);
      expect(dispatched.brief).toContain("FULL-AUTO MODE ACTIVE");
    } finally {
      if (previous === undefined) delete process.env.MUON_FULL_AUTO;
      else process.env.MUON_FULL_AUTO = previous;
    }
  });

  it("F7: with Full-Auto OFF the wake brief is byte-identical to before", async () => {
    const previous = process.env.MUON_FULL_AUTO;
    delete process.env.MUON_FULL_AUTO;
    try {
      const brain = fakeBrain({ tier: "agent" });
      brain.setStatus("child-docs", "done");
      const reconciler = createRunnerReconciler({
        client: brain.client,
        apiBase: "http://localhost:4000",
        autoContinue: true,
        runningTurns: new Set<string>(),
      });

      await reconciler.reconcile(child(brain, "child-impl"));

      expect(brain.rootBriefs[0]!).not.toContain("FULL-AUTO MODE ACTIVE");
      // No model/effort on the mission root → none forced onto the wake.
      expect(brain.rootDispatches[0]!.model).toBeUndefined();
      expect(brain.rootDispatches[0]!.action).toBeUndefined();
    } finally {
      if (previous !== undefined) process.env.MUON_FULL_AUTO = previous;
    }
  });

  it("F2: a SECOND mission's roster names only its OWN children", async () => {
    // A chat outlives a mission. Scoping the roster by chatId alone made
    // mission 2's summary re-report mission 1's children as if they were this
    // mission's work — and put the OLDEST rows in the paged window, so a long
    // chat's newest mission could be crowded out of its own roster entirely.
    const brain = fakeBrain({ tier: "agent" });
    brain.setStatus("child-docs", "done");
    brain.addMissionRoot("job-root-2");
    brain.addChild("m2-impl", "done", "job-root-2");
    brain.addChild("m2-review", "done", "job-root-2");
    const reconciler = createRunnerReconciler({
      client: brain.client,
      apiBase: "http://localhost:4000",
      autoContinue: true,
      runningTurns: new Set<string>(),
    });

    expect(await reconciler.reconcile(child(brain, "m2-review"))).toBe("nudged");

    const brief = brain.rootBriefs[0]!;
    expect(brief).toContain("m2-review");
    expect(brief).toContain("m2-impl");
    // Mission 1's children are NOT this mission's work.
    expect(brief).not.toContain("child-impl");
    expect(brief).not.toContain("child-docs");
  });

  it("F2: a ZOMBIE child of an abandoned mission cannot block THIS mission's summary", async () => {
    // The structural failure: one stuck `queued` child anywhere in the chat's
    // history kept live > 0 forever, so `nothing is runnable` never became true
    // and the final summary was unreachable for the life of the chat.
    const brain = fakeBrain({ tier: "agent" });
    brain.setStatus("child-impl", "queued"); // mission 1, abandoned mid-flight
    brain.setStatus("child-docs", "queued");
    brain.addMissionRoot("job-root-2");
    brain.addChild("m2-only", "done", "job-root-2");
    const reconciler = createRunnerReconciler({
      client: brain.client,
      apiBase: "http://localhost:4000",
      autoContinue: true,
      runningTurns: new Set<string>(),
    });

    expect(await reconciler.reconcile(child(brain, "m2-only"))).toBe("nudged");

    expect(brain.rootBriefs[0]!).toContain('"live":0');
    expect(
      brain.chunks.some((chunk) =>
        chunk.content.startsWith("FINAL MISSION SUMMARY")
      )
    ).toBe(true);
  });

  it("F1: a 3-child mission plus its queued reviewer still reaches the final summary", async () => {
    // The reviewer's scenario. The cap counted TERMINAL EVENTS, not turns, so a
    // realistic crew (3 implementers, then the sequential reviewer) spent its
    // whole budget on the children and the reviewer's wake — the one that had
    // to post the summary — fell off the end as an affordance.
    const brain = fakeBrain({ tier: "agent" });
    const reconciler = createRunnerReconciler({
      client: brain.client,
      apiBase: "http://localhost:4000",
      autoContinue: true,
      runningTurns: new Set<string>(),
    });
    brain.addChild("child-a", "done");
    brain.addChild("child-b", "done");
    brain.setStatus("child-docs", "done");

    const outcomes = [
      await reconciler.reconcile(child(brain, "child-impl")),
      await reconciler.reconcile(child(brain, "child-a")),
      await reconciler.reconcile(child(brain, "child-b")),
    ];
    // Wave 2: the reviewer the coordinator had queued behind them.
    brain.addChild("child-review", "done");
    outcomes.push(await reconciler.reconcile(child(brain, "child-review")));

    expect(outcomes).toEqual(["nudged", "nudged", "nudged", "nudged"]);
    const summary = brain.chunks.find((chunk) =>
      chunk.content.startsWith("FINAL MISSION SUMMARY")
    );
    expect(summary).toBeDefined();
    expect(summary!.content).toContain("verdict: mission complete");
  });

  it("F1: an INTERRUPTED child files its gate without spending a turn", async () => {
    // A gate runs no turn at all, so it must not consume turn budget. It used
    // to write the same counted milestone a nudge does.
    const brain = fakeBrain({ tier: "agent" });
    const reconciler = createRunnerReconciler({
      client: brain.client,
      apiBase: "http://localhost:4000",
      autoContinue: true,
      runningTurns: new Set<string>(),
    });
    brain.addChild("child-killed", "interrupted");
    brain.addChild("child-a", "done");
    brain.addChild("child-b", "done");
    brain.setStatus("child-docs", "done");

    expect(await reconciler.reconcile(child(brain, "child-killed"))).toBe("gated");
    const outcomes = [
      await reconciler.reconcile(child(brain, "child-impl")),
      await reconciler.reconcile(child(brain, "child-a")),
      await reconciler.reconcile(child(brain, "child-b")),
      await reconciler.reconcile(child(brain, "child-docs")),
    ];

    // The gate cost nothing: all four certain children still got their turn.
    expect(outcomes).toEqual(["nudged", "nudged", "nudged", "nudged"]);
  });

  it("F1: the cap still halts a pathological loop", async () => {
    const brain = fakeBrain({ tier: "agent" });
    const reconciler = createRunnerReconciler({
      client: brain.client,
      apiBase: "http://localhost:4000",
      autoContinue: true,
      runningTurns: new Set<string>(),
    });
    const ids = Array.from({ length: 10 }, (_, i) => `child-loop-${i}`);
    for (const id of ids) brain.addChild(id, "done");

    const outcomes = [];
    for (const id of ids) outcomes.push(await reconciler.reconcile(child(brain, id)));

    // Bounded, and bounded at exactly the cap — never "however many children".
    expect(outcomes.filter((o) => o === "nudged")).toHaveLength(AUTO_CONTINUE_CAP);
    expect(outcomes.slice(AUTO_CONTINUE_CAP)).toEqual(
      Array.from({ length: ids.length - AUTO_CONTINUE_CAP }, () => "affordance")
    );
    expect(brain.rootBriefs).toHaveLength(AUTO_CONTINUE_CAP);
  });

  it("stays inside AUTO_CONTINUE_CAP: a terminal child past the cap gets the affordance", async () => {
    // Bounded-surface rule: the continuation added here is capped BY
    // CONSTRUCTION, because it rides the same durable per-chat counter every
    // other auto-turn does. No new kind, no separate budget.
    const brain = fakeBrain({ tier: "agent" });
    const reconciler = createRunnerReconciler({
      client: brain.client,
      apiBase: "http://localhost:4000",
      autoContinue: true,
      runningTurns: new Set<string>(),
    });
    const ids = Array.from({ length: AUTO_CONTINUE_CAP + 1 }, (_, i) => `child-${i}`);
    for (const id of ids) brain.addChild(id, "done");

    const outcomes = [];
    for (const id of ids) outcomes.push(await reconciler.reconcile(child(brain, id)));

    expect(outcomes.at(-1)).toBe("affordance");
    expect(brain.rootBriefs).toHaveLength(AUTO_CONTINUE_CAP);
  });
});
