import { terminalSafe } from "@muon/client";
import type { Component } from "../vendor/pi-tui/src/tui.ts";
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

/**
 * ONLY ONE CURSOR IS EVER LIVE (founder-reported: two highlights at once
 * left it ambiguous what Enter would act on). A pure predicate on purpose:
 * a colour-only highlight is invisible to a rendered-frame assertion, so
 * the rule has to be testable here. The scope set is the same one the key
 * dispatcher uses, so the highlight and the handler cannot disagree about
 * who is in charge. (Rescued from the retired Ink desk's sections module
 * in ADR-0087 D4 — this rail is its one surviving consumer.)
 */
export function railOwnsCursor(input: {
  readonly paletteOpen: boolean;
  readonly formOpen: boolean;
  readonly reviewOpen: boolean;
  readonly memoryOpen: boolean;
}): boolean {
  return (
    !input.paletteOpen &&
    !input.formOpen &&
    !input.reviewOpen &&
    !input.memoryOpen
  );
}
