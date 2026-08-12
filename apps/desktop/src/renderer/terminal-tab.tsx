import { useEffect, useRef } from "react";
import { spawnWithMeasuredSize } from "./lib/terminal-geometry.js";
import {
  wireTerminal,
  type Disposable,
  type TerminalExit,
  type TerminalView,
} from "./lib/terminal-wire.js";
import {
  defaultParkedTerminalStore,
  type ParkedTerminalStore,
} from "./lib/parked-terminal-store.js";
import type {
  TerminalClientPort,
  TerminalHostFrame,
  TerminalSpawn,
} from "../shared/terminal-protocol.js";

export type { TerminalSpawn };

/**
 * ROADMAP T4 — production replay source for a park cycle the in-memory LRU no
 * longer holds (the store was evicted, or this is the very first attach): the
 * SAME live scrollback ring T1's cold-restore reads at quit, just asked for
 * while the app keeps running. Optional-chained so an older main process
 * (missing the bridge method) degrades to "nothing to replay" instead of a
 * throw, and any transport failure resolves `null` the same way.
 */
async function bridgeFetchHostScrollback(
  sessionId: string
): Promise<{ text: string; cols: number; rows: number } | null> {
  const fetcher = window.muon?.terminal?.scrollback;
  if (typeof fetcher !== "function") {
    return null;
  }
  try {
    return await fetcher(sessionId);
  } catch {
    return null;
  }
}

export interface TerminalTabProps {
  sessionId: string;
  spawn: TerminalSpawn;
  /** Opens (or re-attaches to) the per-session byte channel. Injected so the
   *  component is testable without an Electron runtime; production wires it to
   *  `window.muon.terminal.open`. */
  openPort: (
    sessionId: string,
    spawn: TerminalSpawn
  ) => Promise<TerminalClientPort>;
  /** Builds the XTerm-backed view (or a fake in tests). */
  createView: (container: HTMLElement) => TerminalView;
  onExit?: (exit: TerminalExit) => void;
  /**
   * The host refused this open, or the session died without printing (a vendor
   * binary that is not installed). Lets the surrounding tab explain itself
   * outside the terminal body, where a human actually looks.
   */
  onError?: (reason: string) => void;
  /**
   * ROADMAP T2 — every output frame and every keystroke, passed straight
   * through from `wireTerminal`. Held in a ref below like `onError`, so a
   * changing callback identity never re-opens the session.
   */
  onActivity?: (event: { kind: "output" | "input"; data: string }) => void;
  /**
   * This pane is BACKGROUNDED — still mounted, still attached, still acking,
   * just not on screen. Switching workspace tabs sets this instead of
   * unmounting: a live vendor session must keep running, keep its pty, and keep
   * its scrollback exactly as the human left it.
   *
   * It is NOT a lifecycle flag. Nothing opens, closes, or re-attaches when it
   * changes; the only effect is a re-measure when the pane comes back, because
   * a hidden container reports 0×0 and would otherwise leave the grid (and the
   * pty's window size) stuck at whatever it was.
   */
  hidden?: boolean;
  /**
   * ROADMAP T4 — PARKED-RUNTIME LRU. `true` when the coordinator (app.tsx's
   * LRU over every mounted human/takeover terminal) has decided this pane's
   * RENDERER resources should be released while it is backgrounded: the XTerm
   * instance is disposed — freeing its DOM/canvas/scrollback memory — while
   * the pty host session and the byte channel are left EXACTLY alone (no
   * close frame, no `port.close()`; the pty keeps running, unattended, the
   * same way a `hidden` pane's pty already does).
   *
   * The pane's on-screen state is captured first (the SerializeAddon buffer,
   * when the view supports one — see `TerminalView.serialize`) so flipping
   * this back to `false` replays it into a freshly created XTerm instead of a
   * blank pane, topped up with whatever the host sent while parked.
   *
   * Distinct from `hidden`: `hidden` never tears anything down. A caller
   * should only ever park a pane that is ALSO hidden — this component trusts
   * the coordinator rather than re-deriving that itself.
   */
  parked?: boolean;
  /** Injectable for tests; defaults to the real bridge in production. */
  fetchHostScrollback?: (
    sessionId: string
  ) => Promise<{ text: string; cols: number; rows: number } | null>;
  /** Injectable for tests; defaults to the module-level store every human
   *  terminal tab in the app shares, so the LRU cap bounds the whole window. */
  parkedStore?: ParkedTerminalStore;
}

