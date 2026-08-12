import { spawn as ptySpawn, type IPty } from "node-pty";
// DEFAULT-import interop, not a style choice: @xterm/headless@6 ships a UMD
// CJS bundle with no `exports` map, and Node's cjs-module-lexer cannot detect
// `Terminal` as a named export — `import { Terminal }` compiles clean under
// vitest (vite-node does its own interop) and then crashes the REAL compiled
// entry at startup. Found by an adversarial review running the built output;
// the suite structurally cannot catch it.
import { sanitizeSpawnEnv } from "@muon/client/terminal-vendor-tabs";
import { Screen } from "./screen.js";

/**
 * A live pty session — the vendor's (or the human's) real process, emulated
 * in-process (ADR-0046 D1/D2).
 *
 * THE ARCHITECTURE IS THE LESSON. The desktop paid for two regressions
 * (`apps/desktop/src/renderer/app.tsx:3155-3176`,
 * `session-workspace.tsx:918-925`): unmounting a pane detached its relay, OS
 * backpressure then paused the child mid-render, and remounting replayed a
 * bounded byte ring from mid-escape-sequence. Both doors onto one defect —
 * the terminal's LIFE was owned by the thing that DREW it.
 *
 * So here the session owns nothing visual and the pane owns nothing live:
 *
 *  - This class holds the pty and the headless emulator. It consumes every
 *    byte the moment it arrives, whether or not anything renders it — there
 *    is no relay to detach and no ring to replay, because the emulator IS
 *    the state.
 *  - The pane (`pty-pane.ts`) merely reads `renderScreen()` on each frame.
 *    Hiding a tab stops the READS; the session never notices.
 *
 * WHY EMULATE AT ALL (rather than splicing child bytes into our screen): the
 * child believes it owns a terminal and emits cursor moves, alt-screen
 * enters, mouse-mode toggles. Written raw into OUR alt-screen they would
 * hijack the whole shell. The emulator absorbs them; what the pane renders is
 * the child's SCREEN STATE — its own look, per D1, without its control flow.
 *
 * GOVERNANCE HONESTY (D5): `ungoverned` is carried on the session, not
 * inferred at render, so every surface labels it identically.
 */

export type PtySessionSpec = {
  readonly id: string;
  /** Shown in the tab; STORED text, sanitized by the chrome that renders it. */
  readonly title: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Drives the env strip: a login SHELL keeps the user's ambient GitHub
   *  authority, a VENDOR CLI does not. MUON's own tokens are stripped for
   *  both — an ungoverned pane holding the operator bearer is a privilege
   *  escalation waiting for a prompt injection. */
  readonly envKind: "shell" | "vendor";
  /** D5: a human/custom pane is ungoverned and every chrome says so. */
  readonly ungoverned: boolean;
  readonly cols: number;
  readonly rows: number;
};

export type PtyExit = {
  readonly code: number;
  /** Runtime in ms — drives the F8 rule (fast failure keeps the pane). */
  readonly runtimeMs: number;
};

export class PtySession {
  readonly spec: PtySessionSpec;
  private pty: IPty | null = null;
  private readonly screen: Screen;
  private readonly startedAt: number;
  private exitState: PtyExit | null = null;
  /** Last dimensions actually pushed to the child — see `resize`. */
  private lastCols = -1;
  private lastRows = -1;
  private onChange: (() => void) | null = null;

  constructor(
    spec: PtySessionSpec,
    now: () => number = Date.now
  ) {
    this.spec = spec;
    this.startedAt = now();
    this.screen = new Screen(spec.cols, spec.rows);
    this.pty = ptySpawn(spec.command, [...spec.args], {
      name: "xterm-256color",
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      // SANITIZED, the same rule as the desktop's terminal-spawn boundary
      // (now shared): MUON's control-plane tokens never reach a human pane.
      env: {
        ...sanitizeSpawnEnv(process.env, { kind: spec.envKind }),
        ...(spec.env ?? {}),
      },
    });
    this.pty.onData((data) => {
      // Consumed IMMEDIATELY, rendered later (or never). This line is the
      // whole fix for the desktop's backpressure stall.
      this.screen.write(data);
      this.onChange?.();
    });
    this.pty.onExit(({ exitCode }) => {
      this.exitState = { code: exitCode, runtimeMs: now() - this.startedAt };
      this.pty = null;
      // F18 — disarm: the child may have died with mouse tracking, bracketed
      // paste or the alt screen armed; reset the EMULATOR so the final frame
      // renders sanely. (Our host terminal was never armed — the emulator
      // absorbed those modes — so only the emulated state needs the reset.)
      this.screen.disarm();
      this.onChange?.();
    });
  }

