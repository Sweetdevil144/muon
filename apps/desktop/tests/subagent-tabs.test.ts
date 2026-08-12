import { describe, expect, it } from "vitest";
import {
  capVisibleSubagentTabs,
  closeSubagentTab,
  openSubagentTab,
  reduceSubagentTabs,
  selectSubagentJobs,
  SUBAGENT_TAB_CAP,
  TAB_CLOSE_GRACE_MS,
  type SubagentTab,
  type WatchedJob,
} from "../src/lib/subagent-tabs.js";

function job(
  id: string,
  status: string,
  overrides: Partial<WatchedJob> = {}
): WatchedJob {
  return {
    id,
    agentId: `agent-${id}`,
    vendor: "codex",
    status,
    capabilityMode: "delegate",
    ...overrides,
  };
}

/** Most tests only care about the resulting tab list, not the auxiliary
 *  `autoDismissed` bookkeeping (see the FIX-A-specific tests below for
 *  that) — this pulls `.tabs` out of `reduceSubagentTabs`'s
 *  `{ tabs, autoDismissed }` result so assertions read the same as a plain
 *  reducer call. */
function reduce(input: Parameters<typeof reduceSubagentTabs>[0]): SubagentTab[] {
  return reduceSubagentTabs(input).tabs;
}

describe("selectSubagentJobs", () => {
  it("excludes the orchestrator's own job (that job IS the mission chat)", () => {
    const jobs = [
      job("root", "running", { capabilityMode: "orchestrator" }),
      job("worker-1", "running"),
      job("worker-2", "queued", { capabilityMode: "worker" }),
    ];
    expect(selectSubagentJobs(jobs).map((j) => j.id)).toEqual([
      "worker-1",
      "worker-2",
    ]);
  });

  it("keeps a job with no capabilityMode (legacy row) — only an explicit 'orchestrator' excludes", () => {
    const jobs = [job("legacy", "running", { capabilityMode: undefined })];
    expect(selectSubagentJobs(jobs).map((j) => j.id)).toEqual(["legacy"]);
  });
});

describe("capVisibleSubagentTabs", () => {
  it("keeps pinned and failure tabs stable while trimming only ordinary overflow", () => {
    const tabs = Array.from({ length: 10 }, (_, index) => ({
      jobId: `job-${index + 1}`,
      agentId: `agent-${index + 1}`,
      vendor: "codex",
      status:
        index === 1 ? "failed" : index === 2 ? "interrupted" : "running",
      pendingCloseAt: null,
      pinned: index === 0,
    })) satisfies SubagentTab[];

    const visible = capVisibleSubagentTabs(tabs, 4);
    expect(visible.map((tab) => tab.jobId)).toEqual([
      "job-1",
      "job-2",
      "job-3",
      "job-10",
    ]);
  });

  it("allows protected tabs past the nominal cap instead of hiding evidence", () => {
    const protectedTabs = Array.from({ length: 3 }, (_, index) => ({
      jobId: `protected-${index}`,
      agentId: null,
      vendor: "codex",
      status: "failed",
      pendingCloseAt: null,
      pinned: false,
    })) satisfies SubagentTab[];

    expect(capVisibleSubagentTabs(protectedTabs, 2)).toEqual(protectedTabs);
  });
});