/**
 * Wave 4 §5.0.3 — the live-terminal body of one governed lane tab. It owns only
 * the RENDERER wiring: build a view, open the session's byte channel, and connect
 * them with wireTerminal (which acks for backpressure). It NEVER sends a `close`
 * frame on unmount — a window reload must leave the session alive in the host so a
 * remount re-attaches and replays scrollback (reconnect). Killing the pty is a
 * deliberate, separate action.
 */
export function TerminalTab(props: TerminalTabProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { sessionId, spawn, openPort, createView, onExit } = props;
  // Held in a ref so a changing callback identity cannot re-open the session
  // (the effect deliberately depends on `sessionId` alone).
  const onErrorRef = useRef(props.onError);
  onErrorRef.current = props.onError;
  const onActivityRef = useRef(props.onActivity);
  onActivityRef.current = props.onActivity;
  // The live view, for the visibility re-measure below. Never a reason to
  // re-open: it is set by the mount effect and cleared whenever the view is
  // torn down — by unmount OR by a park.
  const viewRef = useRef<TerminalView | null>(null);
  const parkedStore = props.parkedStore ?? defaultParkedTerminalStore;
  const fetchHostScrollback =
    props.fetchHostScrollback ?? bridgeFetchHostScrollback;
  // What the `parked` prop wants RIGHT NOW — read from the mount effect's
  // async continuation, where a plain closure variable captured at effect-run
  // time would be stale for a park requested before the port finished opening.
  const wantParkedRef = useRef(props.parked === true);
  wantParkedRef.current = props.parked === true;
  // Exposes park()/resume() to the `parked`-prop effect below. Only valid
  // once the mount effect has run for the CURRENT sessionId; null in between
  // (a stale controller from a torn-down session must never be called).
  const controllerRef = useRef<{ park: () => void; resume: () => void } | null>(
    null
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let torndown = false;
    let port: TerminalClientPort | undefined;
    let wire: Disposable | undefined;
    // Tracks whether the RENDERER VIEW is currently released — independent of
    // (and initially unrelated to) `props.parked`, which this effect does not
    // read directly; `wantParkedRef` and the resume/park calls below do.
    let parked = false;

    const wrapView = (created: TerminalView): TerminalView =>
      onExit
        ? {
            ...created,
            markExited: (exit) => {
              created.markExited(exit);
              onExit(exit);
            },
          }
        : created;

    /** (Re)create the XTerm instance, replay `initialWrite` into it, and wire
     *  it live to the (already-open) port. */
    const attach = (initialWrite?: string) => {
      const activePort = port;
      if (!activePort) {
        return;
      }
      const created = createView(container);
      viewRef.current = created;
      const view = wrapView(created);
      if (initialWrite) {
        view.write(initialWrite);
      }
      wire = wireTerminal(activePort, view, {
        onError: (reason) => onErrorRef.current?.(reason),
        onActivity: (event) => onActivityRef.current?.(event),
      });
    };

    /** ROADMAP T4 — release the XTerm instance; the port (and the pty behind
     *  it) stays exactly as it is. */
    const park = () => {
      const activePort = port;
      if (parked || !activePort) {
        return;
      }
      const view = viewRef.current;
      if (view) {
        parkedStore.park(sessionId, {
          serialized: view.serialize?.() ?? "",
          cols: view.size?.()?.cols ?? 0,
          rows: view.size?.()?.rows ?? 0,
        });
      }
      wire?.dispose();
      wire = undefined;
      view?.dispose();
      viewRef.current = null;
      parked = true;
      // Keep consuming the port so the host never sees backpressure (a
      // parked build should not stall because nobody is reading it) and so
      // bytes printed while parked are not lost — buffered instead of
      // rendered, capped by the store's own bound. `port.onFrame` REPLACES
      // the previous listener (the live `wireTerminal` one just disposed
      // above), never accumulates a second one.
      activePort.onFrame((frame: TerminalHostFrame) => {
        if (torndown || !parked) {
          return;
        }
        if (frame.type === "data") {
          parkedStore.appendPending(sessionId, frame.data);
          activePort.post({ type: "ack", seq: frame.seq });
        }
        // An exit/error while parked has nowhere to render — `attach` on the
        // next resume re-wires wireTerminal, which (like an ordinary
        // reconnect) is told the exit again the moment it re-attaches.
      });
    };

    /** ROADMAP T4 — recreate the XTerm instance and replay everything the
     *  pane missed while parked. */
    const resume = () => {
      if (!parked) {
        return;
      }
      parked = false;
      const taken = parkedStore.take(sessionId);
      if (taken) {
        attach(taken.serialized + taken.pending);
        return;
      }
      // Nothing in memory (the LRU evicted this entry, or this is a resume
      // with no prior park in this window) — attach live immediately rather
      // than block on the network-free-but-still-async host round trip, then
      // top up with whatever the host itself retained.
      attach();
      void fetchHostScrollback(sessionId).then((snapshot) => {
        if (torndown || parked || !snapshot) {
          return;
        }
        viewRef.current?.write(snapshot.text);
      });
    };

    controllerRef.current = { park, resume };

    const initialView = createView(container);
    viewRef.current = initialView;
    const view = wrapView(initialView);

    // The pty is opened at the grid this pane HAS, not at the driver default.
    // A pane that cannot measure itself sends nothing and the host keeps its
    // own defaults — see spawnWithMeasuredSize.
    openPort(sessionId, spawnWithMeasuredSize(spawn, initialView))
      .then((opened) => {
        if (torndown) {
          // Unmounted before the channel opened — close it so the host detaches
          // (the session survives in the host for a later mount).
          opened.close();
          return;
        }
        port = opened;
        wire = wireTerminal(opened, view, {
          onError: (reason) => onErrorRef.current?.(reason),
          onActivity: (event) => onActivityRef.current?.(event),
        });
        // A park was requested before the port even finished opening —
        // honour it now instead of silently dropping the request.
        if (wantParkedRef.current) {
          park();
        }
      })
      .catch(() => {
        // The channel failed to open (main error / timeout). Surface it on the
        // view instead of leaving a permanently blank terminal. `lifetimeMs: 0`
        // is the literal truth — nothing ever ran — and it keeps the tab (and
        // this message) on screen instead of auto-closing it.
        if (!torndown) {
          view.markExited({ exitCode: -1, lifetimeMs: 0 });
        }
      });

    return () => {
      torndown = true;
      controllerRef.current = null;
      wire?.dispose();
      // Close the port so the host DETACHES (session + scrollback survive for a
      // remount). This is NOT a `close` frame — the pty is never killed here.
      port?.close();
      const currentView = viewRef.current;
      viewRef.current = null;
      currentView?.dispose();
    };
    // Re-open only when the session identity changes; the injected fns are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ROADMAP T4 — react to `parked` transitions. Runs AFTER the mount effect
  // above (declared first, same commit), so `controllerRef.current` is always
  // set by the time this reads it; a park/resume requested before the port
  // has actually opened is captured by `wantParkedRef` instead and honoured
  // the instant the open resolves (see the mount effect's `.then`).
  useEffect(() => {
    if (props.parked) {
      controllerRef.current?.park();
    } else {
      controllerRef.current?.resume();
    }
  }, [props.parked]);

  // Coming back from the background: re-measure. A hidden container reports
  // 0×0, so the grid — and with it the pty's window size — would otherwise stay
  // at whatever it was when the human switched away, which is precisely the
  // "it doesn't fit" the founder saw after a tab switch. Skipped while parked:
  // there is no view to refit until `resume()` creates a fresh one (which
  // fits synchronously on creation, same as the very first mount).
  const hidden = props.hidden === true;
  useEffect(() => {
    if (hidden || props.parked) {
      return;
    }
    viewRef.current?.refit?.();
  }, [hidden, props.parked]);

  return (
    <div
      className="terminal-tab"
      data-session={sessionId}
      ref={containerRef}
    />
  );
}
