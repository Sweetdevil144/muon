// Wave 4 §2.5 — the RENDERER side of the terminal byte relay, as a pure
// controller so it is testable without a real XTerm or an Electron runtime.
//
// It connects a per-session TerminalClientPort to a TerminalView (an XTerm-like
// sink; the real one is injected by the React component, a fake by tests):
//   host data  → view.write + ACK  (the ack is what lets the host resume the pty,
//                                    so backpressure is honored end to end)
//   host exit  → view.markExited
//   view input → write frame
//   view resize→ resize frame

import type {
  TerminalClientPort,
  TerminalHostFrame,
} from "../../shared/terminal-protocol.js";

export interface Disposable {
  dispose(): void;
}

/** ROADMAP T4 — the minimal find-box surface a search overlay drives. Backed
 *  by `@xterm/addon-search` in the production view (xterm-view.ts); optional
 *  on `TerminalView` so a fake test view need not implement it. */
export type TerminalSearchController = {
  findNext(term: string, options?: { caseSensitive?: boolean }): boolean;
  findPrevious(term: string, options?: { caseSensitive?: boolean }): boolean;
  clear(): void;
};

/**
 * A session's end, as the renderer receives it. `lifetimeMs` is the HOST's
 * measurement of how long the child lived (see the exit frame in
 * terminal-protocol.ts) — the renderer never re-derives it, so "it never
 * became a session" means the same thing on both sides of the bridge.
 */
export interface TerminalExit {
  exitCode: number;
  signal?: number;
  lifetimeMs: number;
}

export interface TerminalView {
  write(data: string): void;
  onInput(listener: (data: string) => void): Disposable;
  onResize(listener: (size: { cols: number; rows: number }) => void): Disposable;
  /**
   * Re-measure the container and resize the grid to it. Called when the pane
   * BECOMES VISIBLE again: a terminal that mounted while hidden measures 0×0,
   * and a view that only fits on container-resize can miss that transition
   * entirely (a display:none element has no box to observe). Optional so a fake
   * view in a test — and any older implementation — still satisfies the
   * contract.
   */
  refit?(): void;
  /**
   * The grid the view is CURRENTLY showing, or null when it could not be
   * measured (hidden/unlaid-out container). Used to open a pty at the size it
   * will actually be read at instead of the driver's 80×24 default.
   */
  size?(): { cols: number; rows: number } | null;
  /**
   * ROADMAP T4 — the PARKED-RUNTIME LRU's richest replay source: the full
   * on-screen buffer (colors, cursor, alt-screen state) at THIS instant, in a
   * form that can be `write()`-n back into a fresh view to restore it. Optional
   * so a fake view (and any older implementation) still satisfies the
   * contract; `terminal-tab.tsx` treats its absence as "nothing to capture",
   * never a reason to skip parking.
   */
  serialize?(): string;
  /**
   * ROADMAP T4 — the find-box surface for THIS terminal's on-screen buffer.
   * Optional so a fake test view (and any older implementation) still
   * satisfies the contract; the search overlay treats its absence as "search
   * unavailable for this pane" rather than throwing.
   */
  search?: TerminalSearchController;
  markExited(exit: TerminalExit): void;
  /**
   * The host refused this open, or the session died silently. Optional so an
   * older/fake view still satisfies the contract; when absent the reason still
   * reaches the component through `wireTerminal`'s `onError`, so the human is
   * never left with an unexplained blank pane either way.
   */
  markError?(reason: string): void;
  /** Tear down the underlying terminal + observers (never orphaned on unmount). */
  dispose(): void;
}

export function wireTerminal(
  port: TerminalClientPort,
  view: TerminalView,
  handlers: {
    onError?: (reason: string) => void;
    /**
     * ROADMAP T2 — fires on every output frame and every keystroke, so a
     * caller can derive a `working`/`idle`/`permission` activity dot
     * (lib/terminal-activity.ts) without owning the wire protocol itself.
     * Display-only: this hands over raw bytes and nothing here (or downstream
     * of it) reads them as anything more than "something happened just now".
     */
    onActivity?: (event: { kind: "output" | "input"; data: string }) => void;
  } = {}
): Disposable {
  let disposed = false;
  port.onFrame((frame: TerminalHostFrame) => {
    // Once disposed, STOP consuming: a frame that arrives between dispose() and
    // the port actually closing must never write to (or ack for) a torn-down
    // view — that would throw on a disposed XTerm and keep the pty running
    // full-speed into a dead terminal.
    if (disposed) {
      return;
    }
    if (frame.type === "data") {
      view.write(frame.data);
      handlers.onActivity?.({ kind: "output", data: frame.data });
      // ACK immediately on consume — the host counts unacked bytes and pauses the
      // pty past a high-water mark, resuming when we drain it. Skipping the ack
      // would stall a busy session.
      port.post({ type: "ack", seq: frame.seq });
    } else if (frame.type === "error") {
      // A refused open, or a session that died without printing. Surfaced in
      // the pane AND to the component: a blank rectangle with no explanation
      // is the failure mode this frame exists to remove.
      view.markError?.(frame.reason);
      handlers.onError?.(frame.reason);
    } else {
      view.markExited({
        exitCode: frame.exitCode,
        lifetimeMs: frame.lifetimeMs,
        ...(frame.signal !== undefined ? { signal: frame.signal } : {}),
      });
    }
  });

  const input = view.onInput((data) => {
    handlers.onActivity?.({ kind: "input", data });
    port.post({ type: "write", data });
  });
  const resize = view.onResize(({ cols, rows }) =>
    port.post({ type: "resize", cols, rows })
  );

  return {
    dispose() {
      disposed = true;
      input.dispose();
      resize.dispose();
    },
  };
}
