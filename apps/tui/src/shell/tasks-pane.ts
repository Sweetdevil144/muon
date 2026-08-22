import { classifyHandoffPacket, terminalSafe } from "@muon/client";
import { sessionSlug } from "@muon/client/session-slug";
import type { Task, TaskDetail } from "@muon/client";
import type { Component } from "../vendor/pi-tui/src/tui.ts";
import { bold, cyan, dim, green, red, yellow } from "./theme.js";

/**
 * ADR-0087 — the M10+M11 pane family: the task ledger with its packets
 * zone, ONE surface (retirement ledger: "one pane family — the 0086/0080
 * render surface").
 *
 * What renders here and nowhere else on this desk:
 *  - each packet's CLASSIFICATION by THE shared classifier
 *    (`typed` / `typed_degraded` / `packet_parse_failed` / `prose_only`) —
 *    a schema fragment reads as loudly as the desk can say it;
 *  - 0086 D1 — the RECEIPT with the packet: whether the worker's session
 *    ended with a brain receipt, read from the parsed packet itself;
 *  - 0080 D3 — the DELIVERY verdicts: which jobs each packet reached,
 *    derived from the append-only offer rows the serve path writes.
 *    "filed, unread" and "read by the reviewer" are different sentences,
 *    and evidence is never authority — nothing here grants anything.
 *
 * Every agent-authored string passes `terminalSafe` (titles, packet
 * bodies): a raw string into a terminal is an ANSI-escape channel.
 */

export type TasksPaneState =
  | {
      readonly phase: "list";
      readonly tasks: readonly Task[];
      readonly cursor: number;
    }
  | {
      readonly phase: "detail";
      /** Kept so Esc-to-list restores the same selection. */
      readonly tasks: readonly Task[];
      readonly cursor: number;
      readonly detail: TaskDetail;
      readonly loading?: false;
    }
  | {
      readonly phase: "loading";
      readonly tasks: readonly Task[];
      readonly cursor: number;
    };

function packetLine(handoff: TaskDetail["handoffs"][number]): string[] {
  const classified = classifyHandoffPacket(handoff.packetJson);
  const word =
    classified.contract === "typed"
      ? green(classified.contract)
      : yellow(classified.contract);
  const lanes = `${handoff.fromLane?.name ?? "?"} → ${handoff.toLane?.name ?? "?"}`;
  const lines = [
    `   ${word} ${dim("·")} ${terminalSafe(handoff.packetTitle).slice(0, 48)} ${dim(`(${lanes})`)}`,
  ];
  // 0086 D1 — the receipt WITH the packet. Absence is stated, not omitted:
  // an absent receipt is the case most often misread as "nothing wrong".
  if (classified.packet) {
    const receipt = classified.packet.brainReceipt;
    lines.push(
      receipt
        ? dim(`     receipt: ${terminalSafe(String(receipt))}`)
        : yellow("     receipt: none recorded — the wrap carried no brain receipt")
    );
    if (classified.packet.degraded.flag) {
      lines.push(
        yellow(
          `     degraded: ${classified.packet.degraded.reasons.length} reason(s) — read the packet before trusting the summary`
        )
      );
    }
  }
  // 0080 D3 — delivery verdicts, derived (operator reads carry them).
  const deliveries = handoff.deliveries;
  if (deliveries !== undefined) {
    lines.push(
      deliveries.length === 0
        ? yellow("     delivery: filed, unread — no crew job has read this packet")
        : dim(
            `     delivery: read by ${deliveries
              .map((entry) => sessionSlug(entry.jobId))
              .slice(0, 4)
              .join(", ")}${deliveries.length > 4 ? ` +${deliveries.length - 4}` : ""}`
          )
    );
  }
  return lines;
}

export class TasksPane implements Component {
  constructor(private readonly state: TasksPaneState) {}

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    if (this.state.phase === "list" || this.state.phase === "loading") {
      lines.push(bold(" tasks ") + dim("⏎ opens a task's packets · esc closes"));
      lines.push("");
      if (this.state.tasks.length === 0) {
        lines.push(dim(" no tasks yet — `run` or `specialist` creates one"));
      }
      this.state.tasks.forEach((task, index) => {
        const marker = index === this.state.cursor ? cyan("▸ ") : "  ";
        lines.push(
          `${marker}${terminalSafe(task.title).slice(0, 44).padEnd(46)} ${dim(
            task.status
          )}`
        );
      });
      if (this.state.phase === "loading") {
        lines.push("", dim(" loading the task's packets…"));
      }
    } else {
      const detail = this.state.detail;
      lines.push(
        bold(" task ") +
          terminalSafe(detail.title).slice(0, 50) +
          dim(` · ${detail.status} · ⏎ back to the list · esc closes`)
      );
      lines.push("");
      const assignments = detail.assignments ?? [];
      if (assignments.length > 0) {
        lines.push(cyan(" assigned"));
        for (const assignment of assignments.slice(0, 4)) {
          lines.push(
            dim(
              `   ${assignment.lane?.name ?? "?"} · ${assignment.state} · ${terminalSafe(assignment.summary).slice(0, 50)}`
            )
          );
        }
        lines.push("");
      }
      const handoffs = detail.handoffs ?? [];
      lines.push(
        cyan(" packets") + dim(` (${handoffs.length}${handoffs.length === 0 ? " — none filed yet" : ""})`)
      );
      for (const handoff of handoffs) {
        lines.push(...packetLine(handoff));
      }
      const open = (detail.approvals ?? []).filter(
        (approval) => approval.status === "pending"
      ).length;
      if (open > 0) {
        lines.push("", red(` ${open} gate(s) pending on this task — the inbox decides them`));
      }
    }
    return lines.map((line) =>
      line.length > width * 4 ? line.slice(0, width * 4) : line
    );
  }
}
