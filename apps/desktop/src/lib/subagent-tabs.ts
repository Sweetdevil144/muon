/**
 * Task #124 — subagent tabs. Once a superagent fires subagents, MUON opens an
 * easy-to-navigate tab per subagent, and closes it automatically once that
 * subagent's session completes cleanly. Pure logic only (no React, no IPC) so
 * the open/close/grace rules are unit-testable without Electron. Keyed by JOB
 * id instead of agent id (a tab names one dispatch exactly; an agent slot can
 * be reused across jobs over a mission's lifetime).
 */

/** A fanned-out mission can dispatch many subagents; overflow scrolls in the
 *  tab strip (workspace-tabs.tsx has `overflow-x: auto`) rather than hiding a
 *  subagent's work entirely. */
export const SUBAGENT_TAB_CAP = 8;

/** How long a 'done' tab stays visible (dimmed) before it auto-removes — long
 *  enough to register "this one just finished", short enough not to clutter
 *  the strip on a large fan-out. */
export const TAB_CLOSE_GRACE_MS = 5_000;

const EMPTY_DISMISSED: ReadonlySet<string> = new Set();

export type SubagentTabStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "interrupted"
  | string;

export type SubagentTab = {
  /** The DispatchJobRecord id this tab names — a tab's identity IS its job. */
  jobId: string;
  agentId: string | null;
  vendor: string;
  status: SubagentTabStatus;
  /**
   * Set the instant this job's status is observed as "done"; null otherwise.
   * Drives the auto-close grace window: a LATER `reduceSubagentTabs` call
   * removes the tab once `now - pendingCloseAt >= graceMs`. Never set for
   * 'failed'/'interrupted' — those need human review and stay open until
   * explicitly dismissed (closeSubagentTab / the store's closeTab). Also
   * never armed while `pinned` is true (see below) — `null` here means
   * "not currently counting down", not "never was done".
   */
  pendingCloseAt: number | null;
  /**
   * True once a human has explicitly (re)opened this tab (openSubagentTab /
   * the store's openTab) — a clear "I'm looking at this" signal. A pinned
   * tab is NEVER auto-closed by `reduceSubagentTabs`, even after it reaches
   * 'done' and the grace window would otherwise elapse: a human reviewing a
   * finished subagent's result/diff must not have it yanked away mid-read.
   * Cleared by nothing short of an explicit close (closeSubagentTab /
   * closeTab) — which removes the tab outright, not merely the flag.
   */
  pinned: boolean;
};

/** The subset of DispatchJobRecord this module reads — keeps it decoupled
 *  from the full wire record so it stays trivially testable. */
export type WatchedJob = {
  id: string;
  agentId?: string | null;
  vendor: string;
  status: string;
  capabilityMode?: string | null;
};

/**
 * The dispatched WORKER jobs eligible to show as a subagent tab — EXCLUDES
 * the capabilityMode === "orchestrator" job. That job IS the mission chat
 * (chat-scope.ts relabels it as the chat's own title); a tab for it would
 * double-render the chat.
 */
export function selectSubagentJobs<Job extends WatchedJob>(jobs: Job[]): Job[] {
  return jobs.filter((job) => job.capabilityMode !== "orchestrator");
}

/**
 * Bound one chat's visible strip without evicting tabs the human explicitly
 * opened or terminal failures that still need review. Protected tabs may take
 * the strip over the nominal cap; horizontal scrolling is preferable to
 * silently hiding a human choice or failure evidence.
 */
export function capVisibleSubagentTabs(
  tabs: SubagentTab[],
  cap: number = SUBAGENT_TAB_CAP
): SubagentTab[] {
  if (tabs.length <= cap) {
    return tabs;
  }
  const protectedIds = new Set(
    tabs
      .filter(
        (tab) =>
          tab.pinned ||
          tab.status === "failed" ||
          tab.status === "interrupted"
      )
      .map((tab) => tab.jobId)
  );
  const remaining = Math.max(0, cap - protectedIds.size);
  const newestOrdinaryIds = new Set(
    remaining === 0
      ? []
      : tabs
          .filter((tab) => !protectedIds.has(tab.jobId))
          .slice(-remaining)
          .map((tab) => tab.jobId)
  );
  return tabs.filter(
    (tab) =>
      protectedIds.has(tab.jobId) || newestOrdinaryIds.has(tab.jobId)
  );
}

