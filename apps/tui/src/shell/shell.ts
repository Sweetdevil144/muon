import type { Component } from "../vendor/pi-tui/src/tui.ts";
import type { BrainSnapshot } from "../lib/brain-store.js";
import { Footer, footerHints } from "./footer.js";
import { Inbox, INBOX_WIDTH, type InboxState } from "./inbox.js";
import { Sidebar, SIDEBAR_WIDTH, type SidebarState } from "./sidebar.js";
import {
  DESK_SIDEBAR_WIDTH,
  type DeskSidebar,
  type SidebarTarget,
} from "./desk-sidebar.js";
import { TabStrip, type TabStripState, type TabZone } from "./tab-strip.js";
import { dim } from "./theme.js";

/** The centre never shrinks below this; chrome yields to it, never the reverse. */
const MIN_CENTRE_WIDTH = 20;

/**
 * Rows the PANE itself draws inside the centre, before the child's screen: the
 * D5 ungoverned banner. Counted here so the child's row budget is what it
 * actually gets rather than one more than that.
 */
const PANE_CHROME_ROWS = 1;

/**
 * The narrowest terminal that can hold the sidebar AND a usable centre.
 * Exported so the desk REFUSES with this number rather than flipping a flag
 * that draws nothing — one threshold, two readers.
 */
export const MIN_SIDEBAR_TOTAL = DESK_SIDEBAR_WIDTH + 1 + MIN_CENTRE_WIDTH;
import { sliceByColumn, visibleWidth } from "../vendor/pi-tui/src/utils.ts";

/**
 * The ADR-0046 shell — the desktop's frame, in the terminal.
 *
 * Composition (D3, desktop visual == TUI visual):
 *
 *   ┌ sidebar ┬ tab strip ──────────────┐
 *   │ spaces  │ centre pane             │
 *   │ agents  │ (phase 2: the real pty) │
 *   ├─────────┴─────────────────────────┤
 *   │ footer — one sanitized status line│
 *   └───────────────────────────────────┘
 *
 * This class is a plain Component (`render(width) → string[]`), which is what
 * makes the whole shell testable without a terminal: tests call render and
 * assert on lines — including the corpus replay, which found real leaks on
 * the Ink desks and gates every component here from day one.
 *
 * Phase 1 scope ONLY: the frame. The centre is a placeholder until Phase 2
 * puts a real pty pane in it; no feature from the parity matrix lands in this
 * file — features are panes, the shell is chrome.
 */

export type ShellState = {
  readonly sidebar: SidebarState;
  readonly tabs: TabStripState;
  /** Rows available to the whole shell (viewport height). */
  readonly rows: number;
};

/** What sits under a given cell of the frame. */
export type ShellHit =
  | { readonly zone: "tab"; readonly target: TabZone["target"] }
  | { readonly zone: "sidebar"; readonly target: SidebarTarget }
  | {
      readonly zone: "pane";
      /** 0 is the only pane, or the left half of a split; 1 is the right. */
      readonly pane: number;
      readonly col: number;
      readonly row: number;
    }
  | { readonly zone: "hint"; readonly action: string }
  | { readonly zone: "inbox" }
  | { readonly zone: "none" };

/**
 * Where the divider sits in a split. Shared by the renderer and the hit-test
 * for the usual reason: two copies of this agree until one of them changes.
 */
function splitLeftWidth(centreWidth: number): number {
  return Math.max(10, Math.floor((centreWidth - 1) / 2));
}

export class Shell implements Component {
  private readonly sidebar: Sidebar;
  private readonly tabStrip: TabStrip;
  readonly footer: Footer;
  private rows: number;
  /**
   * The centre is a PANE GRID, not one component: a tab may be split into a
   * main pane and a right pane. One entry is the ordinary case; two is a
   * split. There is no placeholder entry — a desk with nothing to show opens
   * the spawn picker instead of printing an apology.
   */
  private panes: Component[] = [];
  private focusedPane = 0;
  private inbox: Inbox | null = null;
  /**
   * HIDDEN BY DEFAULT. The desktop's sidebar collapses; the terminal is the
   * product. A permanently mounted rail steals width from the one region a
   * human actually works in.
   */
  private sidebarVisible = false;
  /** SPACES/SESSIONS/CHAT/INFO — replaces the crew rail when present. */
  private deskSidebar: DeskSidebar | null = null;
  /** The arriving gate, when one is waiting. One line, above the footer. */
  private gateBand: string | null = null;

