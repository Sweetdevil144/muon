// Wave 4 §2.5 — the byte-transport protocol between the renderer (XTerm) and the
// Electron-main PTY relay. It is TRANSPORT-AGNOSTIC: in production the two ends
// are the halves of a per-session MessageChannelMain; in tests they are fakes.
//
// INVARIANT (I1/I3): a frame carries BYTES and coordinates only — never a token,
// secret, or vendor credential. Trusted main resolves and spawns an allowlisted
// command; the relay itself only moves bytes. Keeping the wire a small typed
// union is what makes that auditable.

/** Renderer terminal-kind hint. Trusted main ignores renderer argv/env/cwd on
 *  the real path and derives the command plus workspace itself. */
export interface TerminalSpawn {
  file: string;
  args?: string[];
  cwd: string;
  /**
   * The pane's MEASURED terminal geometry at the moment of the open, so the
   * child is BORN at the size it will be read at.
   *
   * These are COORDINATES, not authority — the same class as the `resize`
   * frame this bridge already carries in the other direction, and the host
   * bounds them before they reach a pty (see terminal-host.ts). They exist
   * because a pty created at the driver default (80×24) and only resized once
   * the first fit lands makes a full-screen vendor TUI paint its whole first
   * frame at the wrong width. Some TUIs reflow cleanly on the later SIGWINCH;
   * others repaint over the 80-column frame they already drew, which is what a
   * human reads as "the stream is distorted".
   *
   * Optional and omitted whenever the pane cannot honestly measure itself
   * (mounted hidden, container not laid out yet): the host then keeps its own
   * defaults and the first real fit resizes the pty as before.
   */
  cols?: number;
  rows?: number;
}

/** Renderer → host (main). */
export type TerminalClientFrame =
  | { type: "write"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ack"; seq: number }
  | { type: "close" };

/** Host (main) → renderer. */
export type TerminalHostFrame =
  | { type: "data"; seq: number; data: string }
  /**
   * The child ended. `lifetimeMs` is how long it ACTUALLY lived, measured
   * host-side from the spawn to the OS-level exit (PtyHost stamps it on the
   * session record), and it is REQUIRED for one reason: both sides of this
   * bridge decide "did this ever become a session, or did it fail to launch"
   * and they must decide it from the same number. The renderer used to
   * subtract its own tab-creation time from `Date.now()` at the moment the
   * frame arrived — a different epoch (it predates the host's node-pty load
   * and workspace resolution) read at a different instant (a replayed exit
   * arrives whenever the human comes back). Two clocks, one question, two
   * answers.
   */
  | { type: "exit"; exitCode: number; signal?: number; lifetimeMs: number }
  /**
   * The host REFUSED this open, or the session died before printing anything.
   *
   * Every refusal used to be a stderr line in the main process and an early
   * `return`, so the renderer's `open()` never settled and the human got a
   * permanently blank pane — indistinguishable from a hung terminal. A refusal
   * is a normal, expected outcome (a governed attach id, an unresolvable
   * worktree, a job with no recorded vendor session, a vendor binary that is
   * not installed), so it gets a typed frame and a sentence.
   *
   * `reason` is HOST-authored prose. It never carries vendor output, a path,
   * or any credential — the same rule the rest of this union follows.
   *
   * ONE EXACT EXCEPTION, stated because the flat claim was false: a refusal for
   * an un-allowlisted terminal KIND names the kind, and the kind is the
   * renderer's own `spawn.file`. So the sentence is host-authored and the noun
   * inside it is not. The host therefore treats it as untrusted text on the way
   * out — flattened to printable single-line by `terminalSafe` and length-bound
   * (see `hostReason` in lib/terminal-host.ts, and `terminalKindLabel` in
   * lib/terminal-spawn.ts, which is where the kind first enters prose). Renders
   * as text; no consumer of this frame may interpret it as markup or escapes.
   */
  | { type: "error"; reason: string };

/** The per-session duplex the RELAY (Electron main) owns. */
export interface TerminalRelayPort {
  /** Push a host→renderer frame (data/exit). */
  post(frame: TerminalHostFrame): void;
  /** Subscribe to renderer→host frames (write/resize/ack/close). */
  onFrame(listener: (frame: TerminalClientFrame) => void): void;
  /** Fires when the renderer end goes away (window reload/crash). */
  onClose(listener: () => void): void;
}

/** The per-session duplex the RENDERER owns. */
export interface TerminalClientPort {
  /** Push a renderer→host frame. */
  post(frame: TerminalClientFrame): void;
  /** Subscribe to host→renderer frames. */
  onFrame(listener: (frame: TerminalHostFrame) => void): void;
  /**
   * Tear down the underlying channel (window reload / tab switch). This closes
   * the MessagePort so the host DETACHES — the session and its scrollback SURVIVE
   * for reconnect. It does NOT kill the pty (that is an explicit `close` FRAME).
   */
  close(): void;
}
