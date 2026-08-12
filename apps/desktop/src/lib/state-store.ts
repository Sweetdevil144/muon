import type { DesktopState } from "../shared/ipc.js";
import {
  closeSubagentTab,
  openSubagentTab,
  reduceSubagentTabs,
  type SubagentTab,
  type WatchedJob,
} from "./subagent-tabs.js";

/**
 * Renderer-side polling store: fetches the desktop state on an interval and
 * derives which sub-agent panes (and, task #124, subagent workspace tabs) are
 * open. Pure logic, the fetch function and change callback are injected, so
 * it tests without Electron or React.
 */

export const PANE_CAP = 3;

export type PaneAgent = {
  /** Fleet slot identity; slots are reusable across chats/jobs. */
  id: string;
  status: string;
  /** The dispatch identity panes are keyed by. */
  currentJobId?: string | null;
};

export type StoreSnapshot = {
  state: DesktopState | null;
  /**
   * Open sub-agent pane ids, oldest first (the "Crew streams" band). Tracked
   * app-wide and uncapped in production; app.tsx narrows to the active chat
   * before applying PANE_CAP, so another chat cannot evict this chat's panes.
   */
  panes: string[];
  /**
   * Task #124 — open subagent workspace tabs, jobId-keyed, oldest first. Not
   * chat-scoped here (this store has no notion of "the active chat"): it
   * tracks every dispatched worker/delegate job app-wide, the same way
   * `panes` tracks every fleet agent app-wide. The renderer (app.tsx)
   * narrows this down to the ACTIVE chat's own subagents for display, the
   * same pattern `paneAgents` already uses against `panes`.
   *
   * NOT capped here (see `tick` below) — bug fix: an app-wide SUBAGENT_TAB_
   * CAP-sized slice truncates ACROSS every chat, so one chat's fan-out could
   * silently evict another chat's own running subagent tabs. The cap is
   * enforced PER-CHAT, downstream, by app.tsx AFTER it narrows this list to
   * the active chat (mirrors this same list being naturally bounded upstream
   * by main.ts's newest-24 dispatchJobs cap, so it never grows unbounded).
   */
  tabs: SubagentTab[];
  error: string | null;
};

/**
 * Panes after a fleet update: panes for vanished agents close, and agents
 * that *transitioned* to working auto-open. The first poll (previous ===
 * null) never auto-opens, no pane storm on launch, mirroring the
 * approvals monitor's no-notification-storm rule. Overflow evicts oldest.
 */
export function reducePanes(input: {
  open: string[];
  previous: PaneAgent[] | null;
  next: PaneAgent[];
  /** Jobs still retained in the bounded desktop snapshot, including terminal. */
  aliveJobIds?: ReadonlySet<string>;
  cap?: number;
}): string[] {
  const cap = input.cap ?? PANE_CAP;
  const alive =
    input.aliveJobIds ??
    new Set(
      input.next
        .map((agent) => agent.currentJobId)
        .filter((id): id is string => Boolean(id))
    );
  let open = input.open.filter((id) => alive.has(id));

  if (input.previous) {
    const before = new Map(input.previous.map((agent) => [agent.id, agent]));
    for (const agent of input.next) {
      const prior = before.get(agent.id);
      if (
        agent.currentJobId &&
        alive.has(agent.currentJobId) &&
        agent.status === "working" &&
        (prior?.status !== "working" ||
          prior.currentJobId !== agent.currentJobId) &&
        !open.includes(agent.currentJobId)
      ) {
        open = [...open, agent.currentJobId];
      }
    }
  }

  return open.slice(Math.max(0, open.length - cap));
}

/** Manual open (clicking a job): moves/adds it as newest, evicts oldest. */
export function openPane(open: string[], id: string, cap = PANE_CAP): string[] {
  const next = [...open.filter((existing) => existing !== id), id];
  return next.slice(Math.max(0, next.length - cap));
}

export type StateStore = {
  tick: () => Promise<void>;
  start: (intervalMs: number) => void;
  stop: () => void;
  openPane: (jobId: string) => void;
  closePane: (jobId: string) => void;
  /** Manual tab open (a crew-click / the chat's "Open {vendor}" chip):
   *  always succeeds, even for a job the human previously dismissed — an
   *  explicit open always overrides a stale auto-close suppression. */
  openTab: (job: WatchedJob) => void;
  /** Manual tab close: removes it now AND suppresses the auto-reducer from
   *  reopening the SAME job on a later poll (see `dismissedTabs` below) — a
   *  closed tab stays closed until an explicit re-open. */
  closeTab: (jobId: string) => void;
};