  constructor(state: ShellState) {
    this.sidebar = new Sidebar(state.sidebar);
    this.tabStrip = new TabStrip(state.tabs);
    this.footer = new Footer();
    this.rows = state.rows;
  }

  update(state: ShellState): void {
    this.sidebar.update(state.sidebar);
    this.tabStrip.update(state.tabs);
    this.rows = state.rows;
  }

  /** Phase 2 seam: the centre pane is pluggable, the chrome is not. */
  setSidebarVisible(visible: boolean): void {
    this.sidebarVisible = visible;
  }

  setGateBand(line: string | null): void {
    this.gateBand = line;
  }

  setDeskSidebar(sidebar: DeskSidebar | null): void {
    this.deskSidebar = sidebar;
  }

  setInbox(state: InboxState | null): void {
    this.inbox = state ? new Inbox(state) : null;
  }

  setCentre(component: Component | null): void {
    this.panes = component ? [component] : [];
    this.focusedPane = 0;
  }

  /** Main pane plus an optional right split, and which one has focus. */
  setPanes(panes: Component[], focused = 0): void {
    this.panes = panes;
    this.focusedPane = Math.max(0, Math.min(focused, panes.length - 1));
  }

  invalidate(): void {
    this.sidebar.invalidate();
    this.tabStrip.invalidate();
    this.footer.invalidate();
    for (const pane of this.panes) pane.invalidate();
  }

  /** How many panes are on screen — test seam and split-state read. */
  paneCount(): number {
    return this.panes.length;
  }

  /** Which half of a split has focus. */
  focusedPaneIndex(): number {
    return this.focusedPane;
  }

  private renderPanes(width: number, rows: number): string[] {
    if (this.panes.length === 0) return [];
    if (this.panes.length === 1) return this.panes[0]!.render(width);

    // Two panes: split the width, minus one column for the divider.
    const leftWidth = splitLeftWidth(width);
    const rightWidth = Math.max(10, width - leftWidth - 1);
    const left = this.panes[0]!.render(leftWidth);
    const rightPane = this.panes[1]!.render(rightWidth);
    const lines: string[] = [];
    for (let row = 0; row < Math.max(rows, 1); row += 1) {
      lines.push(
        `${fitVisible(left[row] ?? "", leftWidth)}│${fitVisible(
          rightPane[row] ?? "",
          rightWidth
        )}`
      );
    }
    return lines;
  }

  /**
   * THE PANE'S REAL VIEWPORT — what the child is told it has.
   *
   * This exists because the child was being told something else. The entry
   * computed its geometry as `terminal - 26 columns` on the theory that the
   * sidebar takes 26 — but the sidebar is HIDDEN by default (founder law: the
   * terminal is the hero), so a vendor CLI was handed 26 fewer columns than it
   * actually had and drew itself into a box with dead space to its right. The
   * founder's screenshot of Claude Code is exactly that.
   *
   * A guess about the layout cannot be right for long. This returns the SAME
   * numbers `render` lays out with, from the same state, so "what is drawn"
   * and "what the child believes" cannot drift again.
   */
  /**
   * The viewport of ONE pane. `paneViewport` answers for the focused half;
   * this answers for either, because the two halves of an odd centre are not
   * the same width and resizing both to the left one leaves the right child a
   * dead or wrapped edge column.
   */
  paneViewportAt(
    width: number,
    pane: number,
    /**
     * How many panes the TAB being measured has — not how many are on screen.
     *
     * `this.panes` only ever holds the ACTIVE tab, so defaulting to it sized
     * every BACKGROUND split tab to the whole centre: `resize()` told both its
     * halves they owned the full width, and ADR-0047 captured them at that
     * width, which is the re-wrapped-restore defect this was meant to fix —
     * still present for any split tab that was not in front.
     */
    paneCount: number = this.panes.length
  ): { cols: number; rows: number } {
    const layout = this.layout(width);
    const centreWidth = layout.centreWidth;
    const leftWidth = splitLeftWidth(centreWidth);
    return {
      cols: Math.max(
        20,
        paneCount < 2
          ? centreWidth
          : pane === 0
            ? leftWidth
            : Math.max(10, centreWidth - leftWidth - 1)
      ),
      // The pane draws its own chrome INSIDE the centre — one line for the
      // ungoverned banner — so the child gets what is left after it.
      rows: Math.max(5, layout.bodyRows - layout.stripRows - PANE_CHROME_ROWS),
    };
  }

