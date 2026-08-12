import { terminalSafe } from "@muon/client";
import { CURSOR_MARKER, type Component } from "../vendor/pi-tui/src/tui.ts";
import { dim, red, yellow } from "./theme.js";
import type { PtySession } from "./pty-session.js";

/**
 * The centre pane that shows a live pty session (ADR-0046 D1).
 *
 * Deliberately thin: the SESSION owns the process and the emulator
 * (`pty-session.ts` — its header is the design), this class only reads the
 * screen each frame and adds MUON's chrome around it. Hiding the pane stops
 * reads; it can never stop the child.
 *
 * What is and is not sanitized, stated because it looks inconsistent and is
 * not: the pane INTERIOR is the child's own screen — serialized emulator
 * state, text + SGR only — and rewriting it would violate D1 ("MUON never
 * rewrites what is inside"). The chrome lines (title, banners) are MUON's
 * surface carrying STORED text, so they flatten like every other component.
 */
export class PtyPane implements Component {
  private readonly session: PtySession;
  /**
   * Whether THIS pane takes the keystrokes — the desk decides, not the engine,
   * because the engine only ever sees one focused component (the shell) and
   * cannot know which half of a split is live.
   *
   * It exists for one reason: only a focused pane may claim the hardware
   * cursor. A split showed two cursors otherwise, which is worse than none.
   */
  private readonly focused: boolean;

  constructor(session: PtySession, options: { focused?: boolean } = {}) {
    this.session = session;
    this.focused = options.focused ?? false;
  }

  handleInput(data: string): void {
    // Focused pane → child, verbatim. The shell's own chords are filtered
    // upstream by the key dispatcher before this is reached.
    this.session.write(data);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];

    // D5 — the honesty banner. Carried on the SESSION so every chrome agrees.
    if (this.session.spec.ungoverned) {
      lines.push(
        yellow(` UNGOVERNED `) +
          dim(` ${terminalSafe(this.session.spec.title)} — MUON does not govern this pane`)
      );
    }

    // THE CURSOR. A terminal without one is not a terminal you can type in —
    // the founder's screenshot showed a live vendor CLI with no caret anywhere
    // and no way to tell whether the keyboard was even connected. The engine
    // already has the contract (emit CURSOR_MARKER where the cursor belongs,
    // it strips the marker and puts a REAL cursor there); this pane simply
    // never opted in. Only when focused, and only when the child asked for a
    // cursor at all — a full-screen TUI that hides its own must stay hidden.
    lines.push(...this.session.renderScreen(this.focused ? CURSOR_MARKER : undefined));

    // F8/F9 — the exit banner, inside the pane where the human is looking.
    const exit = this.session.exit;
    if (exit) {
      const banner = `[session exited: code ${exit.code}]`;
      lines.push(exit.code === 0 ? dim(banner) : red(banner));
    }

    return lines.map((line) => (line.length > width * 4 ? line.slice(0, width * 4) : line));
  }
}
