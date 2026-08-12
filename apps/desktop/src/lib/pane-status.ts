/**
 * TODO 3.15 — pane status priority fold for workspace tabs and dock badges.
 * `permission` outranks `failed` because actionable-now beats terminal failure.
 */

export type PaneDisplayStatus =
  | "idle"
  | "review"
  | "working"
  | "failed"
  | "permission";

const PANE_STATUS_PRIORITY: Record<PaneDisplayStatus, number> = {
  idle: 0,
  review: 1,
  working: 2,
  failed: 3,
  permission: 4,
};

export function paneStatusPriority(status: PaneDisplayStatus): number {
  return PANE_STATUS_PRIORITY[status];
}

/** Fold many pane statuses to the highest-priority one (dock badge). */
export function foldPaneStatuses(
  statuses: ReadonlyArray<PaneDisplayStatus>
): PaneDisplayStatus {
  let best: PaneDisplayStatus = "idle";
  for (const status of statuses) {
    if (paneStatusPriority(status) > paneStatusPriority(best)) {
      best = status;
    }
  }
  return best;
}

export function resolvePaneDisplayStatus(input: {
  jobStatus: string;
  seen: boolean;
  pendingApproval: boolean;
}): PaneDisplayStatus {
  if (input.pendingApproval) {
    return "permission";
  }
  switch (input.jobStatus) {
    case "queued":
      return "idle";
    case "running":
      return "working";
    case "failed":
    case "interrupted":
      return "failed";
    case "done":
      return input.seen ? "idle" : "review";
    default:
      return "idle";
  }
}

export function paneStatusLabel(status: PaneDisplayStatus): string {
  switch (status) {
    case "idle":
      return "idle";
    case "review":
      return "review";
    case "working":
      return "working";
    case "failed":
      return "failed";
    case "permission":
      return "permission";
  }
}

/**
 * ROADMAP T2 — human vendor terminal tabs get the SAME five-state vocabulary
 * above, but derived differently: there is no dispatch/job record behind a
 * human's own interactive terminal, only the local pty signals this desktop
 * already has (recent output/input bytes, the exit frame, whether the tab has
 * been opened since it last finished). This is a THIN slice, not the fuller
 * per-vendor lifecycle-hook path ROADMAP T2 still names as the real fix:
 *
 * - `working` / `idle` come from an activity timeout over raw bytes, not from
 *   any vendor telling MUON what it is doing.
 * - `permission` comes from a best-effort regex over the tab's own recent
 *   output (terminal-activity.ts / terminal-permission-heuristic.ts) — it can
 *   only ever SURFACE a dot, never resolve a prompt, and both false positives
 *   and false negatives are expected. See ADR-0025 §2 for why there is no
 *   channel back into a human's own vendor session at all.
 * - `failed` / `review` mirror the job-tab rule directly below: a non-zero
 *   exit is always `failed` (never seen-gated, same as `interrupted` above);
 *   a clean exit is `review` until the operator has opened/focused the tab,
 *   then `idle`.
 */
export interface TerminalActivitySnapshot {
  /** Epoch ms of the most recent output byte or keystroke on this tab's pty,
   *  or null before anything has happened yet (freshly opened, silent). */
  lastActivityAt: number | null;
  /** The pty's own exit code, or null while the session is still alive. */
  exitCode: number | null;
  /** The operator has opened/focused this tab since it last finished. */
  seen: boolean;
  /** See the heuristic module — DISPLAY ONLY, never authoritative. */
  permissionPromptDetected: boolean;
}

/** How long since the last byte before a quiet terminal reads `idle` instead
 *  of `working`. Multiples of the 2s desktop poll interval (app.tsx), which is
 *  what actually re-renders this derivation over time — long enough to
 *  survive an ordinary pause between keystrokes or a command's output burst,
 *  short enough that a tab a human walked away from settles within a few
 *  polls, not minutes. */
export const TERMINAL_IDLE_TIMEOUT_MS = 10_000;

export function resolveTerminalPaneStatus(
  snapshot: TerminalActivitySnapshot,
  now: number,
  idleTimeoutMs: number = TERMINAL_IDLE_TIMEOUT_MS
): PaneDisplayStatus {
  if (snapshot.exitCode !== null) {
    if (snapshot.exitCode !== 0) {
      return "failed";
    }
    return snapshot.seen ? "idle" : "review";
  }
  if (snapshot.permissionPromptDetected) {
    return "permission";
  }
  if (
    snapshot.lastActivityAt !== null &&
    now - snapshot.lastActivityAt < idleTimeoutMs
  ) {
    return "working";
  }
  return "idle";
}
