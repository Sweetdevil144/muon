import { terminalSafe } from "@muon/client";
import type { Component } from "../vendor/pi-tui/src/tui.ts";
import { bold, cyan, dim, green, yellow } from "./theme.js";

/**
 * The left rail — SPACES · SESSIONS · CHAT · INFO.
 *
 * Founder law 2 and 3: this is the DESKTOP's sidebar in a terminal, which
 * means spaces and sessions and what the active session IS — and explicitly
 * NOT a crew tree. Crew is a reveal (`ctrl+b c`) with its own drawer, because
 * a permanent lane list is the "wall of panels" the density doc exists to
 * prevent.
 *
 * It is HIDDEN by default and opens with `ctrl+b s`. Everything here answers
 * one question a human has while typing into a terminal: *what am I working
 * in, and what else is running?*
 */

export type SidebarSpace = {
  readonly name: string;
  readonly branch: string;
  readonly active: boolean;
  /** Short state word: clean, dirty, unreachable… */
  readonly note?: string;
};

export type SidebarSession = {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly active: boolean;
  readonly paneCount: number;
  readonly ungoverned: boolean;
};

export type DeskSidebarState = {
  readonly spaces: readonly SidebarSpace[];
  readonly sessions: readonly SidebarSession[];
  /** One line about what the active session is doing. */
  readonly chat: readonly string[];
  readonly info: readonly { label: string; value: string }[];
};

export const DESK_SIDEBAR_WIDTH = 26;

/** Fit `text` into `budget` columns, marking the cut rather than hiding it. */
function clampTo(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (text.length <= budget) return text;
  return budget === 1 ? "…" : `${text.slice(0, budget - 1)}…`;
}

/**
 * What a click on a sidebar row means. Most rows are headings or detail lines
 * and mean nothing — a rail where clicking a branch name does something
 * surprising is worse than one where it does nothing.
 */
export type SidebarTarget =
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "space"; readonly name: string }
  | { readonly kind: "new-session" }
  | { readonly kind: "none" };

export class DeskSidebar implements Component {
  private state: DeskSidebarState;

  constructor(state: DeskSidebarState) {
    this.state = state;
  }

  update(state: DeskSidebarState): void {
    this.state = state;
  }

  invalidate(): void {}

  /**
   * The row->target map, in the SAME order and by the same walk as `render`.
   * Both read `build()`, so a row cannot be drawn in one place and clicked in
   * another.
   */
  zones(): SidebarTarget[] {
    return this.build().map((row) => row.target);
  }

  render(width: number): string[] {
    return this.build().map((row) =>
      row.text.length > width * 4 ? row.text.slice(0, width * 4) : row.text
    );
  }

  private build(): { text: string; target: SidebarTarget }[] {
    const rows: { text: string; target: SidebarTarget }[] = [];
    const push = (text: string, target: SidebarTarget = { kind: "none" }) =>
      rows.push({ text, target });
    const lines = {
      push: (...texts: string[]) => {
        for (const text of texts) push(text);
      },
    };

    lines.push(bold(" SPACES"));
    for (const space of this.state.spaces) {
      const glyph = space.active ? green("●") : dim("○");
      const name = terminalSafe(space.name);
      push(` ${glyph} ${space.active ? bold(name) : name}`, {
        kind: "space",
        name: space.name,
      });
      lines.push(
        dim(
          `   ${terminalSafe(space.branch)}${
            space.note ? ` · ${terminalSafe(space.note)}` : ""
          }`
        )
      );
    }

    // H8 (TUI half) — sessions read as belonging to a SPACE, not as a second
    // flat list beside one. The heading names which space these sessions are
    // in and how many there are, and the rows hang one column further in, so
    // the rail answers "project → session" the same way the desktop rail does.
    // Deliberately NOT a per-session space label: one extra word on every row
    // in a 26-column rail buys nothing the heading has not already said.
    const homeSpace =
      this.state.spaces.find((space) => space.active) ?? this.state.spaces[0];
    // The COUNT must survive a long project name, so the name is what gives
    // way: the rail is 26 columns and the shell clips, it does not wrap.
    const countSuffix = ` (${this.state.sessions.length})`;
    const spaceName = homeSpace
      ? clampTo(
          terminalSafe(homeSpace.name),
          DESK_SIDEBAR_WIDTH - " SESSIONS · ".length - countSuffix.length
        )
      : "";
    lines.push(
      "",
      `${bold(" SESSIONS")}${spaceName ? dim(` · ${spaceName}`) : ""}${dim(
        countSuffix
      )}`
    );
    if (this.state.sessions.length === 0) {
      push(dim("   none — ctrl+b t"), { kind: "new-session" });
    }
    for (const session of this.state.sessions) {
      const label = terminalSafe(session.label);
      push(
        session.active
          ? `  ${cyan("›")} ${bold(label)}`
          : `  ${dim("○")} ${label}`,
        { kind: "session", id: session.id }
      );
      const detail =
        session.paneCount > 1
          ? `${session.paneCount} panes · split`
          : terminalSafe(session.kind);
      lines.push(dim(`    ${detail}`));
    }

    if (this.state.chat.length > 0) {
      lines.push("", bold(" CHAT"));
      for (const line of this.state.chat) {
        lines.push(dim(`   ${terminalSafe(line)}`));
      }
    }

    lines.push("", bold(" INFO"));
    for (const row of this.state.info) {
      const value = terminalSafe(row.value);
      lines.push(
        `   ${dim(row.label.padEnd(7))}${
          // D5 is chrome, not decoration: an ungoverned session says so here
          // as well as in its pane, because this rail is where a human looks
          // to answer "what am I actually in".
          value === "UNGOVERNED" ? yellow(value) : value
        }`
      );
    }

    return rows;
  }
}
