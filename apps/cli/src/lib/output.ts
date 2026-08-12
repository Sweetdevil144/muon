import { redactForLog } from "@muon/core";
import type { ApprovalRequest, Lane, Task } from "../types.js";

export function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** TODO 7.1: every CLI error path goes through the log redaction chokepoint. */
export function printError(message: string) {
  process.stderr.write(`error: ${redactForLog(message)}\n`);
}

export function printTask(task: Task) {
  process.stdout.write(
    `- ${task.id} | ${task.title} | ${task.status} | ${task.priority}\n`
  );
}

export function printLane(lane: Lane) {
  process.stdout.write(
    `- ${lane.id} | ${lane.name} (${lane.key}) | ${lane.role} | ${lane.status}\n`
  );
}

export function printApproval(approval: ApprovalRequest) {
  process.stdout.write(
    `- ${approval.id} | task=${approval.taskId} | ${approval.kind} | ${approval.status}\n`
  );
}
