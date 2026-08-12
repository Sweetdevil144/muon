import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStateStore,
  openPane,
  reducePanes,
  type StoreSnapshot,
} from "../src/lib/state-store.js";
import {
  SUBAGENT_TAB_CAP,
  TAB_CLOSE_GRACE_MS,
} from "../src/lib/subagent-tabs.js";
import type { DesktopState } from "../src/shared/ipc.js";
import type { DispatchJobRecord } from "@muon/client";

function agent(id: string, status: string, currentJobId: string | null = id) {
  return { id, status, currentJobId };
}

function stateWith(
  agents: { id: string; status: string; currentJobId?: string | null }[],
  dispatchJobs: DispatchJobRecord[] = []
): DesktopState {
  return {
    online: true,
    lastError: null,
    settings: { apiBase: "http://localhost:4000" },
    fleet: {
      counts: {},
      agents: agents.map((entry, index) => ({
        id: entry.id,
        vendor: "claude-code",
        name: `claude-${index + 1}`,
        ordinal: index + 1,
        status: entry.status,
        currentJobId: entry.currentJobId,
      })),
    },
    chats: [],
    approvals: [],
    tasks: [],
    dispatchJobs,
  };
}

function subagentJob(
  id: string,
  status: string,
  overrides: Partial<DispatchJobRecord> = {}
): DispatchJobRecord {
  return {
    id,
    kind: "session",
    vendor: "codex",
    taskId: "task-1",
    brief: "b",
    status,
    dispatchedBy: "orchestrator",
    interruptRequested: false,
    steerMessages: [],
    capabilityMode: "delegate",
    agentId: `agent-${id}`,
    createdAt: "2026-07-16T10:00:00.000Z",
    ...overrides,
  } as DispatchJobRecord;
}

describe("reducePanes", () => {
  it("never auto-opens on the first poll, even for working agents", () => {
    expect(
      reducePanes({ open: [], previous: null, next: [agent("a", "working")] })
    ).toEqual([]);
  });

  it("auto-opens agents that transition to working", () => {
    const previous = [agent("a", "idle"), agent("b", "idle")];
    const next = [agent("a", "working"), agent("b", "idle")];
    expect(reducePanes({ open: [], previous, next })).toEqual(["a"]);
  });

  it("does not reopen an already-open or still-working agent", () => {
    const previous = [agent("a", "working")];
    const next = [agent("a", "working")];
    expect(reducePanes({ open: ["a"], previous, next })).toEqual(["a"]);
    expect(reducePanes({ open: [], previous, next })).toEqual([]);
  });

  it("keys panes by job so a reused agent slot cannot merge two chats' streams", () => {
    const previous = [agent("agent-a", "working", "job-old")];
    const next = [agent("agent-a", "working", "job-new")];
    expect(
      reducePanes({
        open: ["job-old"],
        previous,
        next,
        aliveJobIds: new Set(["job-old", "job-new"]),
      })
    ).toEqual(["job-old", "job-new"]);
  });

  it("caps at 3 panes, evicting the oldest", () => {
    const previous = [
      agent("a", "working"),
      agent("b", "working"),
      agent("c", "working"),
      agent("d", "idle"),
    ];
    const next = [
      agent("a", "working"),
      agent("b", "working"),
      agent("c", "working"),
      agent("d", "working"),
    ];
    expect(reducePanes({ open: ["a", "b", "c"], previous, next })).toEqual([
      "b",
      "c",
      "d",
    ]);
  });

  it("closes panes whose agents no longer exist", () => {
    expect(
      reducePanes({
        open: ["gone", "a"],
        previous: [agent("a", "working")],
        next: [agent("a", "working")],
      })
    ).toEqual(["a"]);
  });
});

describe("openPane", () => {
  it("adds as newest, dedupes, and evicts oldest past the cap", () => {
    expect(openPane([], "a")).toEqual(["a"]);
    expect(openPane(["a", "b"], "a")).toEqual(["b", "a"]);
    expect(openPane(["a", "b", "c"], "d")).toEqual(["b", "c", "d"]);
  });
});

