import { useEffect, useRef } from "react";
import { createXtermView } from "./lib/xterm-view.js";
import type { TerminalView } from "./lib/terminal-wire.js";

export interface FrozenTerminalTabProps {
  sessionId: string;
  /** The scrollback captured at the LAST quit, before this tab's pty was
   *  killed (ROADMAP T1). Rendered read-only — nothing here can write to a
   *  pty, because there is no live one to write to. */
  scrollback: string;
  /** The operator has explicitly acknowledged: clear the frozen state and let
   *  the caller mount a live `TerminalPreview`, which spawns a FRESH pty
   *  under this same session id (T1 step 4). */
  onAcknowledge: () => void;
  /** Builds the XTerm-backed view (or a fake in tests). Defaults to the real,
   *  read-only XTerm view in production. */
  createView?: (container: HTMLElement) => TerminalView;
  /** This pane is BACKGROUNDED (another workspace tab is on screen). Same
   *  show/hide-only contract as `TerminalTab`: nothing here re-writes or
   *  re-opens anything, it only re-measures on the way back so a container
   *  that was 0×0 at mount time lays out correctly once shown. */
  hidden?: boolean;
}

/**
 * ROADMAP T1 step 3 — the frozen, read-only body of a cold-restored human
 * terminal tab.
 *
 * It writes the captured scrollback into a READ-ONLY view (`disableStdin`,
 * no input/resize wiring at all — there is no pty on the other end of this
 * pane, only bytes MUON already has) behind a banner explaining why, with the
 * one action that ends the frozen state: reconnect. It never opens
 * `window.muon.terminal.open` itself; the caller (app.tsx) swaps this
 * component out for a live `TerminalPreview` once `onAcknowledge` fires,
 * which is what actually spawns the fresh interactive shell.
 *
 * Renders its banner + terminal body as SIBLINGS (not wrapped in an extra
 * div) so it drops into the existing `.workspace-terminal-shell` flex column
 * exactly the way that shell's own CSS already expects — see the "one-line
 * honesty note, then the pty fills" rule in styles.css.
 */
export function FrozenTerminalTab(props: FrozenTerminalTabProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<TerminalView | null>(null);
  const { sessionId, scrollback } = props;
  const createView = props.createView ?? defaultReadOnlyView;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const view = createView(container);
    viewRef.current = view;
    view.write(scrollback);
    return () => {
      viewRef.current = null;
      view.dispose();
    };
    // Re-render only when the session identity or its captured text changes;
    // `createView` is stable in production (module-level default) and tests
    // pass a stable fake.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, scrollback]);

  // Same re-measure-on-return contract as the live TerminalTab: a hidden
  // container reports 0×0 at mount, so coming back into view needs one more
  // fit pass to lay out at the pane's real size.
  const hidden = props.hidden === true;
  useEffect(() => {
    if (hidden) {
      return;
    }
    viewRef.current?.refit?.();
  }, [hidden]);

  return (
    <>
      <div className="terminal-frozen-banner" role="status">
        <span>
          This session ended when MUON quit. Showing its last output,
          read-only.
        </span>
        <button
          className="ghost-btn"
          onClick={props.onAcknowledge}
          type="button"
        >
          Reconnect
        </button>
      </div>
      <div
        className="terminal-tab terminal-tab-frozen"
        data-session={sessionId}
        ref={containerRef}
      />
    </>
  );
}

function defaultReadOnlyView(container: HTMLElement): TerminalView {
  return createXtermView(container, { readOnly: true });
}