/** Result of `reduceSubagentTabs`: the next open-tab list, plus any jobIds
 *  the reducer itself just auto-closed (grace-elapsed 'done' tabs). The
 *  caller (state-store.ts) MUST fold `autoDismissed` into its own dismissed
 *  bookkeeping — otherwise step 2 of the very next call reopens the same
 *  job the instant it notices it is "not already open", producing an
 *  open → dim → drop → reopen flicker forever. */
export type ReduceSubagentTabsResult = {
  tabs: SubagentTab[];
  /** JobIds auto-closed THIS call because their grace window elapsed.
   *  Empty on almost every call — only non-empty the tick a 'done' tab
   *  crosses its grace threshold. */
  autoDismissed: string[];
};

/**
 * Pure subagent-tab reducer. Given the currently open tabs and the mission's
 * current jobs, returns the next open-tab list (plus any newly-auto-closed
 * jobIds, see `ReduceSubagentTabsResult`):
 *
 *  - a watched job (selectSubagentJobs is applied internally, so the caller
 *    may pass the raw job list) not yet open and not `dismissed` OPENS a tab
 *    immediately — unlike `reducePanes`, there is no "first poll never
 *    auto-opens" hold-back here: the founder ask is to see ALL fired
 *    subagents right away, including ones already in flight when the app
 *    (re)connects mid-mission.
 *  - a job that reads "done" is marked `pendingCloseAt` (once); once
 *    `now - pendingCloseAt >= graceMs` on a LATER call, the tab is dropped
 *    AND its jobId is reported in `autoDismissed` — the caller must persist
 *    that into its own dismissed set so the tab cannot resurrect (see
 *    `ReduceSubagentTabsResult`).
 *  - a `pinned` tab (a human explicitly opened it — openSubagentTab/openTab)
 *    NEVER auto-closes, even once 'done' and past what would otherwise be
 *    the grace window: a human reviewing a finished subagent's result/diff
 *    must not have the tab yanked away mid-read.
 *  - 'failed'/'interrupted' NEVER auto-close — they carry no pendingCloseAt
 *    and stay open until a human calls closeSubagentTab/closeTab (they need
 *    review, not a vanishing act while someone's reading the failure).
 *  - `dismissed` holds jobIds a human (or a past auto-close) closed — an
 *    auto-tick never resurrects one of those while the job is still just
 *    "watched" (e.g. still running); a closed tab stays closed until an
 *    explicit re-open (openSubagentTab/openTab), which always wins
 *    regardless of dismissal.
 *  - a tab whose job fell out of scope entirely (not in `jobs` at all —
 *    e.g. the chat/mission it belonged to is no longer being watched) is
 *    dropped; nothing to review, it is simply out of scope now (NOT added
 *    to `autoDismissed` — there is nothing to suppress; if the job comes
 *    back into scope later it should reopen normally).
 */