describe("createStateStore", () => {
  it("emits state and auto-opens panes on working transitions across ticks", async () => {
    const responses = [
      stateWith([agent("agent-a", "idle", "job-a")], [
        subagentJob("job-a", "queued", { agentId: "agent-a" }),
      ]),
      stateWith([agent("agent-a", "working", "job-a")], [
        subagentJob("job-a", "running", { agentId: "agent-a" }),
      ]),
    ];
    let call = 0;
    const snapshots: StoreSnapshot[] = [];
    const store = createStateStore({
      fetchState: async () => responses[Math.min(call++, responses.length - 1)]!,
      onChange: (snapshot) => snapshots.push(snapshot),
    });

    await store.tick();
    expect(snapshots[0]?.state?.online).toBe(true);
    expect(snapshots[0]?.panes).toEqual([]);

    await store.tick();
    expect(snapshots[1]?.panes).toEqual(["job-a"]);
  });

  it("keeps the last good state and reports the error on a failed poll", async () => {
    let fail = false;
    const snapshots: StoreSnapshot[] = [];
    const store = createStateStore({
      fetchState: async () => {
        if (fail) {
          throw new Error("ECONNREFUSED");
        }
        return stateWith([]);
      },
      onChange: (snapshot) => snapshots.push(snapshot),
    });

    await store.tick();
    fail = true;
    await store.tick();

    expect(snapshots[1]?.state).not.toBeNull();
    expect(snapshots[1]?.error).toContain("ECONNREFUSED");

    fail = false;
    await store.tick();
    expect(snapshots[2]?.error).toBeNull();
  });

  it("supports manual open (dedupe) and close", async () => {
    const snapshots: StoreSnapshot[] = [];
    const store = createStateStore({
      fetchState: async () =>
        stateWith([agent("a", "working"), agent("b", "working")]),
      onChange: (snapshot) => snapshots.push(snapshot),
    });
    await store.tick();

    store.openPane("a");
    store.openPane("b");
    store.openPane("a");
    expect(snapshots.at(-1)?.panes).toEqual(["b", "a"]);

    store.closePane("b");
    expect(snapshots.at(-1)?.panes).toEqual(["a"]);
  });

  it("does not apply the pane cap across chats in the shared store", async () => {
    const snapshots: StoreSnapshot[] = [];
    const store = createStateStore({
      fetchState: async () => stateWith([]),
      onChange: (snapshot) => snapshots.push(snapshot),
    });
    await store.tick();

    store.openPane("chat-a-job");
    store.openPane("chat-b-job-1");
    store.openPane("chat-b-job-2");
    store.openPane("chat-b-job-3");

    expect(snapshots.at(-1)?.panes).toEqual([
      "chat-a-job",
      "chat-b-job-1",
      "chat-b-job-2",
      "chat-b-job-3",
    ]);
  });

  describe("interval polling", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("polls immediately and then on the interval; stop halts it", async () => {
      const fetchState = vi.fn(async () => stateWith([]));
      const store = createStateStore({ fetchState, onChange: () => undefined });

      store.start(2000);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchState).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4100);
      expect(fetchState).toHaveBeenCalledTimes(3);

      store.stop();
      await vi.advanceTimersByTimeAsync(6000);
      expect(fetchState).toHaveBeenCalledTimes(3);
    });
  });
});

