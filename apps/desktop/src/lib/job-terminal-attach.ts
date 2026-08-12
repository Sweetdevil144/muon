import type { JobTerminalView } from "@muon/client";

/**
 * U1 LIVE — the pure half of "open a dispatched worker and watch its REAL
 * console". The renderer component next door owns the DOM and the timer; every
 * decision that could produce a LIE lives here, where it is testable.
 *
 * The producer (packages/runner/src/pty/job-terminal.ts) relays the vendor
 * child's console bytes to the brain, which holds them in a bounded ring and
 * stamps `DispatchJob.ptySessionId` on the first byte. This module turns that
 * coordinate plus a poll of `GET /api/dispatch/:jobId/terminal` into three
 * honest things:
 *
 *   1. WHETHER a live attach is even legitimate for this job
 *      (`jobTerminalAttachId`) — fail-closed, and bound to the job's own id.
 *   2. WHAT to write into the pane, and WHERE OUTPUT IS MISSING
 *      (`applyJobTerminalPoll`). A hole rendered as continuous output is the
 *      same class of lie as a replayed stream labelled live, so both loss
 *      paths — the brain's ring trimming (`firstSeq`) and frames the runner
 *      lost before the brain ever saw them (`dropped`) — are surfaced.
 *   3. WHEN the pane must stop claiming to be live (`degrade` / `ended`).
 *
 * NOT A SPAWN COORDINATE. `pty:job:<jobId>:<epoch>` means "attach, read-only",
 * and `terminal-<jobId>` means "start a fresh interactive vendor CLI in this
 * job's worktree". Conflating them is the defect that made opening a worker
 * launch an ungoverned process, so `isJobTerminalAttachId` exists for the
 * terminal HOST to refuse one at the spawn door (lib/terminal-host.ts).
 *
 * NO INPUT. Nothing here produces anything to send toward the agent. Typing
 * into a governed worker would bypass the approval path that makes it governed.
 */

/**
 * Session-id prefix of an ATTACH coordinate. Mirror of the runner's
 * `JOB_TERMINAL_SESSION_PREFIX` (packages/runner/src/pty/job-terminal.ts) —
 * mirrored rather than imported because this module is bundled into the
 * RENDERER, which must not pull the node-only runner in. Both sides also
 * re-derive it from the job id, so a drift produces "no live console"
 * (fail-closed), never a mis-attached pane.
 */
export const JOB_TERMINAL_ATTACH_PREFIX = "pty:job:";

/** Trailing per-execution epoch, exactly as the brain's publish route bounds it. */
const EPOCH_PATTERN = /^[0-9a-f]{8,64}$/;

/** True for any id shaped like a live-console ATTACH coordinate. */
export function isJobTerminalAttachId(sessionId: string): boolean {
  return sessionId.startsWith(JOB_TERMINAL_ATTACH_PREFIX);
}

/**
 * The attach coordinate for THIS job, or null.
 *
 * Fail-closed on every disagreement: an absent/blank `ptySessionId` (the
 * claude-code and `codex app-server` lanes, every pre-0038 row, and any job
 * that never printed a console byte), an id belonging to a DIFFERENT job, or a
 * malformed epoch all resolve to null — and null means the tab falls back to
 * the recorded stream, clearly labelled, instead of mounting a live pane that
 * could show another job's console or nothing at all.
 */
export function jobTerminalAttachId(
  job: { id: string; ptySessionId?: string | null } | null | undefined
): string | null {
  const raw = job?.ptySessionId?.trim();
  if (!job || !raw) {
    return null;
  }
  const expected = `${JOB_TERMINAL_ATTACH_PREFIX}${job.id}:`;
  if (!raw.startsWith(expected)) {
    return null;
  }
  return EPOCH_PATTERN.test(raw.slice(expected.length)) ? raw : null;
}

/** Statuses after which no further console bytes can ever arrive. */
const TERMINAL_JOB_STATUSES = new Set(["done", "failed", "interrupted"]);

export type JobTerminalPhase = "connecting" | "attached" | "ended";

export type JobTerminalAttachState = {
  /** Highest frame `seq` written into the pane. The poll cursor. */
  cursor: number;
  /** Last cumulative `dropped` the brain reported (runner-side loss). */
  dropped: number;
  /** Frames actually written. 0 ⇒ nothing has ever been shown in this pane. */
  applied: number;
  /** Cumulative frames the brain's ring trimmed before this viewer read them. */
  trimmed: number;
  /** Cumulative frames lost before the brain saw them. */
  lost: number;
  phase: JobTerminalPhase;
};

export const INITIAL_JOB_TERMINAL_ATTACH_STATE: JobTerminalAttachState = {
  cursor: 0,
  dropped: 0,
  applied: 0,
  trimmed: 0,
  lost: 0,
  phase: "connecting",
};