  paneViewport(width: number): { cols: number; rows: number } {
    // THE FOCUSED half, which is what this claims to answer. It returned the
    // LEFT width unconditionally, so a newly opened right-hand pty started at
    // the wrong width — and ADR-0047 captured its screen at that width too —
    // until the next terminal resize happened to correct it.
    return this.paneViewportAt(width, this.focusedPane);
  }

  /**
   * WHAT IS UNDER THE POINTER.
   *
   * Reads the same `layout()` the frame is drawn from, so a target is where it
   * looks. Returns `pane` for anything inside the centre body — that region
   * belongs to whatever is running there, and MUON does not take clicks from
   * a child that may be listening for them.
   */
  hitTest(width: number, col: number, row: number): ShellHit {
    const { showSidebar, showInbox, railWidth, centreWidth, bodyRows } =
      this.layout(width);
    if (row < 0 || col < 0) return { zone: "none" };
    if (row >= bodyRows) {
      // THE FOOTER IS CLICKABLE. It is the only chord list always on screen,
      // which makes it the one surface a human can drive with no keyboard
      // knowledge at all. The gate band, when present, sits between the body
      // and the footer and is not a target.
      const footerRow = bodyRows + (this.gateBand ? 1 : 0);
      if (row !== footerRow) return { zone: "none" };
      // Only while the hints are actually drawn. A transient status replaces
      // that line, and clicking an invisible control is worse than clicking
      // nothing.
      if (!this.footer.hintsVisible()) return { zone: "none" };
      const hint = footerHints().find(
        (candidate) => col >= candidate.start && col < candidate.end
      );
      return hint ? { zone: "hint", action: hint.action } : { zone: "none" };
    }

    if (showSidebar) {
      if (col < railWidth) {
        // Only the desk rail carries targets. The legacy crew rail is drawn
        // but not clickable, and saying so is better than inventing a mapping
        // for rows it never published.
        const targets = this.deskSidebar?.zones() ?? [];
        return { zone: "sidebar", target: targets[row] ?? { kind: "none" } };
      }
      if (col === railWidth) return { zone: "none" }; // the divider
    }

    const centreLeft = showSidebar ? railWidth + 1 : 0;
    const centreCol = col - centreLeft;
    if (centreCol < 0) return { zone: "none" };
    if (centreCol >= centreWidth) {
      return showInbox ? { zone: "inbox" } : { zone: "none" };
    }

    const stripRows = this.tabStrip.render(centreWidth).length;
    if (row < stripRows) {
      const zone = this.tabStrip
        .zones(centreWidth)
        .find((candidate) => centreCol >= candidate.start && centreCol < candidate.end);
      return zone ? { zone: "tab", target: zone.target } : { zone: "none" };
    }
    // WHICH PANE, and where inside IT. A split divides the centre, so a
    // centre-relative column is not a pane-relative one — a click in the right
    // half arrived at the left child, at a column far past its edge.
    const paneRow = row - stripRows;
    if (this.panes.length < 2) {
      return { zone: "pane", pane: 0, col: centreCol, row: paneRow };
    }
    const leftWidth = splitLeftWidth(centreWidth);
    if (centreCol < leftWidth) {
      return { zone: "pane", pane: 0, col: centreCol, row: paneRow };
    }
    // The divider column belongs to neither child.
    if (centreCol === leftWidth) return { zone: "none" };
    return { zone: "pane", pane: 1, col: centreCol - leftWidth - 1, row: paneRow };
  }