describe("reduceSubagentTabs", () => {
  it("opens a tab the moment a watched job appears — no first-poll hold-back", () => {
    const next = reduce({
      open: [],
      jobs: [job("worker-1", "running")],
      now: 1000,
    });
    expect(next).toEqual([
      {
        jobId: "worker-1",
        agentId: "agent-worker-1",
        vendor: "codex",
        status: "running",
        pendingCloseAt: null,
        pinned: false,
      },
    ]);
  });

  it("never opens a tab for the orchestrator's own job", () => {
    const next = reduce({
      open: [],
      jobs: [job("root", "running", { capabilityMode: "orchestrator" })],
      now: 1000,
    });
    expect(next).toEqual([]);
  });

  it("opens tabs for queued jobs too — not just running", () => {
    const next = reduce({
      open: [],
      jobs: [job("worker-1", "queued")],
      now: 1000,
    });
    expect(next.map((tab) => tab.status)).toEqual(["queued"]);
  });

  it("marks a 'done' job pendingCloseAt and auto-removes it once the grace elapses", () => {
    const opened = reduce({
      open: [],
      jobs: [job("worker-1", "running")],
      now: 0,
    });
    const doneAt1000 = reduce({
      open: opened,
      jobs: [job("worker-1", "done")],
      now: 1_000,
      graceMs: 5_000,
    });
    expect(doneAt1000).toEqual([
      {
        jobId: "worker-1",
        agentId: "agent-worker-1",
        vendor: "codex",
        status: "done",
        pendingCloseAt: 1_000,
        pinned: false,
      },
    ]);

    // Still within the grace window — stays open, pendingCloseAt unchanged.
    const stillGrace = reduce({
      open: doneAt1000,
      jobs: [job("worker-1", "done")],
      now: 1_000 + TAB_CLOSE_GRACE_MS - 1,
      graceMs: 5_000,
    });
    expect(stillGrace).toHaveLength(1);
    expect(stillGrace[0]?.pendingCloseAt).toBe(1_000);

    // Grace elapsed — auto-removed AND reported via autoDismissed (FIX A: the
    // caller must persist this into its own dismissed set or the very next
    // poll reopens the same job — see the dedicated FIX A test below).
    const afterGrace = reduceSubagentTabs({
      open: doneAt1000,
      jobs: [job("worker-1", "done")],
      now: 1_000 + 5_000,
      graceMs: 5_000,
    });
    expect(afterGrace.tabs).toEqual([]);
    expect(afterGrace.autoDismissed).toEqual(["worker-1"]);
  });

  it("keeps 'failed' tabs open indefinitely — no grace, no auto-close", () => {
    const opened = reduce({
      open: [],
      jobs: [job("worker-1", "running")],
      now: 0,
    });
    const failed = reduce({
      open: opened,
      jobs: [job("worker-1", "failed")],
      now: 1_000,
      graceMs: 5_000,
    });
    expect(failed).toEqual([
      {
        jobId: "worker-1",
        agentId: "agent-worker-1",
        vendor: "codex",
        status: "failed",
        pendingCloseAt: null,
        pinned: false,
      },
    ]);
    // Ticking far past any grace window: still there, untouched.
    const muchLater = reduce({
      open: failed,
      jobs: [job("worker-1", "failed")],
      now: 1_000_000,
      graceMs: 5_000,
    });
    expect(muchLater).toEqual(failed);
  });

  it("keeps 'interrupted' tabs open indefinitely — no grace, no auto-close", () => {
    const opened = reduce({
      open: [],
      jobs: [job("worker-1", "running")],
      now: 0,
    });
    const interrupted = reduce({
      open: opened,
      jobs: [job("worker-1", "interrupted")],
      now: 1_000,
      graceMs: 5_000,
    });
    const muchLater = reduce({
      open: interrupted,
      jobs: [job("worker-1", "interrupted")],
      now: 10_000_000,
      graceMs: 5_000,
    });
    expect(muchLater).toEqual(interrupted);
  });

  it("a human-dismissed job never reopens automatically while still watched", () => {
    reduce({
      open: [],
      jobs: [job("worker-1", "running")],
      now: 0,
    });
    // Human closes it (removed from `open`, added to `dismissed` by the caller
    // — mirrors state-store.ts's closeTab bookkeeping).
    const dismissed = new Set(["worker-1"]);
    const afterClose = reduce({
      open: [],
      jobs: [job("worker-1", "running")],
      now: 1_000,
      dismissed,
    });
    expect(afterClose).toEqual([]);
  });

  it("drops a tab whose job fell out of scope (not present in `jobs` at all) — and does NOT report it as autoDismissed", () => {
    const opened = reduce({
      open: [],
      jobs: [job("worker-1", "running")],
      now: 0,
    });
    const next = reduceSubagentTabs({ open: opened, jobs: [], now: 1_000 });
    expect(next.tabs).toEqual([]);
    // Out-of-scope is not the same as auto-close-suppression: if the job
    // comes back into scope later (e.g. the chat is watched again) it
    // should reopen normally, not stay suppressed.
    expect(next.autoDismissed).toEqual([]);
  });

  it("caps at 8 tabs, evicting the oldest", () => {
    const jobs = Array.from({ length: 9 }, (_, i) => job(`w${i + 1}`, "running"));
    const next = reduce({ open: [], jobs, now: 0 });
    expect(next).toHaveLength(SUBAGENT_TAB_CAP);
    expect(next.map((tab) => tab.jobId)).toEqual([
      "w2",
      "w3",
      "w4",
      "w5",
      "w6",
      "w7",
      "w8",
      "w9",
    ]);
  });

  it("respects a custom cap", () => {
    const jobs = Array.from({ length: 4 }, (_, i) => job(`w${i + 1}`, "running"));
    const next = reduce({ open: [], jobs, now: 0, cap: 2 });
    expect(next.map((tab) => tab.jobId)).toEqual(["w3", "w4"]);
  });

  // ── FIX A: a 'done' tab that auto-closes past grace must NOT resurrect ──
  describe("FIX A: auto-close suppression (no open→dim→drop→reopen flicker)", () => {
    it("a jobId reported in autoDismissed, once persisted by the caller, never resurrects on a later poll — even though the done job stays in `jobs`", () => {
      // Reproduces the adversarial-review trace: t=1000 open (already done),
      // t=6000 grace elapses (dropped + reported), t=6500 must STAY dropped
      // (the old bug reopened it here because nothing suppressed step 2).
      const doneJob = job("worker-1", "done");
      const opened = reduce({ open: [], jobs: [doneJob], now: 1_000 });
      expect(opened).toHaveLength(1);
      expect(opened[0]?.pendingCloseAt).toBe(1_000);

      const graced = reduceSubagentTabs({
        open: opened,
        jobs: [doneJob],
        now: 1_000 + TAB_CLOSE_GRACE_MS, // = 6000
      });
      expect(graced.tabs).toEqual([]);
      expect(graced.autoDismissed).toEqual(["worker-1"]);

      // The caller (state-store.ts) folds autoDismissed into its OWN
      // dismissed set — simulate that here.
      const dismissed = new Set(graced.autoDismissed);

      // `worker-1` is STILL in state.dispatchJobs on the next poll (main.ts
      // keeps newest-24, no status filter) — this is exactly the condition
      // that used to resurrect the tab.
      const nextPoll = reduce({
        open: [], // the tab was already dropped
        jobs: [doneJob],
        now: 1_000 + TAB_CLOSE_GRACE_MS + 500, // = 6500
        dismissed,
      });
      expect(nextPoll).toEqual([]); // stays closed — no resurrection

      // ...and stays closed indefinitely while merely "watched" (not
      // re-dispatched, not manually reopened).
      const muchLaterPoll = reduce({
        open: [],
        jobs: [doneJob],
        now: 1_000 + TAB_CLOSE_GRACE_MS + 60_000,
        dismissed,
      });
      expect(muchLaterPoll).toEqual([]);
    });

    it("a pinned 'done' tab never enters the grace/auto-close branch at all — no autoDismissed report", () => {
      const pinnedDoneTab: SubagentTab = {
        jobId: "worker-1",
        agentId: "agent-worker-1",
        vendor: "codex",
        status: "done",
        pendingCloseAt: null,
        pinned: true,
      };
      const result = reduceSubagentTabs({
        open: [pinnedDoneTab],
        jobs: [job("worker-1", "done")],
        now: 1_000_000, // arbitrarily far past any grace window
      });
      expect(result.tabs).toHaveLength(1);
      expect(result.tabs[0]?.jobId).toBe("worker-1");
      expect(result.tabs[0]?.pendingCloseAt).toBeNull();
      expect(result.autoDismissed).toEqual([]);
    });
  });

  // ── FIX C: the cap must be applied PER-CHAT, never app-wide ──────────────
  describe("FIX C: per-chat capping", () => {
    it("scoping `jobs` to one chat before applying the cap never evicts another chat's own tabs, unlike a single app-wide capped call over the combined list", () => {
      // Chat A has 2 of its own subagents; chat B fans out 9 (over the cap).
      const chatAJobs = [job("a1", "running"), job("a2", "running")];
      const chatBJobs = Array.from({ length: 9 }, (_, i) =>
        job(`b${i + 1}`, "running")
      );

      // BUGGY shape (what state-store.ts used to do): reduce ALL jobs across
      // every chat through ONE capped call — chat B's fan-out evicts chat
      // A's own tabs even though chat A never went over the cap itself.
      const appWideCapped = reduceSubagentTabs({
        open: [],
        jobs: [...chatAJobs, ...chatBJobs],
        now: 0,
      }).tabs;
      expect(appWideCapped.some((tab) => tab.jobId === "a1")).toBe(false);
      expect(appWideCapped.some((tab) => tab.jobId === "a2")).toBe(false);

      // FIXED shape: the store keeps an UNCAPPED app-wide list (state-store.ts
      // now passes cap: Infinity to the auto-reducer), and each chat applies
      // SUBAGENT_TAB_CAP only to ITS OWN tabs, after narrowing (app.tsx's
      // `chatSubagentTabs.slice(...)`, mirrored here):
      const appWideUncapped = reduceSubagentTabs({
        open: [],
        jobs: [...chatAJobs, ...chatBJobs],
        now: 0,
        cap: Number.POSITIVE_INFINITY,
      }).tabs;
      const capPerChat = (tabs: SubagentTab[], jobs: WatchedJob[]) => {
        const ids = new Set(jobs.map((j) => j.id));
        const scoped = tabs.filter((tab) => ids.has(tab.jobId));
        return scoped.slice(Math.max(0, scoped.length - SUBAGENT_TAB_CAP));
      };

      const chatATabs = capPerChat(appWideUncapped, chatAJobs);
      const chatBTabs = capPerChat(appWideUncapped, chatBJobs);

      // Chat A: untouched — both its own tabs survive, unaffected by chat B.
      expect(chatATabs.map((t) => t.jobId)).toEqual(["a1", "a2"]);
      // Chat B: capped to ITS OWN newest 8 — evicts its own oldest lane,
      // never chat A's.
      expect(chatBTabs).toHaveLength(SUBAGENT_TAB_CAP);
      expect(chatBTabs.map((t) => t.jobId)).not.toContain("b1");
      expect(chatBTabs.map((t) => t.jobId)).toContain("b9");
    });
  });
});

