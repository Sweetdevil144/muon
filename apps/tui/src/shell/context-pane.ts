import { terminalSafe } from "@muon/client";
import type { PreEditView } from "@muon/client";
import type { Component } from "../vendor/pi-tui/src/tui.ts";
import { bold, cyan, dim, green, red, yellow } from "./theme.js";

/**
 * ADR-0087 M6 — the pre-edit context: blast radius + governed memory, the
 * LAST pane row. Renders the SHARED `buildPreEditView` output verbatim —
 * the same builder the desktop Brain panel consumes, pre-labeled and
 * pre-ordered (on-target memories first, KG-4's within-tier order
 * preserved), so the surfaces cannot disagree about a gate.
 *
 * The honesty bars carried through:
 *  - the radius SOURCE is labeled, and a target-only radius says degraded;
 *  - warnings and pending proposals are coordinates-only by TYPE
 *    (`hasText: false` structurally) — nothing untrusted renders here;
 *  - the view's own `notices` render as-is (the builder's honest empty
 *    and degraded sentences).
 */

export type ContextPaneState =
  | { readonly phase: "loading"; readonly targetLabel: string }
  | { readonly phase: "error"; readonly targetLabel: string; readonly reason: string }
  | { readonly phase: "ready"; readonly view: PreEditView };

const SECTION_CAP = 12;

export class ContextPane implements Component {
  constructor(private readonly state: ContextPaneState) {}

  invalidate(): void {}

  render(width: number): string[] {
    const clip = (all: string[]) =>
      all.map((line) => (line.length > width * 4 ? line.slice(0, width * 4) : line));
    const lines: string[] = [
      bold(" pre-edit context ") + dim("blast radius + governed memory · esc close"),
      "",
    ];
    if (this.state.phase === "loading") {
      lines.push(dim(` reading the gate for ${terminalSafe(this.state.targetLabel)}…`));
      return clip(lines);
    }
    if (this.state.phase === "error") {
      lines.push(red(` ✗ ${terminalSafe(this.state.reason)}`));
      return clip(lines);
    }
    const view = this.state.view;
    lines.push(cyan(" target ") + terminalSafe(view.targetLabel));

    // The RADIUS, its source LABELED — a target-only radius is an honest
    // degraded state, never presented as a measured blast radius.
    const radius = view.blastRadius;
    lines.push(
      (radius.degraded ? yellow(" radius ") : cyan(" radius ")) +
        dim(`${radius.sourceLabel}${radius.depth !== undefined ? ` · depth ${radius.depth}` : ""}`)
    );
    for (const module of radius.modules.slice(0, SECTION_CAP)) {
      lines.push(dim(`   ${terminalSafe(module)}`));
    }
    if (radius.modules.length > SECTION_CAP) {
      lines.push(dim(`   … and ${radius.modules.length - SECTION_CAP} more module(s)`));
    }
    if (radius.symbols.length > 0) {
      lines.push(
        dim(
          `   symbols: ${radius.symbols
            .slice(0, 6)
            .map((symbol) => terminalSafe(symbol))
            .join(", ")}${radius.symbols.length > 6 ? ` +${radius.symbols.length - 6}` : ""}`
        )
      );
    }
    lines.push("");

    // GOVERNED MEMORY — on-target first (the hero tier), the builder's
    // order preserved; this pane never re-ranks.
    if (view.hasGovernedMemory) {
      lines.push(cyan(" governed memory"));
      for (const memory of view.memories.slice(0, SECTION_CAP)) {
        const marker = memory.onTarget ? green("● ") : dim("○ ");
        lines.push(
          `  ${marker}${dim(`[${memory.kindLabel}]`)} ${terminalSafe(memory.note.text).slice(0, 70)}`
        );
      }
      if (view.memories.length > SECTION_CAP) {
        lines.push(
          dim(`   … and ${view.memories.length - SECTION_CAP} more note(s)`)
        );
      }
    }

    // Coordination signals — coordinates only, counts honest.
    if (view.hasOnTargetActivity || view.hasLiveActivity || view.hasDuplicateWork) {
      lines.push("");
      if (view.hasOnTargetActivity) {
        lines.push(
          red(` ⚠ ${view.onTargetLaneCount} other lane(s) on this exact target`)
        );
      } else if (view.hasLiveActivity) {
        lines.push(
          yellow(` ${view.activeLaneCount} other lane(s) live in the radius`)
        );
      }
      if (view.hasDuplicateWork) {
        lines.push(
          yellow(` ${view.duplicateWorkCount} lane(s) doing semantically similar work`)
        );
      }
    }

    if (view.hasWarnings) {
      lines.push("");
      lines.push(red(" warnings"));
      for (const warning of view.warnings.slice(0, 6)) {
        lines.push(red(`   ${terminalSafe(warning.label)}`));
      }
    }
    if (view.pendingCount > 0) {
      lines.push(
        yellow(
          ` ${view.pendingCount} pending proposal(s) await adjudication — the memory pane decides them`
        )
      );
    }

    // The builder's own honest sentences, verbatim.
    for (const notice of view.notices) {
      lines.push(dim(` ${terminalSafe(notice)}`));
    }
    return clip(lines);
  }
}