export type JobTerminalPollResult = {
  state: JobTerminalAttachState;
  /** Console text to write into the view, in order. */
  writes: string[];
  /** Persistent, human-readable gap notice, or null when nothing was lost. */
  notice: string | null;
  /**
   * Non-null ⇒ this tab must STOP calling itself live and show the recorded
   * stream instead, with this sentence as the reason. Only ever set while the
   * pane is still empty — once real console bytes are on screen, throwing them
   * away for a recording would lose what the human is actually watching.
   */
  degrade: string | null;
  /** Non-null ⇒ the live console closed; the pane keeps its bytes and says so. */
  ended: string | null;
  /** Stop polling. */
  stop: boolean;
  /** The ring holds more than this page returned — poll again promptly. */
  more: boolean;
};

/** The in-band marker written AT the point output went missing. */
function gapMarker(count: number): string {
  return `\r\n\x1b[33m── MUON: output gap, ${count} frame(s) missing ──\x1b[0m\r\n`;
}

/**
 * The out-of-band sentence under the pane. Cumulative and specific about WHICH
 * loss happened, because the two have different meanings for the human: a
 * trimmed ring means "you attached late / it scrolled away", while a runner
 * drop means "MUON could not keep up with this agent's output".
 */
export function jobTerminalGapNotice(
  state: JobTerminalAttachState
): string | null {
  const parts: string[] = [];
  if (state.trimmed > 0) {
    parts.push(
      `${state.trimmed} frame(s) of earlier output scrolled out of MUON's live buffer`
    );
  }
  if (state.lost > 0) {
    parts.push(
      `${state.lost} frame(s) were dropped before they reached MUON`
    );
  }
  if (parts.length === 0) {
    return null;
  }
  return `Output gap: ${parts.join(
    "; "
  )}. The agent itself was never paused — only this view lost bytes. The Timeline's recorded stream is a separate channel and is unaffected.`;
}

/**
 * Fold one poll of `GET /api/dispatch/:jobId/terminal` into the pane's state.
 *
 * Pure: it neither reads nor writes anything outside its arguments, so the
 * honesty rules (gap reporting, live→recorded degradation, "the console
 * closed") are unit-testable without a terminal, a timer, or an Electron
 * runtime.
 */
export function applyJobTerminalPoll(
  state: JobTerminalAttachState,
  view: JobTerminalView
): JobTerminalPollResult {
  const jobEnded = TERMINAL_JOB_STATUSES.has(view.jobStatus);

  if (!view.available) {
    // The brain holds no ring for this job. Either it finished and the console
    // was released, or the brain restarted. Never render this as a live-but-
    // silent agent.
    const ended: JobTerminalAttachState = { ...state, phase: "ended" };
    if (state.applied === 0) {
      return {
        state: ended,
        writes: [],
        notice: jobTerminalGapNotice(ended),
        degrade: jobEnded
          ? "This job has finished and MUON is no longer holding its live console."
          : "MUON is not holding a live console for this job right now — the brain was restarted, or its buffer was released.",
        ended: null,
        stop: true,
        more: false,
      };
    }
    return {
      state: ended,
      writes: [],
      notice: jobTerminalGapNotice(ended),
      degrade: null,
      ended: jobEnded
        ? "This job finished and its live console is closed. Everything above is what MUON relayed while it ran."
        : "The live console closed before this job finished. Everything above is what MUON relayed; the Timeline holds the recorded stream.",
      stop: true,
      more: false,
    };
  }

  const expected = state.cursor + 1;
  const fresh = view.frames
    .filter((frame) => frame.seq > state.cursor)
    .sort((left, right) => left.seq - right.seq);
  const pageStart = fresh.length > 0 ? (fresh[0] as { seq: number }).seq : null;
  // Two independent statements of "you missed some": the ring's own first
  // retained seq, and the first seq this page actually carries. Whichever is
  // further ahead of our cursor is the real hole. Neither double-counts across
  // polls, because the cursor moves past the hole once it is reported.
  const trimmedNow = Math.max(
    0,
    view.firstSeq !== null ? view.firstSeq - expected : 0,
    pageStart !== null ? pageStart - expected : 0
  );
  const lostNow = Math.max(0, view.dropped - state.dropped);
  const gapNow = trimmedNow + lostNow;

  const writes: string[] = [];
  if (gapNow > 0) {
    writes.push(gapMarker(gapNow));
  }
  for (const frame of fresh) {
    writes.push(frame.data);
  }

  const cursor =
    fresh.length > 0
      ? Math.max(state.cursor, (fresh[fresh.length - 1] as { seq: number }).seq)
      : state.cursor;
  const drained = view.lastSeq <= cursor;
  const next: JobTerminalAttachState = {
    cursor,
    dropped: Math.max(state.dropped, view.dropped),
    applied: state.applied + fresh.length,
    trimmed: state.trimmed + trimmedNow,
    lost: state.lost + lostNow,
    phase: jobEnded && drained ? "ended" : "attached",
  };

  return {
    state: next,
    writes,
    notice: jobTerminalGapNotice(next),
    degrade: null,
    ended:
      jobEnded && drained
        ? "This job has finished. You are looking at the end of its console."
        : null,
    stop: jobEnded && drained,
    more: view.lastSeq > cursor,
  };
}