  /** The pane subscribes for repaint nudges; at most one listener. */
  subscribe(listener: () => void): void {
    this.onChange = listener;
  }

  /** The mouse reports this child armed — see `Screen.mouseTracking`. */
  get mouseTracking(): "none" | "x10" | "vt200" | "drag" | "any" {
    return this.screen.mouseTracking;
  }

  get alive(): boolean {
    return this.pty !== null;
  }

  get exit(): PtyExit | null {
    return this.exitState;
  }

  /**
   * Keystrokes from the focused pane go to the child — verbatim, with ONE
   * emulation-correct exception. The HOST terminal always runs with
   * bracketed paste armed (the engine arms it), so a paste arrives wrapped
   * in `ESC[200~ … ESC[201~`. A child that ENABLED the mode expects the
   * wrapper; a plain `/bin/sh` that never did renders it as literal
   * `[200~ls[201~` garbage on its own prompt. The emulator tracks the
   * child's real DECSET 2004 state, so the wrapper is forwarded exactly when
   * the child asked for it and stripped when it did not — which is what a
   * real terminal does.
   */
  write(data: string): void {
    if (!this.pty) return;
    const esc = String.fromCodePoint(0x1b);
    if (!this.screen.bracketedPaste) {
      data = data
        .replaceAll(`${esc}[200~`, "")
        .replaceAll(`${esc}[201~`, "");
    }
    // APPLICATION CURSOR KEYS (DECSET 1) — the second reason the founder's up
    // and down arrows did nothing.
    //
    // A full-screen TUI arms this and then listens for `ESC O A`, not
    // `ESC [ A`. Our HOST terminal is in whatever mode MUON's own engine put
    // it in, which is the normal one, so it sends the normal form — and
    // forwarding that verbatim hands the child a sequence it has explicitly
    // stopped listening for. The emulator already tracks the child's real
    // DECCKM state, so this re-encodes exactly when the child asked for it,
    // which is what a real terminal does.
    //
    // MODIFIED arrows keep the CSI form: `ESC [ 1 ; 5 A` stays as it is in
    // application mode, because SS3 has nowhere to put a modifier. That is not
    // a shortcut — it is what xterm does, and what every CLI parses.
    if (this.screen.applicationCursorKeys) {
      for (const final of ["A", "B", "C", "D", "H", "F"]) {
        data = data.replaceAll(`${esc}[${final}`, `${esc}O${final}`);
      }
    }
    this.pty.write(data);
  }

  /** F16: the child's geometry follows the pane. */
  resize(cols: number, rows: number): void {
    // IDEMPOTENT. A pty resize is a TIOCSWINSZ, and the child gets SIGWINCH
    // whether or not anything changed — a full-screen CLI redraws on it. The
    // desk now re-sizes on every session change (a close re-widths the
    // survivor), so unchanged dimensions must cost nothing rather than make
    // every tab switch flash the children.
    if (cols === this.lastCols && rows === this.lastRows) return;
    this.lastCols = cols;
    this.lastRows = rows;
    this.screen.resize(cols, rows);
    this.pty?.resize(cols, rows);
  }

  /**
   * The child's screen — text + SGR only (see `Screen`).
   *
   * `cursorMarker` is passed through so a FOCUSED pane can hand the engine a
   * real hardware cursor; every other caller (the ADR-0047 capture, the split
   * that does not have focus) omits it and gets the plain screen.
   */
  renderScreen(cursorMarker?: string): string[] {
    return this.screen.renderScreen(cursorMarker);
  }

  dispose(): void {
    this.pty?.kill();
    this.pty = null;
    this.screen.dispose();
  }
}
