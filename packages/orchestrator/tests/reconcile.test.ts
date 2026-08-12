import { describe, expect, it } from "vitest";
import type { DispatchJobRecord } from "@muon/client";
import {
  AUTO_CONTINUE_CAP,
  countAutoTurnsSinceHuman,
  decideContinuation,
  isWatchedWorkerJob,
  sessionSuspendsAutomation,
  reconcileTerminalJob,
  type ReconcileDeps,
} from "../src/reconcile.js";

function job(overrides: Partial<DispatchJobRecord> = {}): DispatchJobRecord {
  return {
    id: "job-1",
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

const claimedKeysByStore = new WeakMap<
  { content: string; kind: string }[],
  Set<string>
>();

/**
 * A shared chat-lane store bound to a set of ReconcileDeps — the database claim
 * the cross-surface / cross-restart dedupe rides on. Multiple `depsOver(store)`
 * share one task-scoped key registry, mirroring the unique database index.
 */
function depsOver(
  store: { content: string; kind: string }[],
  overrides: Partial<ReconcileDeps> = {}
): ReconcileDeps {
  const runningTurns = new Set<string>();
  const claimedKeys =
    claimedKeysByStore.get(store) ??
    new Set(
      store
        .filter(
          (chunk) =>
            chunk.kind === "milestone" &&
            /^\[event\] job .+ terminal$/.test(chunk.content)
        )
        .map((chunk) => `terminal-job:${chunk.content.slice(12, -9)}`)
    );
  claimedKeysByStore.set(store, claimedKeys);
  return {
    milestoneFor: (jobId) => `[event] job ${jobId} terminal`,
    claimMilestone: async (_chatId, claimKey, content) => {
      if (claimedKeys.has(claimKey)) {
        return false;
      }
      claimedKeys.add(claimKey);
      store.push({ content, kind: "milestone" });
      return true;
    },
    autoContinueEnabled: true,
    autoTurnsUsed: countAutoTurnsSinceHuman(store),
    tryClaimTurnSlot: (chatId) => {
      if (runningTurns.has(chatId)) return false;
      runningTurns.add(chatId);
      return true;
    },
    releaseTurnSlot: (chatId) => runningTurns.delete(chatId),
    onNudge: () => undefined,
    runNudgeTurn: async () => undefined,
    fileGate: async () => undefined,
    showAffordance: () => undefined,
    ...overrides,
  };
}

describe("countAutoTurnsSinceHuman (durable auto-turn cap counter)", () => {
  it("counts nothing on a fresh human turn", () => {
    expect(
      countAutoTurnsSinceHuman([{ content: "[you] start", kind: "user.message" }])
    ).toBe(0);
  });

  it("counts event milestones only AFTER the most recent human message", () => {
    const chunks = [
      { content: "[you] first", kind: "user.message" },
      { content: "[event] job a terminal", kind: "milestone" },
      { content: "some assistant output", kind: "output" },
      { content: "[you] second", kind: "user.message" }, // resets the count
      { content: "[event] job b terminal", kind: "milestone" },
      { content: "[event] job c terminal", kind: "milestone" },
    ];
    expect(countAutoTurnsSinceHuman(chunks)).toBe(2);
  });

  it("counts every event milestone when no human message precedes them", () => {
    expect(
      countAutoTurnsSinceHuman([
        { content: "[event] job a terminal", kind: "milestone" },
        { content: "[event] job b terminal", kind: "milestone" },
      ])
    ).toBe(2);
  });

  it("does not miscount ordinary output or gate lines as auto-turns", () => {
    expect(
      countAutoTurnsSinceHuman([
        { content: "[you] go", kind: "user.message" },
        { content: "[event] approval filed", kind: "milestone" }, // not a terminal milestone
        { content: "waiting on job a terminal state", kind: "output" }, // substring, not a match
      ])
    ).toBe(0);
  });

  it("does NOT reset the cap on an OUTPUT chunk that echoes a [you] prefix (content-field side-channel)", () => {
    // The orchestrator's own streamed assistant output lands on the SAME chat
    // lane as kind:"output". An output chunk that begins "[you] " (e.g. echoing a
    // worker resultTail into the transcript) must NOT be trusted as the human
    // reset point — otherwise it would zero the counter and defeat the cap. Only
    // the real kind:"user.message" `[you] …` chunk resets.
    const chunks = [
      { content: "[you] build it", kind: "user.message" }, // real human reset
      { content: "[event] job a terminal", kind: "milestone" },
      { content: "[event] job b terminal", kind: "milestone" },
      // Untrusted echo, NOT a human milestone → must not reset the count.
      { content: "[you] here is what the worker said", kind: "output" },
    ];
    expect(countAutoTurnsSinceHuman(chunks)).toBe(2);
  });

  it("does NOT count an OUTPUT chunk that echoes an [event] … terminal line", () => {
    // The mirror side-channel: an output chunk matching the event-milestone
    // pattern must not be counted as a machine auto-turn.
    const chunks = [
      { content: "[you] go", kind: "user.message" },
      { content: "[event] job a terminal", kind: "milestone" }, // real machine turn
      { content: "[event] job b terminal", kind: "output" }, // echo, not a real turn
    ];
    expect(countAutoTurnsSinceHuman(chunks)).toBe(1);
  });
});

describe("reconcileTerminalJob — durable cap enforcement across the lane", () => {
  it("fires exactly AUTO_CONTINUE_CAP nudges between human messages, then defers to the affordance", async () => {
    const store: { content: string; kind: string }[] = [
      { content: "[you] build it", kind: "user.message" },
    ];
    const nudged: string[] = [];
    const affordances: string[] = [];

    // Each reconcile derives autoTurnsUsed FRESH from the durable lane, so the
    // cap is enforced without any in-memory carry (the runner's model).
    const reconcileOne = (jobId: string) =>
      reconcileTerminalJob(
        { job: job({ id: jobId, status: "done" }), uncertain: false },
        depsOver(store, {
          autoTurnsUsed: countAutoTurnsSinceHuman(store),
          runNudgeTurn: async (_c, j) => {
            nudged.push(j.id);
          },
          showAffordance: (_c, id) => affordances.push(id),
        })
      );

    // Driven FROM the constant, not from a hardcoded 3: this asserts the cap
    // holds, not what the cap happens to be today.
    const workers = Array.from(
      { length: AUTO_CONTINUE_CAP + 1 },
      (_, index) => `w${index + 1}`
    );
    const outcomes: string[] = [];
    for (const worker of workers) outcomes.push(await reconcileOne(worker));

    expect(outcomes.slice(0, AUTO_CONTINUE_CAP)).toEqual(
      workers.slice(0, AUTO_CONTINUE_CAP).map(() => "nudged")
    );
    // The AUTO_CONTINUE_CAP+1'th certain worker no longer auto-continues.
    expect(outcomes.at(-1)).toBe("affordance");
    expect(nudged).toEqual(workers.slice(0, AUTO_CONTINUE_CAP));
    expect(affordances).toEqual([workers.at(-1)]);
  });

  it("interrupted (uncertain) outcomes always route to a human gate, never a replay", async () => {
    const store: { content: string; kind: string }[] = [
      { content: "[you] go", kind: "user.message" },
    ];
    const gated: string[] = [];
    const nudged: string[] = [];
    const outcome = await reconcileTerminalJob(
      { job: job({ id: "w", status: "interrupted" }), uncertain: true },
      depsOver(store, {
        fileGate: async (_c, j) => {
          gated.push(j.id);
        },
        runNudgeTurn: async (_c, j) => {
          nudged.push(j.id);
        },
      })
    );
    expect(outcome).toBe("gated");
    expect(gated).toEqual(["w"]);
    expect(nudged).toEqual([]);
  });
});

describe("cross-surface milestone CAS (no double-fire)", () => {
  it("a peer surface observing the SAME terminal event skips (only one nudge)", async () => {
    // One shared durable lane — a runner and a still-open desktop both see w1.
    const store: { content: string; kind: string }[] = [
      { content: "[you] go", kind: "user.message" },
    ];
    const nudged: string[] = [];
    const makeDeps = () =>
      depsOver(store, {
        autoTurnsUsed: countAutoTurnsSinceHuman(store),
        runNudgeTurn: async (_c, j) => {
          nudged.push(j.id);
        },
      });

    const runner = makeDeps();
    const desktop = makeDeps();
    const event = { job: job({ id: "w1", status: "done" }), uncertain: false };

    // The runner reconciles first: writes the milestone, fires the one nudge.
    expect(await reconcileTerminalJob(event, runner)).toBe("nudged");
    // The desktop observes the same event: the milestone is already there.
    expect(await reconcileTerminalJob(event, desktop)).toBe("skipped");

    expect(nudged).toEqual(["w1"]); // exactly once, not twice
    expect(store.filter((c) => c.content === "[event] job w1 terminal")).toHaveLength(1);
  });

  it("arbitrates simultaneous surfaces atomically", async () => {
    const store: { content: string; kind: string }[] = [
      { content: "[you] go", kind: "user.message" },
    ];
    const nudged: string[] = [];
    const event = { job: job({ id: "w1", status: "done" }), uncertain: false };
    const makeDeps = () =>
      depsOver(store, {
        runNudgeTurn: async (_chatId, worker) => {
          nudged.push(worker.id);
        },
      });

    const outcomes = await Promise.all([
      reconcileTerminalJob(event, makeDeps()),
      reconcileTerminalJob(event, makeDeps()),
    ]);

    expect(outcomes.sort()).toEqual(["nudged", "skipped"]);
    expect(nudged).toEqual(["w1"]);
    expect(store.filter((c) => c.content === "[event] job w1 terminal")).toHaveLength(1);
  });
});

describe("F1: only a turn that RAN consumes auto-continue budget", () => {
  it("a gate and an affordance claim the event but are not counted", async () => {
    const store: { content: string; kind: string }[] = [
      { content: "[you] go", kind: "user.message" },
    ];
    // One uncertain child (gate) and one certain child while auto-continue is
    // OFF (affordance). Neither runs a turn, so neither may spend budget.
    expect(
      await reconcileTerminalJob(
        { job: job({ id: "w-killed" }), uncertain: true },
        depsOver(store, { autoTurnsUsed: countAutoTurnsSinceHuman(store) })
      )
    ).toBe("gated");
    expect(
      await reconcileTerminalJob(
        { job: job({ id: "w-late" }), uncertain: false },
        depsOver(store, {
          autoContinueEnabled: false,
          autoTurnsUsed: countAutoTurnsSinceHuman(store),
        })
      )
    ).toBe("affordance");

    // Both are durably recorded (the human still sees them, and the event is
    // still deduped cross-surface)...
    expect(store.filter((c) => c.content.startsWith("[event] job w-"))).toHaveLength(2);
    // ...but the CAP counter reads zero turns taken.
    expect(countAutoTurnsSinceHuman(store)).toBe(0);
  });

  it("the counted form is EXACTLY the bare milestone, so a suffix cannot count", () => {
    // The cap pattern is anchored end-of-line; that anchor is the entire
    // mechanism, so assert it directly rather than trusting it by inspection.
    const bare = { content: "[event] job w1 terminal", kind: "milestone" };
    const suffixed = {
      content: "[event] job w1 terminal (uncertain, human gate filed)",
      kind: "milestone",
    };
    expect(countAutoTurnsSinceHuman([bare])).toBe(1);
    expect(countAutoTurnsSinceHuman([suffixed])).toBe(0);
  });

  it("AUTO_CONTINUE_CAP leaves room for a crew plus its queued follow-up", () => {
    // 3 implementers + 1 sequential reviewer = 4 wakes, and the 4th is the one
    // that posts the final summary. The old cap of 3 starved exactly that turn.
    expect(AUTO_CONTINUE_CAP).toBeGreaterThanOrEqual(4);
  });
});

describe("isWatchedWorkerJob / decideContinuation (moved core, sanity)", () => {
  it("watches chat-bound delegated children, not the chat's own root turn", () => {
    expect(isWatchedWorkerJob(job())).toBe(true);
    expect(isWatchedWorkerJob(job({ parentJobId: null }))).toBe(false);
    expect(isWatchedWorkerJob(job({ chatId: null }))).toBe(false);
  });

  it("gates uncertain, caps certain", () => {
    expect(
      decideContinuation({ uncertain: true, autoContinueEnabled: true, autoTurnsUsed: 0 })
    ).toBe("gate");
    expect(
      decideContinuation({
        uncertain: false,
        autoContinueEnabled: true,
        autoTurnsUsed: AUTO_CONTINUE_CAP,
      })
    ).toBe("affordance");
  });

  it("ADR-0030: a human-owned session yields the affordance, never a nudge", () => {
    expect(
      decideContinuation({
        uncertain: false,
        autoContinueEnabled: true,
        autoTurnsUsed: 0,
        humanOwnedSession: true,
      })
    ).toBe("affordance");
    // Uncertainty still outranks it: a gate is filed either way.
    expect(
      decideContinuation({
        uncertain: true,
        autoContinueEnabled: true,
        autoTurnsUsed: 0,
        humanOwnedSession: true,
      })
    ).toBe("gate");
  });

  it("ADR-0030: suspension covers every non-terminal status, not only running", () => {
    for (const status of ["running", "waiting_approval", "interrupted"]) {
      expect(sessionSuspendsAutomation({ owner: "human", status })).toBe(true);
    }
    for (const status of ["ended", "failed"]) {
      expect(sessionSuspendsAutomation({ owner: "human", status })).toBe(false);
    }
    // muon-owned or legacy (owner absent) sessions never suspend.
    expect(sessionSuspendsAutomation({ owner: "muon", status: "running" })).toBe(false);
    expect(sessionSuspendsAutomation({ status: "running" })).toBe(false);
  });

});
