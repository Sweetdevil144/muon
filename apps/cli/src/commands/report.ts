import type { Command } from "commander";
import { failCommand } from "../lib/refusal.js";
import { MuonApiClient } from "../lib/api-client.js";
import { buildTaskReport } from "../lib/report.js";

export function registerReportCommand(
  program: Command,
  createClient: () => MuonApiClient
) {
  const report = program
    .command("report")
    .description(
      "Export a markdown run report (assignments, events, handoffs, approvals) for a task"
    )
    .option("--task-id <taskId>", "Task identifier")
    .action(async (options: { taskId?: string }) => {
      if (!options.taskId) {
        failCommand(
          new Error("--task-id is required (or use `muon report audit`)"),
          "Failed to build report."
        );
        return;
      }
      try {
        const client = createClient();
        const [task, events] = await Promise.all([
          client.getTaskDetail(options.taskId),
          client.listTaskEvents(options.taskId),
        ]);

        process.stdout.write(`${buildTaskReport({ task, events })}\n`);
      } catch (error) {
        failCommand(error, "Failed to build report.");
      }
    });

  // F5 — the exportable, principal-stamped audit trail (operator tier).
  report
    .command("audit")
    .description(
      "Export the append-only audit trail as JSONL: who (principal + accountable human) did what, when"
    )
    .option("--task-id <taskId>", "Only this task")
    .option("--kind <kind>", "Only this event kind (e.g. approval.resolved, dispatch.created, merge.executed, memory.adjudicated)")
    .option("--since <iso>", "Events at or after this instant")
    .option("--until <iso>", "Events at or before this instant")
    .option("--limit <n>", "Max rows (default 2000, cap 10000)")
    .action(async (options: {
      taskId?: string;
      kind?: string;
      since?: string;
      until?: string;
      limit?: string;
    }) => {
      try {
        const client = createClient();
        const jsonl = await client.exportAuditTrail({
          taskId: options.taskId,
          kind: options.kind,
          since: options.since,
          until: options.until,
          limit: options.limit ? Number(options.limit) : undefined,
        });
        process.stdout.write(jsonl);
      } catch (error) {
        failCommand(error, "Failed to export the audit trail.");
      }
    });
}
