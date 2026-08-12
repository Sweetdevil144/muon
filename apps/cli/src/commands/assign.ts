import type { Command } from "commander";
import { failCommand } from "../lib/refusal.js";
import { MuonApiClient } from "../lib/api-client.js";
import { printJson } from "../lib/output.js";

export function registerAssignCommand(program: Command, createClient: () => MuonApiClient) {
  program
    .command("assign")
    .description("Assign a task to a lane (use --suggest for a recommendation)")
    .requiredOption("--task-id <taskId>", "Task identifier")
    .option("--lane-id <laneId>", "Lane identifier")
    .option("--summary <summary>", "Assignment summary")
    .option(
      "--suggest",
      "Print evidence-based lane recommendations; assignment still requires --lane-id"
    )
    .option("--json", "Print as JSON")
    .action(
      async (options: {
        taskId: string;
        laneId?: string;
        summary?: string;
        suggest?: boolean;
        json?: boolean;
      }) => {
        try {
          const client = createClient();

          // Routing intelligence recommends; the human decides. --suggest
          // never assigns on its own.
          if (options.suggest) {
            const suggestions = await client.suggestLanes(options.taskId);
            if (options.json) {
              printJson({ suggestions });
            } else {
              process.stdout.write("lane recommendations (best first):\n");
              for (const [index, suggestion] of suggestions.entries()) {
                process.stdout.write(
                  `${index + 1}. ${suggestion.laneName} (${suggestion.laneKey}), score ${suggestion.score}, ${suggestion.reason}\n   assign with: muon assign --task-id ${options.taskId} --lane-id ${suggestion.laneId} --summary "..."\n`
                );
              }
            }
            if (!options.laneId) {
              return;
            }
          }

          if (!options.laneId || !options.summary) {
            throw new Error(
              "--lane-id and --summary are required to assign (or use --suggest to get a recommendation first)."
            );
          }

          const assignment = await client.assignTask({
            taskId: options.taskId,
            laneId: options.laneId,
            summary: options.summary,
          });

          if (options.json) {
            printJson(assignment);
            return;
          }

          process.stdout.write(
            `assigned task ${options.taskId} to lane ${options.laneId}\n`
          );
        } catch (error) {
          failCommand(error, "Assignment failed.");
        }
      }
    );
}