  /** The one arithmetic `render` and `paneViewport` both read. */
  private layout(width: number): {
    railWidth: number;
    showSidebar: boolean;
    showInbox: boolean;
    centreWidth: number;
    bodyRows: number;
    stripRows: number;
    inboxRows: string[];
    side: string[];
  } {
    const bandRows = this.gateBand ? 1 : 0;
    const bodyRows = Math.max(3, this.rows - 1 - bandRows);
    const railWidth = this.deskSidebar ? DESK_SIDEBAR_WIDTH : SIDEBAR_WIDTH;
    const showSidebar =
      this.sidebarVisible && width >= railWidth + 1 + MIN_CENTRE_WIDTH;
    const inboxRows = this.inbox?.render(INBOX_WIDTH) ?? [];
    const showInbox =
      inboxRows.length > 0 && width >= SIDEBAR_WIDTH + INBOX_WIDTH + 40;
    const centreWidth = Math.max(
      20,
      width -
        (showSidebar ? railWidth + 1 : 0) -
        (showInbox ? INBOX_WIDTH + 1 : 0)
    );
    const side = showSidebar
      ? (this.deskSidebar ?? this.sidebar).render(railWidth)
      : [];
    return {
      railWidth,
      showSidebar,
      showInbox,
      centreWidth,
      bodyRows,
      stripRows: this.tabStrip.render(centreWidth).length,
      inboxRows,
      side,
    };
  }

  render(width: number): string[] {
    // ONE DERIVATION. This used to recompute the rail width, the two
    // visibility guards and the centre width itself — a copy of `layout()`
    // that happened to agree. Mouse hit-testing reads `layout()`, so a copy
    // that drifted at any width would put clicks on the wrong thing.
    const { showSidebar, showInbox, railWidth, centreWidth, bodyRows, inboxRows, side } =
      this.layout(width);
    const strip = this.tabStrip.render(centreWidth);
    // THE PANE GRID. Two panes split the centre width with a divider; the
    // focused one is marked, because a split where you cannot tell which pane
    // takes your keystrokes is worse than no split.
    const centre = this.renderPanes(centreWidth, bodyRows - strip.length);

    const right: string[] = [...strip, ...centre];

    const lines: string[] = [];
    for (let row = 0; row < bodyRows; row += 1) {
      const left = showSidebar
        ? `${fitVisible(side[row] ?? "", railWidth)}│`
        : "";
      const rightLine = right[row] ?? "";
      if (!showInbox) {
        // Clip even without a rail: an overlong line wraps in the HOST
        // terminal, which shifts every row below it and cascades the frame.
        lines.push(`${left}${fitVisible(rightLine, centreWidth)}`);
        continue;
      }
      lines.push(
        `${left}${fitVisible(rightLine, centreWidth)}│${fitVisible(
          inboxRows[row] ?? "",
          INBOX_WIDTH
        )}`
      );
    }
    if (this.gateBand) lines.push(fitVisible(this.gateBand, width));
    lines.push(...this.footer.render(width));
    return lines;
  }
}

/**
 * Pad by VISIBLE length, not string length — the sidebar's lines carry ANSI
 * styling, and `padEnd` over a styled string under-pads by the escape bytes,
 * which staircases the column divider.
 */
/**
 * Fit a line to EXACTLY `width` visible cells: clip what overflows, pad what
 * falls short. Padding alone was not enough — nothing truncated the centre,
 * so a long note or keybar pushed the right divider into three different
 * columns on three consecutive rows and severed the inbox mid-glyph.
 */
function fitVisible(line: string, width: number): string {
  return visibleWidth(line) > width
    ? sliceByColumn(line, 0, width)
    : padVisible(line, width);
}

function padVisible(line: string, width: number): string {
  // The vendored, east-asian-aware measurer — NOT a local regex over a raw
  // escape byte counting UTF-16 units. That older body was the staircase bug
  // this file fixed everywhere else, and it left the repo's one remaining raw
  // control byte in source, which the evasion-corpus rule forbids precisely
  // because an invisible byte cannot be reviewed.
  const visible = visibleWidth(line);
  return visible >= width ? line : line + " ".repeat(width - visible);
}