describe("openSubagentTab", () => {
  it("adds a new tab, clearing any pendingCloseAt, and PINS it", () => {
    const next = openSubagentTab([], job("worker-1", "running"));
    expect(next).toEqual([
      {
        jobId: "worker-1",
        agentId: "agent-worker-1",
        vendor: "codex",
        status: "running",
        pendingCloseAt: null,
        pinned: true,
      },
    ]);
  });

  it("never opens a tab for the orchestrator's own job, even on a manual open", () => {
    const next = openSubagentTab(
      [],
      job("root", "running", { capabilityMode: "orchestrator" })
    );
    expect(next).toEqual([]);
  });

  it("reopens (and un-grace's) an existing tab, moving it to newest", () => {
    const existing: SubagentTab[] = [
      {
        jobId: "worker-1",
        agentId: "agent-worker-1",
        vendor: "codex",
        status: "done",
        pendingCloseAt: 1_000,
        pinned: false,
      },
      {
        jobId: "worker-2",
        agentId: "agent-worker-2",
        vendor: "cursor",
        status: "running",
        pendingCloseAt: null,
        pinned: false,
      },
    ];
    const next = openSubagentTab(existing, job("worker-1", "done"));
    expect(next.map((tab) => tab.jobId)).toEqual(["worker-2", "worker-1"]);
    expect(next.find((tab) => tab.jobId === "worker-1")?.pendingCloseAt).toBeNull();
  });

  it("evicts the oldest past the cap", () => {
    const existing: SubagentTab[] = Array.from({ length: 8 }, (_, i) => ({
      jobId: `w${i + 1}`,
      agentId: null,
      vendor: "codex",
      status: "running",
      pendingCloseAt: null,
      pinned: false,
    }));
    const next = openSubagentTab(existing, job("w9", "running"));
    expect(next.map((tab) => tab.jobId)).toEqual([
      "w2",
      "w3",
      "w4",
      "w5",
      "w6",
      "w7",
      "w8",
      "w9",
    ]);
  });

  // ── FIX B: manual open of a 'done' tab must survive a follow-up poll ────
  describe("FIX B: pinning survives subsequent polls", () => {
    it("a manually (re)opened 'done' tab is NEVER auto-closed by a later reduceSubagentTabs poll", () => {
      // Job finished; a human clicks to (re)open and review its result/diff.
      const opened = openSubagentTab([], job("worker-1", "done"));
      expect(opened[0]?.pinned).toBe(true);
      expect(opened[0]?.pendingCloseAt).toBeNull();

      // A follow-up poll (mirrors the store's 2s interval) must NOT re-arm
      // the close timer just because pendingCloseAt reads null — the bug:
      // `tab.pendingCloseAt ?? input.now` used to coalesce null→now here,
      // silently restarting the 5s countdown under the human's nose.
      const afterOnePoll = reduce({
        open: opened,
        jobs: [job("worker-1", "done")],
        now: 2_000,
        graceMs: TAB_CLOSE_GRACE_MS,
      });
      expect(afterOnePoll).toHaveLength(1);
      expect(afterOnePoll[0]?.pendingCloseAt).toBeNull();
      expect(afterOnePoll[0]?.pinned).toBe(true);

      // ...and stays open well past what would have been the grace window.
      const wayLater = reduce({
        open: afterOnePoll,
        jobs: [job("worker-1", "done")],
        now: 2_000 + TAB_CLOSE_GRACE_MS * 10,
        graceMs: TAB_CLOSE_GRACE_MS,
      });
      expect(wayLater).toHaveLength(1);
      expect(wayLater[0]?.jobId).toBe("worker-1");
      expect(wayLater[0]?.pinned).toBe(true);
    });
  });
});

describe("closeSubagentTab", () => {
  it("removes the tab by jobId", () => {
    const existing: SubagentTab[] = [
      {
        jobId: "worker-1",
        agentId: null,
        vendor: "codex",
        status: "running",
        pendingCloseAt: null,
        pinned: false,
      },
    ];
    expect(closeSubagentTab(existing, "worker-1")).toEqual([]);
    expect(closeSubagentTab(existing, "nope")).toEqual(existing);
  });

  it("removes a PINNED tab too — an explicit close always wins", () => {
    const existing: SubagentTab[] = [
      {
        jobId: "worker-1",
        agentId: null,
        vendor: "codex",
        status: "done",
        pendingCloseAt: null,
        pinned: true,
      },
    ];
    expect(closeSubagentTab(existing, "worker-1")).toEqual([]);
  });
});
