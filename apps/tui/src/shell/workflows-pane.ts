import { terminalSafe } from "@muon/client";
import type { WorkflowRunRecord } from "@muon/client";
import type { Component } from "../vendor/pi-tui/src/tui.ts";
import { bold, cyan, dim, green, red, yellow } from "./theme.js";

/**
 * ADR-0087 M3 — review / apply / dismiss a proposed plan, one D3 registry
 * surface.
 *
 * THE CONSENT BAR IS THE POINT (the retirement ledger's own words: "consent
 * must render the full step table before apply"): the selected run's steps
 * render with crew member, mode, gate, handoff and on-failure per step —
 * BEFORE the verbs are live — and nothing runs until the exact plan shown
 * is applied. Apply FILES the plan's tasks; it does not execute anything
 * (the shell desk queues and files, never runs inline — the D43 rule), and
 * the confirmation says "filed", never "ran".
 *
 * Every proposal string is agent-or-heuristic-authored → terminalSafe.
 */

export type WorkflowsPaneState = {
  readonly phase: "loading" | "list";
  readonly runs: readonly WorkflowRunRecord[];
  readonly cursor: number;
  /** An apply/dismiss in flight — verbs disarmed, said on screen. */
  readonly busy: "apply" | "dismiss" | null;
  /** Runs belonging to OTHER workspaces, withheld and SAID (review
   *  finding: an unfenced list let this desk apply another workspace's
   *  plan without ever identifying it). The workspace fence degrades
   *  stated, never silently — the 0026 §9 posture. */
  readonly withheldForeign: number;
};

const STATUS_GLYPHS: Record<string, string> = {
  proposed: "◇",
  applied: "◆",
  running: "●",
  paused: "◐",
  done: "✓",
  abandoned: "✗",
};

export class WorkflowsPane implements Component {
  constructor(private readonly state: WorkflowsPaneState) {}

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [
      bold(" workflow runs ") +
        dim("review the exact plan; apply files its tasks — nothing runs"),
      "",
    ];
    if (this.state.phase === "loading") {
      lines.push(dim(" loading workflow runs…"));
      return lines;
    }
    if (this.state.withheldForeign > 0) {
      lines.push(
        yellow(
          ` ${this.state.withheldForeign} run(s) in other workspaces not shown — review them with \`muon workflow list\` there`
        )
      );
      lines.push("");
    }
    if (this.state.runs.length === 0) {
      lines.push(
        dim(" no workflow runs for this workspace — the `plan` action stores one")
      );
      lines.push("");
      lines.push(dim(" esc closes"));
      return lines;
    }
    this.state.runs.forEach((run, index) => {
      const marker = index === this.state.cursor ? cyan("▸ ") : "  ";
      const glyph = STATUS_GLYPHS[run.status] ?? "·";
      lines.push(
        `${marker}${glyph} ${dim(`[${run.status}]`)} ${terminalSafe(
          run.proposal.summary
        ).slice(0, 56)}`
      );
    });

    const selected = this.state.runs[this.state.cursor];
    if (selected) {
      lines.push("");
      lines.push(
        cyan(" the exact plan ") +
          dim(`(${selected.proposal.steps.length} step(s) · run ${selected.id.slice(0, 8)})`)
      );
      // THE FULL TABLE — one line per step, every governance coordinate the
      // apply will materialize: crew member, mode, gate, handoff, on-fail.
      for (const step of selected.proposal.steps) {
        const crew =
          step.role === "human" ? "human" : (step.laneKey ?? `role:${step.role}`);
        const parts = [
          `${terminalSafe(step.stepKey)} ${terminalSafe(step.title).slice(0, 32)}`,
          `crew ${terminalSafe(crew)}`,
          `mode ${terminalSafe(step.harnessKey ?? "default")}`,
          step.gate ? `gate ${step.gate}` : "no gate",
          step.handoffTo ? `handoff → ${terminalSafe(step.handoffTo)}` : null,
          `on-fail ${terminalSafe(step.onFail ?? "escalate")}`,
          step.loop ? `loop ×${step.loop.maxIterations}` : null,
        ].filter((part): part is string => part !== null);
        lines.push(dim(`   ${parts.join(" · ")}`));
      }
      lines.push("");
      if (this.state.busy) {
        lines.push(dim(` ${this.state.busy === "apply" ? "applying" : "dismissing"}…`));
      } else if (selected.status === "proposed") {
        lines.push(
          green(" a apply — file these tasks exactly as shown") +
            dim(" · ") +
            red("x dismiss") +
            dim(" · esc close")
        );
      } else {
        // A non-proposed run is a RECORD: the verbs would be lies.
        lines.push(
          yellow(` this run is ${selected.status} — nothing to consent to`) +
            dim(" · esc close")
        );
      }
    }
    return lines.map((line) =>
      line.length > width * 4 ? line.slice(0, width * 4) : line
    );
  }
}
