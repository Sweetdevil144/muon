import { terminalSafe } from "@muon/client";
import type { Component } from "../vendor/pi-tui/src/tui.ts";
import { dim, inverse } from "./theme.js";
import { visibleWidth } from "../vendor/pi-tui/src/utils.ts";

/**
 * The shell tab strip — per-space tabs plus the `+` new-tab affordance,
 * matching the desktop's workspace-tabs row (ADR-0046 D3).
 *
 * Titles are STORED text (an agent name, a directory) and are flattened at
 * render; the strip rides the corpus-replay gate.
 */

export type ShellTab = {
  readonly id: string;
  readonly title: string;
};

export type TabStripState = {
  readonly tabs: readonly ShellTab[];
  readonly activeId: string;
};

/** A clickable span of the strip, in visible columns from the strip's left. */
export type TabZone = {
  readonly target: { kind: "tab"; id: string } | { kind: "new-tab" };
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
};

const NEW_TAB = " + ";

export class TabStrip implements Component {
  private state: TabStripState;

  constructor(state: TabStripState) {
    this.state = state;
  }

  update(state: TabStripState): void {
    this.state = state;
  }

  invalidate(): void {}

  /**
   * WHERE EACH TAB SITS, in visible columns.
   *
   * `render` builds its line from exactly this list, so a click can never land
   * on a tab other than the one drawn there. Deriving the two separately would
   * work until the first title with a wide character in it.
   */
  zones(width: number): TabZone[] {
    const zones: TabZone[] = [];
    let column = 0;
    for (const tab of this.state.tabs) {
      // CELLS, not UTF-16 units. The shell clips and lays out in terminal
      // columns, so a title with a wide character (CJK, an emoji) made every
      // zone after it drift and clicks land on the neighbouring tab.
      const span = visibleWidth(this.label(tab));
      // A tab clipped off the right edge is not clickable, because it is not
      // visible. Half a tab is not a target.
      if (column + span > width) return zones;
      zones.push({ target: { kind: "tab", id: tab.id }, start: column, end: column + span });
      column += span;
    }
    const newTabSpan = visibleWidth(NEW_TAB);
    if (column + newTabSpan <= width) {
      zones.push({
        target: { kind: "new-tab" },
        start: column,
        end: column + newTabSpan,
      });
    }
    return zones;
  }

  private label(tab: ShellTab): string {
    return ` ${terminalSafe(tab.title).slice(0, 20)} `;
  }

  render(width: number): string[] {
    let line = "";
    for (const zone of this.zones(width)) {
      if (zone.target.kind === "new-tab") {
        line += dim(NEW_TAB);
        continue;
      }
      const id = zone.target.id;
      const tab = this.state.tabs.find((candidate) => candidate.id === id)!;
      const title = this.label(tab);
      line += tab.id === this.state.activeId ? inverse(title) : dim(title);
    }
    // One line, hard-clipped to the viewport — a strip that wraps becomes two
    // rows of ambiguous targets.
    return [line];
  }
}