export function reduceSubagentTabs(input: {
  open: SubagentTab[];
  jobs: WatchedJob[];
  now: number;
  dismissed?: ReadonlySet<string>;
  graceMs?: number;
  cap?: number;
}): ReduceSubagentTabsResult {
  const graceMs = input.graceMs ?? TAB_CLOSE_GRACE_MS;
  const cap = input.cap ?? SUBAGENT_TAB_CAP;
  const dismissed = input.dismissed ?? EMPTY_DISMISSED;
  const watched = selectSubagentJobs(input.jobs);
  const jobsById = new Map(watched.map((job) => [job.id, job]));
  const openIds = new Set(input.open.map((tab) => tab.jobId));

  const next: SubagentTab[] = [];
  const autoDismissed: string[] = [];

  // 1. Update (or auto-close) every currently open tab.
  for (const tab of input.open) {
    const job = jobsById.get(tab.jobId);
    if (!job) {
      continue; // out of scope now — dropped, not "closed" (nothing to dismiss)
    }
    if (job.status === "done" && !tab.pinned) {
      const pendingCloseAt = tab.pendingCloseAt ?? input.now;
      if (input.now - pendingCloseAt >= graceMs) {
        // Grace elapsed — auto-remove a cleanly finished tab AND report it
        // so the caller suppresses step 2 from reopening it next tick.
        autoDismissed.push(tab.jobId);
        continue;
      }
      next.push({
        ...tab,
        agentId: job.agentId ?? null,
        vendor: job.vendor,
        status: job.status,
        pendingCloseAt,
      });
      continue;
    }
    // queued/running/failed/interrupted, or a PINNED 'done' tab: stays open.
    // Clears any stale pendingCloseAt defensively — a tab must never carry
    // a dead (or, for a pinned tab, never-should-have-armed) close timer
    // forward.
    next.push({
      ...tab,
      agentId: job.agentId ?? null,
      vendor: job.vendor,
      status: job.status,
      pendingCloseAt: null,
    });
  }

  // 2. Open a tab for every watched job not already open and not dismissed.
  for (const job of watched) {
    if (openIds.has(job.id) || dismissed.has(job.id)) {
      continue;
    }
    next.push({
      jobId: job.id,
      agentId: job.agentId ?? null,
      vendor: job.vendor,
      status: job.status,
      pendingCloseAt: job.status === "done" ? input.now : null,
      // Auto-opened tabs are never pinned — only an explicit human open
      // pins (see openSubagentTab below).
      pinned: false,
    });
  }

  return {
    tabs: next.slice(Math.max(0, next.length - cap)),
    autoDismissed,
  };
}

/**
 * Manual open (a crew-click / the chat's "Open {vendor}" chip): moves/adds
 * the job's tab as newest and ALWAYS succeeds — even for a job a human
 * previously dismissed (an explicit open is a clear signal that overrides a
 * stale auto-close suppression) — except for the orchestrator's own job,
 * which is never a tab (see selectSubagentJobs).
 *
 * Sets `pinned: true`: a manual open always clears any pending auto-close
 * AND pins the tab so a LATER `reduceSubagentTabs` call can never re-arm the
 * grace timer out from under it (the bug this guards against: coalescing
 * `pendingCloseAt: null` back to `now` on the next poll would silently
 * restart the countdown on a tab a human just opened to review a finished
 * subagent). Pinning is permanent for this tab's lifetime — only an
 * explicit close (closeSubagentTab / the store's closeTab) removes it.
 */
export function openSubagentTab(
  open: SubagentTab[],
  job: WatchedJob,
  cap: number = SUBAGENT_TAB_CAP
): SubagentTab[] {
  if (job.capabilityMode === "orchestrator") {
    return open; // that job IS the mission chat — never a tab
  }
  const existing = open.find((tab) => tab.jobId === job.id);
  const tab: SubagentTab = {
    jobId: job.id,
    agentId: job.agentId ?? existing?.agentId ?? null,
    vendor: job.vendor,
    status: job.status,
    // A manual (re)open always clears any pending auto-close — a human is
    // looking at it right now.
    pendingCloseAt: null,
    pinned: true,
  };
  const next = [...open.filter((candidate) => candidate.jobId !== job.id), tab];
  return next.slice(Math.max(0, next.length - cap));
}

/** Manual close: drops the tab now. Pairs with the store's `dismissed`
 *  bookkeeping (state-store.ts) so the auto-reducer never reopens it while
 *  the underlying job is still merely "watched". */
export function closeSubagentTab(open: SubagentTab[], jobId: string): SubagentTab[] {
  return open.filter((tab) => tab.jobId !== jobId);
}
