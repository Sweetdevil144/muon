import { NAV_DESTINATIONS, terminalSafe } from "@muon/client";
import type { NavDestination } from "@muon/client";
import type { Component } from "../vendor/pi-tui/src/tui.ts";
import { bold, cyan, dim, yellow } from "./theme.js";

/**
 * The destination list (matrix row A1) — the shell desk's answer to "where
 * can I go", from the SAME list the desktop's left nav renders.
 *
 * WHAT IT REFUSES TO DO IS THE POINT. Most destinations are not built on this
 * desk yet, and a nav that silently omitted them would misrepresent the
 * product: a human would conclude MUON has three places rather than nine.
 * Every destination is listed; the ones that are not here yet say so and say
 * where they ARE, which is the same refusal-with-a-reason rule the spawn menu
 * and the classic desk's sixteen commands use.
 *
 * That also makes this list a live burn-down ledger: `implemented` is one
 * edit away from telling the truth about a row, and the parity matrix and
 * this nav cannot drift apart without a test failing.
 */

/** Destinations the SHELL desk can actually open today. */
export const IMPLEMENTED_DESTINATIONS: ReadonlySet<NavDestination> = new Set<NavDestination>([
  "mission",
  "memory",
  "control",
  // Fully built as a drawer since the crew wave, and reachable by `ctrl+b c`
  // the whole time — but absent from this set, so the destination list said
  // "not on this desk yet" about a pane the desk already had. Founder law 6
  // in its other direction: a surface that exists must not be advertised as
  // missing.
  "crew",
  // The ledger, in order. The one destination whose data the desk was already
  // polling (`BrainSnapshot.events`) and simply had nowhere to put.
  "timeline",
  // Vendors, workspace and posture — every field of it already polled, and
  // read-only by design: the two things a human might want to edit here
  // (signing a vendor in, changing posture) belong to the vendor's own login
  // flow and to an operator surface respectively.
  "settings",
]);

/** Where a not-yet-ported destination CAN be reached. */
const ELSEWHERE = "desktop app, or `npm run tui:ink`";

export type NavState = {
  readonly active: NavDestination;
  readonly cursor: number;
  readonly focused: boolean;
  /** Pending decisions, badged on Control (A2). 0 hides it. */
  readonly pendingDecisions: number;
  /** A quiet dot on Crew when any agent is working (A2's sibling). */
  readonly crewActive: boolean;
  /**
   * Body rows available to this pane. The viewport is derived from it rather
   * than fixed: a CONSTANT window would hide destinations on a tall terminal
   * for no reason, and "the nav lists the whole product" is the rule this
   * component exists to keep. It windows only when it genuinely cannot fit.
   */
  readonly rows: number;
};

export function navDestinationAt(index: number): NavDestination {
  const entry = NAV_DESTINATIONS[Math.max(0, Math.min(index, NAV_DESTINATIONS.length - 1))];
  return entry!.target;
}

export class Nav implements Component {
  private state: NavState;

  constructor(state: NavState) {
    this.state = state;
  }

  update(state: NavState): void {
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [dim(" go to")];
    // A VIEWPORT, like the inbox and memory panes have. Without it a short
    // terminal scrolled the cursor off screen while Enter still selected the
    // invisible row — and this list is designed to GROW, so it gets worse by
    // construction with every destination added.
    // Header + hint + (the focused row's own hint line) take three.
    const window = Math.max(3, this.state.rows - 3);
    const first =
      NAV_DESTINATIONS.length <= window
        ? 0
        : Math.max(
            0,
            Math.min(
              this.state.cursor - Math.floor(window / 2),
              NAV_DESTINATIONS.length - window
            )
          );
    const visible = NAV_DESTINATIONS.slice(first, first + window);
    if (first > 0) lines.push(dim(`   ↑ ${first} above`));
    visible.forEach((entry, offset) => {
      const index = first + offset;
      const active = entry.target === this.state.active;
      const onCursor = this.state.focused && index === this.state.cursor;
      const built = IMPLEMENTED_DESTINATIONS.has(entry.target);
      const marker = onCursor ? cyan("›") : active ? "•" : " ";
      const label = terminalSafe(entry.label);
      // A2 — the badge rides the row it belongs to, not a global header.
      const badge =
        entry.target === "control" && this.state.pendingDecisions > 0
          ? yellow(` ${this.state.pendingDecisions}`)
          : entry.target === "crew" && this.state.crewActive
            ? dim(" ·")
            : "";
      // THE BADGE RIDES EVERY ROW, built or not. It reports what the PRODUCT
      // is doing (3 decisions waiting, crew working), not what this desk can
      // open — hiding it on an unported row would under-report the state of
      // the system for a reason that has nothing to do with the state of the
      // system. Found by a test written for the badge, not the refusal.
      const body =
        (built
          ? onCursor || active
            ? bold(label)
            : label
          : dim(`${label} — not on this desk yet`)) + badge;
      lines.push(` ${marker} ${body}`);
      if (onCursor) {
        lines.push(
          dim(`     ${terminalSafe(built ? entry.hint : `${entry.hint} · ${ELSEWHERE}`)}`)
        );
      }
    });
    const below = NAV_DESTINATIONS.length - (first + visible.length);
    if (below > 0) lines.push(dim(`   ↓ ${below} below`));
    return lines.map((line) =>
      line.length > width * 4 ? line.slice(0, width * 4) : line
    );
  }
}
