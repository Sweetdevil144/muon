import { terminalSafe } from "@muon/client";
import {
  buildTerminalVendorMenu,
  SHELL_TERMINAL_KIND,
  type TerminalVendorMenuEntry,
} from "@muon/client/terminal-vendor-tabs";
import type { VendorReadiness } from "@muon/client";
import type { Component } from "../vendor/pi-tui/src/tui.ts";
import { bold, cyan, dim, yellow } from "./theme.js";

/**
 * F3 — the spawn menu: shell + every vendor CLI, keyboard-driven.
 *
 * Built from the SAME `buildTerminalVendorMenu` the desktop's picker uses,
 * against the same readiness report, so a vendor disabled on one surface is
 * disabled on both with the same reason.
 *
 * Disabled-never-hidden, the desktop's rule kept verbatim: a vendor whose CLI
 * is missing stays a FOCUSABLE row with its reason inline — "codex isn't
 * installed" is an answer, not an absence. Enter on a disabled row does
 * nothing except keep the reason on screen.
 */

export type SpawnMenuState = {
  readonly entries: readonly TerminalVendorMenuEntry[];
  readonly cursor: number;
  /** True when the readiness probe has not answered yet — the shared builder
   *  then shows every vendor ENABLED (the desktop's semantics, unchanged),
   *  and this surface says so instead of implying a guarantee. */
  readonly readinessPending: boolean;
  /**
   * When set, the chosen kind opens as the RIGHT PANE of that tab rather than
   * as a new tab. The picker is the same either way — a split is a session
   * like any other, subject to the same allowlist and the same D5 labelling.
   */
  readonly intoSplitOf?: string;
};

export function buildSpawnMenuState(
  readiness: readonly VendorReadiness[] | null,
  cursor = 0
): SpawnMenuState {
  const entries = buildTerminalVendorMenu(readiness);
  return {
    entries,
    cursor: Math.min(Math.max(0, cursor), Math.max(0, entries.length - 1)),
    readinessPending: readiness === null,
  };
}

/** The selection a keypress resolves to — or a refusal that stays visible. */
export function resolveSpawnSelection(
  state: SpawnMenuState
): { kind: string } | { refused: string } {
  const entry = state.entries[state.cursor];
  if (!entry) return { refused: "nothing to spawn" };
  if (!entry.enabled) {
    return {
      refused: entry.detail ?? `${entry.label} is not available here`,
    };
  }
  return { kind: entry.kind };
}

export class SpawnMenu implements Component {
  private state: SpawnMenuState;

  constructor(state: SpawnMenuState) {
    this.state = state;
  }

  update(state: SpawnMenuState): void {
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [bold(" open a terminal")];
    this.state.entries.forEach((entry, index) => {
      const active = index === this.state.cursor;
      const marker = active ? cyan("›") : " ";
      const label = terminalSafe(entry.label);
      // EVERY pane this menu spawns is human-opened and therefore ungoverned
      // (D5) — the shared entry type carries no flag because on this path it
      // is invariant, not variable.
      const tag =
        entry.kind === SHELL_TERMINAL_KIND
          ? dim(" · your shell")
          : yellow(" · ungoverned");
      // The tag rides EVERY row, disabled included: a vendor the human is
      // about to go install and come back to is exactly where the governance
      // label matters most (review finding — the first version dropped it on
      // the disabled branch).
      const body = entry.enabled
        ? `${active ? bold(label) : label}${tag}`
        : `${dim(`${label} — ${terminalSafe(entry.detail ?? "unavailable")}`)}${tag}`;
      const line = ` ${marker} ${body}`;
      lines.push(line.length > width * 4 ? line.slice(0, width * 4) : line);
    });
    if (this.state.readinessPending) {
      // Review finding: before the first readiness poll (or when the probe
      // fails) every vendor row shows ENABLED, and picking one on a machine
      // without the CLI dies as a bare "exited: code 1". Until readiness
      // answers, say the guarantee is absent rather than implying it.
      lines.push(
        yellow(" vendor readiness still loading — a vendor may fail to start")
      );
    }
    lines.push(dim(" ↑/↓ move · ⏎ open · esc close"));
    return lines;
  }
}
