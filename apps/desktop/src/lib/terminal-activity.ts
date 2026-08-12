import { resolveTerminalPaneStatus, type PaneDisplayStatus } from "./pane-status.js";
import {
  looksLikePermissionPrompt,
  PERMISSION_HEURISTIC_WINDOW_CHARS,
} from "./terminal-permission-heuristic.js";

/**
 * ROADMAP T2 — the per-human-terminal-tab activity ledger, built from exactly
 * the two signals `wireTerminal` (terminal-wire.ts) already sees passing
 * through: a host output frame, and a keystroke the human sent. Pure and
 * reducer-shaped on purpose, so app.tsx only ever calls a function and holds
 * the result in `useState` — no timers, no XTerm, no IPC in here.
 */
export interface TerminalActivityState {
  /** Epoch ms of the most recent output byte or keystroke, or null before
   *  anything has happened yet. */
  lastActivityAt: number | null;
  /** The pty's own exit code, or null while the session is still alive. */
  exitCode: number | null;
  /** Trailing window of raw output bytes, for the permission heuristic below.
   *  Bounded to PERMISSION_HEURISTIC_WINDOW_CHARS — never the full scrollback. */
  outputTail: string;
}

export const INITIAL_TERMINAL_ACTIVITY: TerminalActivityState = {
  lastActivityAt: null,
  exitCode: null,
  outputTail: "",
};

export type TerminalActivityEvent =
  | { kind: "output"; data: string }
  | { kind: "input"; data: string };

/**
 * Folds one activity event into the prior state.
 *
 * An `input` event clears `outputTail` rather than merely timestamping it: a
 * keystroke is read as "the human just answered whatever was on screen", so
 * the NEXT output-triggered heuristic check starts from a clean window
 * instead of re-matching prompt text that already scrolled logically past —
 * without this, an answered `(y/n)` prompt could keep the tab pinned on
 * `permission` for the rest of PERMISSION_HEURISTIC_WINDOW_CHARS of output.
 */
export function applyTerminalActivityEvent(
  prior: TerminalActivityState,
  event: TerminalActivityEvent,
  now: number = Date.now()
): TerminalActivityState {
  if (event.kind === "input") {
    return { lastActivityAt: now, exitCode: prior.exitCode, outputTail: "" };
  }
  const outputTail = (prior.outputTail + event.data).slice(
    -PERMISSION_HEURISTIC_WINDOW_CHARS
  );
  return { lastActivityAt: now, exitCode: prior.exitCode, outputTail };
}

/** Folds the pty's exit frame in. Activity/output history is left untouched —
 *  a tab that just exited still shows what it last printed. */
export function applyTerminalExit(
  prior: TerminalActivityState,
  exitCode: number
): TerminalActivityState {
  return { ...prior, exitCode };
}

/** The one call site apps/desktop needs: activity state + seen-gate in,
 *  PaneDisplayStatus out. Wraps the heuristic so callers never import it
 *  directly (pane-status.ts's resolver stays heuristic-agnostic). */
export function terminalPaneStatus(
  state: TerminalActivityState,
  seen: boolean,
  /**
   * An OPTIONS object rather than more positional parameters, deliberately.
   * Adding `vendorId` as a third positional silently reinterpreted five
   * existing `terminalPaneStatus(state, seen, 5100)` calls — the clock became
   * a vendor id, `now` fell back to `Date.now()`, and only ONE of the five
   * assertions was time-sensitive enough to notice. A signature that can be
   * wrong quietly is the wrong signature.
   *
   * `vendorId` lets a per-vendor manifest entry apply (ADR-0039 D3); omitting
   * it falls to the wildcard, which is the pre-manifest behaviour.
   */
  opts: { vendorId?: string | null; now?: number } = {}
): PaneDisplayStatus {
  return resolveTerminalPaneStatus(
    {
      lastActivityAt: state.lastActivityAt,
      exitCode: state.exitCode,
      seen,
      permissionPromptDetected: looksLikePermissionPrompt(
        state.outputTail,
        opts.vendorId
      ),
    },
    opts.now ?? Date.now()
  );
}
