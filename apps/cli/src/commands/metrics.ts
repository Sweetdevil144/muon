import type { Command } from "commander";
import { failCommand } from "../lib/refusal.js";
import { MuonApiClient } from "../lib/api-client.js";
import { formatDuration } from "../lib/format-duration.js";
import { printJson } from "../lib/output.js";

export function registerMetricsCommand(
  program: Command,
  createClient: () => MuonApiClient
) {
  program
    .command("metrics")
    .description(
      "Show coordination metrics: approval turnaround, handoff prep, duplicate briefings, cycle time"
    )
    .option("--json", "Print as JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const metrics = await createClient().getMetrics();

        if (options.json) {
          printJson({ metrics });
          return;
        }

        const lines = [
          "MUON coordination metrics",
          "",
          `Approvals:   ${metrics.approvals.decided} decided / ${metrics.approvals.pending} pending | ` +
            `turnaround avg ${formatDuration(metrics.approvals.averageTurnaroundMs)}, ` +
            `median ${formatDuration(metrics.approvals.medianTurnaroundMs)}`,
          `Handoffs:    ${metrics.handoffs.total} filed | ` +
            `prep after run avg ${formatDuration(metrics.handoffs.averagePrepMs)}, ` +
            `median ${formatDuration(metrics.handoffs.medianPrepMs)} ` +
            `(${metrics.handoffs.prepSamples} sample(s))`,
          `Briefings:   ${metrics.assignments.total} assignments | ` +
            `${metrics.assignments.duplicateBriefings} duplicate briefing(s) across ` +
            `${metrics.assignments.tasksWithDuplicates} task(s)`,
          `Cycle time:  ${metrics.tasks.completed}/${metrics.tasks.total} tasks done | ` +
            `avg ${formatDuration(metrics.tasks.averageCycleMs)}, ` +
            `median ${formatDuration(metrics.tasks.medianCycleMs)}`,
        ];
        process.stdout.write(`${lines.join("\n")}\n`);
      } catch (error) {
        failCommand(error, "Failed to load metrics.");
      }
    });
}
