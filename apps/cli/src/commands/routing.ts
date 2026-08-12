import type { Command } from "commander";
import { failCommand } from "../lib/refusal.js";
import { MuonApiClient } from "../lib/api-client.js";
import { printJson } from "../lib/output.js";

// Wave 1/2 read-surface parity: the CLI could only reach GET /api/routing/suggest
// via `assign --suggest` (task-id only). This exposes the FREE-TEXT pre-task
// planning path (`suggestLanes(undefined, text)`) that the backend already
// supports — pick a lane before a task exists.
export function registerRoutingCommands(
  program: Command,
  createClient: () => MuonApiClient
) {
  const routing = program
    .command("routing")
    .description("Lane routing suggestions");

  routing
    .command("suggest")
    .description(
      "Suggest lanes for a free-text task description (pre-task planning), or for an existing --task-id"
    )
    .argument("[text...]", "Free-text task description")
    .option("--task-id <id>", "Score against an existing task instead of free text")
    .option("--json", "Print as JSON")
    .action(
      async (text: string[], options: { taskId?: string; json?: boolean }) => {
        try {
          const freeText = text.join(" ").trim();
          if (!options.taskId && !freeText) {
            throw new Error(
              "Provide a free-text task description or --task-id."
            );
          }
          const suggestions = await createClient().suggestLanes(
            options.taskId,
            freeText || undefined
          );
          if (options.json) {
            printJson({ suggestions });
            return;
          }
          if (suggestions.length === 0) {
            process.stdout.write("no lane suggestions\n");
            return;
          }
          process.stdout.write("lane recommendations (best first):\n");
          suggestions.forEach((suggestion, index) => {
            process.stdout.write(
              `${index + 1}. ${suggestion.laneName} (${suggestion.laneKey}), score ${suggestion.score}, ${suggestion.reason}\n`
            );
          });
        } catch (error) {
          failCommand(error, "Routing suggest failed.");
        }
      }
    );
}
