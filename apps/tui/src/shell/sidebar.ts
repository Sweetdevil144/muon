import { terminalSafe } from "@muon/client";
import type { Component } from "../vendor/pi-tui/src/tui.ts";
import { railOwnsCursor } from "../next/sections.js";
import { bold, cyan, dim, statusDot } from "./theme.js";

/**
 * The shell sidebar — spaces above, agents below, the desktop left-nav's
 * grouping rendered in cells (ADR-0046 D3: desktop visual == TUI visual).
 *
 * Governance rules carried over from the Ink desks, because they were paid
 * for there:
 *  - EVERY stored string is flattened at render (`terminalSafe`). A space
 *    name is a directory the user chose; an agent name is stored text; both
 *    ride the corpus-replay gate like every other component.
 *  - ONE cursor, ever. The sidebar only claims the highlight while it owns
 *    input (`railOwnsCursor` — the same predicate the Ink desk uses, so the
 *    two cannot disagree while both exist).
 */

export type SidebarSpace = {
  readonly key: string;
  readonly name: string;
  /** e.g. the git branch, rendered dim under the name like the desktop. */
  readonly detail?: string;
};

export type SidebarAgent = {
  readonly key: string;
  readonly name: string;
  readonly status: string;
  /** vendor id, rendered dim beside the status like the desktop. */
  readonly vendor: string;
};

export type SidebarState = {
  readonly spaces: readonly SidebarSpace[];
  readonly agents: readonly SidebarAgent[];
  /** Index into the agents list. The sidebar's one cursor. */
  readonly cursor: number;
  /** Modal-scope flags, fed to `railOwnsCursor`. */
  readonly scopes: Parameters<typeof railOwnsCursor>[0];
};

export const SIDEBAR_WIDTH = 24;

function fitCell(text: string, width: number): string {
  if (text.length <= width) return text.padEnd(width);
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

export class Sidebar implements Component {
  private state: SidebarState;

  constructor(state: SidebarState) {
    this.state = state;
  }

  update(state: SidebarState): void {
    this.state = state;
  }

  invalidate(): void {
    // Stateless render — nothing cached.
  }

  render(width: number): string[] {
    const w = Math.min(width, SIDEBAR_WIDTH);
    const inner = w - 2;
    const owns = railOwnsCursor(this.state.scopes);
    const lines: string[] = [];

    lines.push(dim(" spaces"));
    if (this.state.spaces.length === 0) {
      lines.push(dim(fitCell("  (none open)", w)));
    }
    for (const space of this.state.spaces) {
      lines.push(` ${fitCell(terminalSafe(space.name), inner)}`);
      if (space.detail) {
        lines.push(dim(`   ${fitCell(terminalSafe(space.detail), inner - 2)}`));
      }
    }

    lines.push("");
    lines.push(dim(" agents"));
    this.state.agents.forEach((agent, index) => {
      const active = owns && index === this.state.cursor;
      const name = fitCell(terminalSafe(agent.name), inner - 2);
      const row = ` ${statusDot(agent.status)} ${active ? bold(cyan(name)) : name}`;
      lines.push(row);
      lines.push(
        dim(`   ${fitCell(`${agent.status} · ${terminalSafe(agent.vendor)}`, inner - 2)}`)
      );
    });
    if (this.state.agents.length === 0) {
      lines.push(dim(fitCell("  no crew yet", w)));
    }

    return lines;
  }
}