export function createStateStore(options: {
  fetchState: () => Promise<DesktopState>;
  onChange: (snapshot: StoreSnapshot) => void;
  /**
   * Overrides the app-wide pane-list bound (tests only). Production leaves the
   * shared list unbounded and applies PANE_CAP per chat in app.tsx.
   */
  paneCap?: number;
  /**
   * Overrides the APP-WIDE tab list bound (tests only — no caller passes
   * this in production). Defaults to unbounded: the real SUBAGENT_TAB_CAP
   * is enforced PER-CHAT by app.tsx after it narrows `snapshot.tabs` down
   * to the active chat, never here — capping this app-wide list would
   * truncate across every chat and evict an unrelated chat's own tabs (the
   * bug fixed in Task #124's adversarial review).
   */
  tabCap?: number;
  tabGraceMs?: number;
}): StateStore {
  let timer: ReturnType<typeof setInterval> | null = null;
  let snapshot: StoreSnapshot = { state: null, panes: [], tabs: [], error: null };
  let previousAgents: PaneAgent[] | null = null;
  // Task #124: job ids a human explicitly closed. Kept OUTSIDE `snapshot` (it
  // is suppression bookkeeping, not display state) so a later poll's
  // reduceSubagentTabs never resurrects a tab that was just dismissed, even
  // while its job is still merely "watched" (e.g. still running).
  const dismissedTabs = new Set<string>();
  let inFlight = false;

  const emit = () => {
    options.onChange(snapshot);
  };

  const tick = async () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      const state = await options.fetchState();
      const agents = (state.fleet?.agents ?? []).map((agent) => ({
        id: agent.id,
        status: agent.status,
        currentJobId: agent.currentJobId,
      }));
      const aliveJobIds = new Set(
        (state.dispatchJobs ?? []).map((job) => job.id)
      );
      const panes = reducePanes({
        open: snapshot.panes,
        previous: previousAgents,
        next: agents,
        aliveJobIds,
        cap: options.paneCap ?? Number.POSITIVE_INFINITY,
      });
      previousAgents = agents;
      const jobs: WatchedJob[] = (state.dispatchJobs ?? []).map((job) => ({
        id: job.id,
        agentId: job.agentId,
        vendor: job.vendor,
        status: job.status,
        capabilityMode: job.capabilityMode,
      }));
      const reduced = reduceSubagentTabs({
        open: snapshot.tabs,
        jobs,
        now: Date.now(),
        dismissed: dismissedTabs,
        // Unbounded app-wide by default — see the `tabCap` doc above.
        cap: options.tabCap ?? Number.POSITIVE_INFINITY,
        graceMs: options.tabGraceMs,
      });
      // Fold grace-elapsed auto-closes into the SAME dismissed set manual
      // closes use — otherwise the very next poll's step 2 sees the job
      // still watched, still not "open", and reopens it: open → dim → drop
      // → reopen, forever (the flicker this fix closes).
      for (const jobId of reduced.autoDismissed) {
        dismissedTabs.add(jobId);
      }
      const tabs = reduced.tabs;
      snapshot = { state, panes, tabs, error: null };
    } catch (error) {
      // Keep the last good state on a failed poll; surface the error.
      snapshot = {
        ...snapshot,
        error: error instanceof Error ? error.message : "poll failed",
      };
    } finally {
      inFlight = false;
    }
    emit();
  };

  return {
    tick,
    start: (intervalMs: number) => {
      if (timer) {
        return;
      }
      void tick();
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    openPane: (jobId: string) => {
      snapshot = {
        ...snapshot,
        panes: openPane(
          snapshot.panes,
          jobId,
          options.paneCap ?? Number.POSITIVE_INFINITY
        ),
      };
      emit();
    },
    closePane: (jobId: string) => {
      snapshot = {
        ...snapshot,
        panes: snapshot.panes.filter((id) => id !== jobId),
      };
      emit();
    },
    openTab: (job: WatchedJob) => {
      dismissedTabs.delete(job.id);
      snapshot = {
        ...snapshot,
        // Unbounded app-wide by default (see `tabCap` doc above) — a manual
        // open must never evict an unrelated chat's own tab either.
        tabs: openSubagentTab(
          snapshot.tabs,
          job,
          options.tabCap ?? Number.POSITIVE_INFINITY
        ),
      };
      emit();
    },
    closeTab: (jobId: string) => {
      dismissedTabs.add(jobId);
      snapshot = {
        ...snapshot,
        tabs: closeSubagentTab(snapshot.tabs, jobId),
      };
      emit();
    },
  };
}