// ── Task #124: subagent workspace tabs ───────────────────────────────────────
describe("createStateStore subagent tabs", () => {
  it("starts empty and opens a tab the moment a dispatched job appears on poll", async () => {
    const snapshots: StoreSnapshot[] = [];
    const store = createStateStore({
      fetchState: async () => stateWith([], [subagentJob("job-1", "running")]),
      onChange: (snapshot) => snapshots.push(snapshot),
    });
    await store.tick();
    expect(snapshots[0]?.tabs).toEqual([
      {
        jobId: "job-1",
        agentId: "agent-job-1",
        vendor: "codex",
        status: "running",
        pendingCloseAt: null,
        pinned: false,
      },
    ]);
  });

  it("never opens a tab for the orchestrator's own job", async () => {
    const snapshots: StoreSnapshot[] = [];
    const store = createStateStore({
      fetchState: async () =>
        stateWith(
          [],
          [subagentJob("root", "running", { capabilityMode: "orchestrator" })]
        ),
      onChange: (snapshot) => snapshots.push(snapshot),
    });
    await store.tick();
    expect(snapshots[0]?.tabs).toEqual([]);
  });

  it("supports manual openTab/closeTab, and closeTab suppresses reopening on the next poll", async () => {
    const jobs = [subagentJob("job-1", "running")];
    const snapshots: StoreSnapshot[] = [];
    const store = createStateStore({
      fetchState: async () => stateWith([], jobs),
      onChange: (snapshot) => snapshots.push(snapshot),
    });
    await store.tick();
    expect(snapshots.at(-1)?.tabs).toHaveLength(1);

    store.closeTab("job-1");
    expect(snapshots.at(-1)?.tabs).toEqual([]);

    // Still running on the NEXT poll — a dismissed tab must not resurrect.
    await store.tick();
    expect(snapshots.at(-1)?.tabs).toEqual([]);

    // An explicit re-open always wins over the dismissal.
    store.openTab({
      id: "job-1",
      agentId: "agent-job-1",
      vendor: "codex",
      status: "running",
      capabilityMode: "delegate",
    });
    expect(snapshots.at(-1)?.tabs).toEqual([
      {
        jobId: "job-1",
        agentId: "agent-job-1",
        vendor: "codex",
        status: "running",
        pendingCloseAt: null,
        // Manual open PINS — Fix B (see the dedicated describe block below).
        pinned: true,
      },
    ]);
  });

  // FIX C: the store's app-wide tab list must NOT be capped — an app-wide
  // SUBAGENT_TAB_CAP-sized slice would truncate ACROSS every chat, evicting
  // one chat's own tabs because of an unrelated chat's fan-out. The real
  // cap is enforced PER-CHAT by app.tsx, downstream, after it narrows this
  // list to the active chat (see subagent-tabs.test.ts's "FIX C: per-chat
  // capping" for the narrowing+cap behavior itself).
  it("FIX C: does NOT cap the app-wide tab list by default — all dispatched jobs' tabs are present, uncapped", async () => {
    const jobs = Array.from({ length: 9 }, (_, i) =>
      subagentJob(`job-${i + 1}`, "running")
    );
    const snapshots: StoreSnapshot[] = [];
    const store = createStateStore({
      fetchState: async () => stateWith([], jobs),
      onChange: (snapshot) => snapshots.push(snapshot),
    });
    await store.tick();
    const ids = snapshots.at(-1)?.tabs.map((tab) => tab.jobId);
    expect(ids).toHaveLength(9);
    expect(ids).toContain("job-1");
    expect(ids).toContain("job-9");
  });

  it("still honors an explicit tabCap override (test/back-compat knob) when one IS passed", async () => {
    const jobs = Array.from({ length: 9 }, (_, i) =>
      subagentJob(`job-${i + 1}`, "running")
    );
    const snapshots: StoreSnapshot[] = [];
    const store = createStateStore({
      fetchState: async () => stateWith([], jobs),
      onChange: (snapshot) => snapshots.push(snapshot),
      tabCap: SUBAGENT_TAB_CAP,
    });
    await store.tick();
    const ids = snapshots.at(-1)?.tabs.map((tab) => tab.jobId);
    expect(ids).toHaveLength(SUBAGENT_TAB_CAP);
    expect(ids).not.toContain("job-1");
  });

  // ── FIX A / FIX B integration: the actual production path (createStateStore
  // driving reduceSubagentTabs on a real clock via Date.now()) ─────────────
  describe("FIX A / FIX B integration", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("FIX A: a cleanly-done tab auto-closes past grace and never resurrects on later polls", async () => {
      vi.setSystemTime(0);
      const doneJob = subagentJob("job-1", "done");
      const snapshots: StoreSnapshot[] = [];
      const store = createStateStore({
        fetchState: async () => stateWith([], [doneJob]),
        onChange: (snapshot) => snapshots.push(snapshot),
      });

      await store.tick(); // t=0: opens already-done, pendingCloseAt=0
      expect(snapshots.at(-1)?.tabs).toHaveLength(1);

      vi.setSystemTime(TAB_CLOSE_GRACE_MS); // t=5000: grace elapses
      await store.tick();
      expect(snapshots.at(-1)?.tabs).toEqual([]); // auto-closed

      // The done job is STILL in state.dispatchJobs (main.ts keeps
      // newest-24, no status filter) — this is exactly what used to
      // resurrect the tab.
      vi.setSystemTime(TAB_CLOSE_GRACE_MS + 2_000); // t=7000
      await store.tick();
      expect(snapshots.at(-1)?.tabs).toEqual([]); // must NOT resurrect

      vi.setSystemTime(TAB_CLOSE_GRACE_MS + 60_000);
      await store.tick();
      expect(snapshots.at(-1)?.tabs).toEqual([]); // stays closed indefinitely
    });

    it("FIX B: a manually-opened done tab survives a follow-up poll instead of being re-armed and yanked away", async () => {
      vi.setSystemTime(0);
      const doneJob = subagentJob("job-1", "done");
      const snapshots: StoreSnapshot[] = [];
      const store = createStateStore({
        fetchState: async () => stateWith([], [doneJob]),
        onChange: (snapshot) => snapshots.push(snapshot),
      });

      await store.tick(); // t=0: opens already-done, pendingCloseAt=0
      // A human opens/reopens it to review the result — pins it.
      store.openTab({
        id: "job-1",
        agentId: "agent-job-1",
        vendor: "codex",
        status: "done",
        capabilityMode: "delegate",
      });
      expect(snapshots.at(-1)?.tabs[0]?.pinned).toBe(true);
      expect(snapshots.at(-1)?.tabs[0]?.pendingCloseAt).toBeNull();

      // Well past what would have been the grace window — a poll must NOT
      // re-arm pendingCloseAt (null ?? now) and yank the tab away.
      vi.setSystemTime(TAB_CLOSE_GRACE_MS + 1_000);
      await store.tick();
      expect(snapshots.at(-1)?.tabs).toHaveLength(1);
      expect(snapshots.at(-1)?.tabs[0]?.jobId).toBe("job-1");
      expect(snapshots.at(-1)?.tabs[0]?.pendingCloseAt).toBeNull();
    });
  });
});
