import { terminalSafe, terminalSafeScreen } from "@muon/client";
import type { Component } from "../vendor/pi-tui/src/tui.ts";
import { bold, dim, yellow } from "./theme.js";
import type { RestoreEntry } from "./restore-snapshot.js";

/**
 * A FROZEN pane — the last quit's screen, per ADR-0047 D2: a corpse, not a
 * session.
 *
 * Nothing here is attached to anything. There is no `handleInput`, so the
 * engine cannot route a keystroke into it, and no pty is spawned for it ever
 * — the human acknowledges the tab, and THAT mints a new, ungoverned,
 * labelled session with a new id. The failure this shape forbids is a pane
 * that looks live, takes typing, and silently starts a shell inheriting a cwd
 * and an environment from a run the human may not remember.
 *
 * The interior is SANITIZED here, unlike a live pane's. That looks like an
 * inconsistency with ADR-0046 D1 and is the opposite: a live pane's interior
 * is the child's own screen, rendered under our supervision moment to moment.
 * This text is agent-authored bytes read back off DISK a run later — the
 * evasion corpus's exact surface, with the twist that the payload survived a
 * restart (ADR-0047 D3).
 */
export class FrozenPane implements Component {
  private readonly entry: RestoreEntry;

  constructor(entry: RestoreEntry) {
    this.entry = entry;
  }

  invalidate(): void {}

  render(width: number): string[] {
    // Header AND instructions both above the body: composed below it, the
    // shell's row budget clipped the only line that says what to do, on any
    // terminal shorter than the captured screen.
    const lines: string[] = [
      yellow(` ENDED `) +
        dim(
          ` ${terminalSafe(this.entry.label)} — this session ended when MUON last quit`
        ),
      bold(dim(" ⏎ start a new session here · x discard this tab")) +
        dim(" — nothing is running"),
    ];

    // Sanitized as a BLOCK — the restored screen is one untrusted document —
    // and then TABS TOO, which the block sanitizer deliberately preserves for
    // prose bodies. A captured screen is reconstructed cell by cell, so the
    // emulator already expanded every tab to spaces: a tab surviving in this
    // text did not come from our capture path, it came from a hand-edited
    // file, and its only use here is forging column alignment.
    // LOOP, never `push(...array)`: the spread puts every element on the
    // CALL STACK, and a 256 KiB bound permits ~262k newlines — a within-bounds
    // snapshot blew the stack inside the render tick, which is uncaught, so
    // the desk died without stopping the engine and left the terminal in the
    // alt screen. The read-side line bound below is the primary control; this
    // is the shape that cannot amplify it.
    for (const line of terminalSafeScreen(this.entry.text)
      .replaceAll("\t", " ")
      .split("\n")) {
      lines.push(line);
    }

    return lines.map((line) =>
      line.length > width * 4 ? line.slice(0, width * 4) : line
    );
  }
}
