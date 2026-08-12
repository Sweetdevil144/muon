import { useCallback } from "react";
import { TerminalTab } from "./terminal-tab.js";
import { createXtermView } from "./lib/xterm-view.js";
import type { TerminalExit, TerminalView } from "./lib/terminal-wire.js";
import type { TerminalSpawn } from "../shared/terminal-protocol.js";

/**
 * Wave 4 §5.0.3 — the PRODUCTION-wired terminal tab body: it binds the tested
 * TerminalTab to the real transport (`window.muon.terminal.open`, a
 * MessageChannelMain byte channel) and the real XTerm view. Kept behind a feature
 * guard in SessionWorkspace until the pivot is proven; on the fake path it shows
 * the echo driver, and swapping to a real vendor pty is the node-pty spike (P5)
 * with no change to this component.
 */
export function TerminalPreview(props: {
  sessionId: string;
  spawn: TerminalSpawn;
  onExit?: (exit: TerminalExit) => void;
  /** The host refused the open, or the session died without printing. */
  onError?: (reason: string) => void;
  /** ROADMAP T2 — output/input activity, passed straight through to the
   *  human-terminal-tab activity dot (lib/terminal-activity.ts). */
  onActivity?: (event: { kind: "output" | "input"; data: string }) => void;
  /** Backgrounded (another workspace tab is on screen). Show/hide only — the
   *  pty, the channel, and the scrollback all stay exactly as they are. */
  hidden?: boolean;
  /** ROADMAP T4 — PARKED-RUNTIME LRU. When true, the coordinator has decided
   *  this pane's XTerm instance should be released while backgrounded; the
   *  pty session and byte channel are untouched. See `TerminalTab.parked`. */
  parked?: boolean;
  /** ROADMAP T4 — OSC-8 hyperlink allowlist root. Null/omitted denies every
   *  path-shaped link (http(s) links are unaffected). */
  workspaceRoot?: string | null;
  /** ROADMAP T4 — fires with this pane's find-box controller whenever its
   *  XTerm instance attaches, and with `null` when it is released (park,
   *  unmount). A caller only cares about this for the ACTIVE tab. */
  onSearchController?: (controller: TerminalView["search"] | null) => void;
}) {
  const createView = useCallback(
    (container: HTMLElement): TerminalView => {
      const view = createXtermView(container, {
        workspaceRoot: props.workspaceRoot ?? null,
      });
      props.onSearchController?.(view.search);
      return {
        ...view,
        // A park or unmount disposes the view directly (terminal-tab.tsx) —
        // intercepted here so the registered search controller is cleared
        // the instant it stops pointing at a live XTerm instance, rather
        // than leaving a stale (post-dispose) controller registered.
        dispose: () => {
          props.onSearchController?.(null);
          view.dispose();
        },
      };
    },
    // Deliberately NOT reactive to onSearchController identity — createView is
    // handed to TerminalTab once per session mount, so a changing callback
    // reference here must not be read as "re-open the session".
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.workspaceRoot]
  );
  return (
    <TerminalTab
      sessionId={props.sessionId}
      spawn={props.spawn}
      openPort={(sessionId, spawn) => window.muon.terminal.open(sessionId, spawn)}
      createView={createView}
      {...(props.onExit ? { onExit: props.onExit } : {})}
      {...(props.onError ? { onError: props.onError } : {})}
      {...(props.onActivity ? { onActivity: props.onActivity } : {})}
      {...(props.hidden !== undefined ? { hidden: props.hidden } : {})}
      {...(props.parked !== undefined ? { parked: props.parked } : {})}
    />
  );
}
