import { memoryMarkerTag, memoryNoteMarkers, terminalSafe } from "@muon/client";
import type { MemoryLibraryNote } from "@muon/client/memory-library";
import type { Component } from "../vendor/pi-tui/src/tui.ts";
import { bold, cyan, dim, green, red, yellow } from "./theme.js";

/**
 * The memory pane — crew memory, readable and actionable (matrix rows
 * C4–C9, C10).
 *
 * Markers come from the SHARED `memoryNoteMarkers` / `memoryMarkerTag`, never
 * a local restatement. That rule is not stylistic: this panel's ancestor kept
 * a private tier copy, it drifted, and the same note read "Auto · crew
 * memory" on the desktop while sitting here as review homework (P0-3). The
 * `·review` debt marker has the same hazard (P0-2) — it must mean NOBODY has
 * vouched, not merely that no human has.
 *
 * THE POSTURE IS REQUIRED, not defaulted. `autoConfirmAgentMemory` decides
 * whether a crew-visible note is settled memory or homework, so it is passed
 * in explicitly; a pane that guessed it would bill the operator for work MUON
 * had already done.
 */

export type MemoryPaneState = {
  readonly notes: readonly MemoryLibraryNote[];
  readonly cursor: number;
  readonly showExpired: boolean;
  /** Crew-visible posture, read from the brain — fails closed to strict. */
  readonly autoConfirmAgentMemory: boolean;
  readonly busy: boolean;
  /**
   * ADR-0026 §9 — the PARTITION this page is for, or undefined when the desk
   * is outside the configured roots and is showing the unscoped view. A pane
   * that can render without stating its partition is a pane that will.
   */
  readonly workspace: string | undefined;
  /** Server-side total, so a truncated page can say it is truncated. */
  readonly total: number;
};

/** Rows the viewport can hold once the chrome has taken its share. */
export const MEMORY_VIEWPORT_ROWS = 12;

export class MemoryPane implements Component {
  private state: MemoryPaneState;

  constructor(state: MemoryPaneState) {
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const { notes, cursor, showExpired, autoConfirmAgentMemory } = this.state;
    const awaiting = notes.filter(
      (note) => memoryNoteMarkers(note, autoConfirmAgentMemory).needsReview
    ).length;

    const lines: string[] = [
      bold(" memory ") +
        dim(
          `${notes.length}${
            this.state.total > notes.length ? ` of ${this.state.total}` : ""
          } note${notes.length === 1 ? "" : "s"}${
            awaiting > 0 ? ` · ${awaiting} awaiting you` : ""
          }${showExpired ? " · including expired" : ""}`
        ),
      // ADR-0026 §9: state the partition, always. "Which repo is this?" must
      // never be a question a human has to infer from the note text.
      this.state.workspace
        ? dim(` workspace: ${terminalSafe(this.state.workspace)}`)
        : yellow(" unscoped view — these notes may span workspaces"),
      // THE AFFORDANCES COME BEFORE THE LIST. Composed after it, the shell's
      // row budget clipped them off the bottom, so `c` and `x` stayed armed
      // and live with nothing on screen saying so.
      ...this.affordanceLines(),
      "",
    ];

    if (notes.length === 0) {
      // Empty-state honesty: with expired notes hidden, "nothing matches" is
      // an incomplete answer — say which question was asked.
      lines.push(
        dim(
          showExpired
            ? " no notes match, including expired"
            : " no notes match — press e to include expired"
        )
      );
      return lines.map((line) => clip(line, width));
    }

    // A VIEWPORT, not the whole list: the cursor must be ON SCREEN, because
    // it is the binding target for `c` and `x`. Without this the cursor left
    // the frame while still selecting the note a governed write would hit.
    const first = Math.max(
      0,
      Math.min(cursor - Math.floor(MEMORY_VIEWPORT_ROWS / 2), notes.length - MEMORY_VIEWPORT_ROWS)
    );
    const visible = notes.slice(first, first + MEMORY_VIEWPORT_ROWS);
    if (first > 0) lines.push(dim(`   ↑ ${first} above`));
    visible.forEach((note, offset) => {
      const index = first + offset;
      const markers = memoryNoteMarkers(note, autoConfirmAgentMemory);
      const active = index === cursor;
      const marker = active ? cyan("›") : " ";
      const tag = memoryMarkerTag(note, autoConfirmAgentMemory);
      const text = terminalSafe(note.text).slice(0, 90);
      const flags =
        (markers.pinned ? green(" ⌾pinned") : "") +
        (markers.paused ? yellow(" ⏸paused") : "");
      lines.push(
        ` ${marker} ${dim(tag)}${flags} ${
          markers.expired ? yellow("EXPIRED ") : ""
        }${active ? bold(text) : text}`
      );
    });

    const below = notes.length - (first + visible.length);
    if (below > 0) lines.push(dim(`   ↓ ${below} below`));

    return lines.map((line) => clip(line, width));
  }

  /** The keybar and its caveats — rendered ABOVE the list, never below it. */
  private affordanceLines(): string[] {
    if (this.state.busy) return [dim(" working…")];
    const selected = this.state.notes[this.state.cursor];
    const markers = selected
      ? memoryNoteMarkers(selected, this.state.autoConfirmAgentMemory)
      : null;
    const lines = [
      // The keybar advertises against the SELECTED row, so it must say what
      // each key would actually do to THAT note.
      dim(" c confirm · x reject · ") +
        dim(markers?.paused ? "p resume · " : "p pause · ") +
        dim(markers?.pinned ? "P unpin · " : "P pin · ") +
        dim("e expired · esc back"),
    ];
    if (markers?.expired) {
      lines.push(
        dim(
          " an expired note is hidden from recall, never deleted — c confirms it and clears the expiry"
        )
      );
    }
    if (markers?.pinned) {
      lines.push(red(" a pinned note cannot be forgotten — unpin it first"));
    }
    return lines;
  }
}

function clip(line: string, width: number): string {
  return line.length > width * 4 ? line.slice(0, width * 4) : line;
}
