import { terminalSafe, terminalSafeBlock } from "@muon/client";
import {
  annotatedHandoffPacketSchema,
  orderForReport,
} from "@muon/protocol";
import type { RecordedEvent, TaskDetail } from "../types.js";

export type BuildTaskReportInput = {
  task: TaskDetail;
  events: RecordedEvent[];
  generatedAt?: string;
};


/**
 * ADR-0037 phase 2 — render a handoff's checks, with MUON's own flakiness
 * annotation, where a human actually reads them.
 *
 * Phase 1 computed that annotation and it reached NOBODY: every consumer
 * re-validated with `handoffPacketSchema`, which strips unknown keys, and
 * `orderForReport` had no production caller at all. This is that caller, and
 * `annotatedHandoffPacketSchema` is what survives the round trip.
 *
 * `muon report` reads the task-detail route, which annotates server-side from
 * history MUON recorded — so what prints here is MUON's verdict, never the
 * packet's claim about itself.
 *
 * Three ADR-0037 properties this rendering has to keep:
 *   D1 the OUTCOME is printed as-is. A failure prints as a failure whatever
 *      its history says; the note is appended, never substituted.
 *   D4 LOSSLESS. `orderForReport` reorders and drops nothing, so a
 *      known-flaky failure still appears — lower, still failed.
 *   D3 the note claims nothing. It reports counts; it never says "ignore".
 */
function renderPacketChecks(packetJson: unknown): string[] {
  if (packetJson === null || packetJson === undefined) return [];
  const parsed = annotatedHandoffPacketSchema.safeParse(packetJson);
  if (!parsed.success || parsed.data.checks.length === 0) return [];

  const annotated = parsed.data.checks.map((check) => ({
    ...check,
    flakiness: check.flakiness ?? {
      kind: "insufficient-evidence" as const,
      runs: 0,
      failures: 0,
    },
    flakinessNote: check.flakinessNote ?? "",
  }));

  const lines: string[] = ["**Checks**", ""];
  for (const check of orderForReport(annotated)) {
    const exit =
      check.exitCode !== undefined ? ` (exit ${check.exitCode})` : "";
    const summary = check.summary ? `: ${check.summary}` : "";
    // The note rides AFTER the outcome, on the same line, so it is impossible
    // to read the history without also reading what actually happened.
    const note =
      check.flakinessNote && check.flakiness.runs > 0
        ? ` — ${check.flakinessNote}`
        : "";
    lines.push(`- [${check.outcome}] ${check.name}${exit}${summary}${note}`);
  }
  lines.push("");
  return lines;
}

function laneLabel(lane?: { name: string; key: string }): string {
  return lane ? `${lane.name} (${lane.key})` : "(unknown lane)";
}

/**
 * Renders the who/what/when/why trail for one task as markdown:
 * assignments (who), event timeline (what/when), handoffs, approvals (why).
 */
export function buildTaskReport(input: BuildTaskReportInput): string {
  const { task, events } = input;
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const lines: string[] = [];

  lines.push(`# MUON Run Report, ${task.title}`);
  lines.push("");
  lines.push(`- Task: \`${task.id}\``);
  lines.push(`- Status: ${task.status} | Priority: ${task.priority}`);
  lines.push(`- Created: ${task.createdAt} | Updated: ${task.updatedAt}`);
  lines.push(`- Generated: ${generatedAt}`);
  lines.push("");
  lines.push("## Description");
  lines.push("");
  lines.push(task.description);
  lines.push("");

  lines.push("## Assignments (who)");
  lines.push("");
  if (task.assignments.length === 0) {
    lines.push("_No assignments recorded._");
  } else {
    for (const assignment of task.assignments) {
      const completed = assignment.completedAt
        ? ` | completed ${assignment.completedAt}`
        : "";
      lines.push(
        `- ${assignment.createdAt}, ${laneLabel(assignment.lane)}: ${terminalSafe(assignment.summary)} [${assignment.state}${completed}]`
      );
    }
  }
  lines.push("");

  lines.push("## Event timeline (what/when)");
  lines.push("");
  if (events.length === 0) {
    lines.push("_No events recorded. Run with `--record` to capture them._");
  } else {
    for (const event of events) {
      lines.push(
        `- \`${event.timestamp}\`, **${event.kind}** (${event.laneId}): ${terminalSafe(event.message)}`
      );
    }
  }
  lines.push("");

  lines.push("## Handoffs");
  lines.push("");
  if (task.handoffs.length === 0) {
    lines.push("_No handoffs recorded._");
  } else {
    for (const handoff of task.handoffs) {
      const fromName = handoff.fromLane?.name ?? "(unknown lane)";
      const toName = handoff.toLane?.name ?? "(unknown lane)";
      lines.push(`### ${terminalSafe(handoff.packetTitle)}, ${fromName} -> ${toName}`);
      lines.push("");
      lines.push(`- Created: ${handoff.createdAt} | Status: ${handoff.status}`);
      lines.push("");
      lines.push(...renderPacketChecks(handoff.packetJson));
      // The packet body is the worker's FINAL message, parsed — multi-line by
      // design, so the BLOCK sanitizer keeps paragraphs while stripping the
      // escapes/bidi that could repaint the report around it.
      lines.push(terminalSafeBlock(handoff.packetBody));
      lines.push("");
    }
  }
  lines.push("");

  lines.push("## Approvals (why)");
  lines.push("");
  if (task.approvals.length === 0) {
    lines.push("_No approvals recorded._");
  } else {
    for (const approval of task.approvals) {
      const decided = approval.decidedAt
        ? ` | decided ${approval.decidedAt}`
        : "";
      const notes = approval.decisionNotes
        ? `, notes: ${approval.decisionNotes}`
        : "";
      lines.push(
        `- ${approval.createdAt}, ${approval.kind} requested by ${approval.requestedBy}: "${approval.reason}" → **${approval.status}**${decided}${notes}`
      );
    }
  }
  lines.push("");

  return lines.join("\n");
}
