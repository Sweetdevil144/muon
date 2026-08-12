import type { Command } from "commander";
import { failCommand } from "../lib/refusal.js";
import { MuonApiClient } from "../lib/api-client.js";
import { printJson } from "../lib/output.js";

export function registerHandoffCommand(program: Command, createClient: () => MuonApiClient) {
  program
    .command("handoff")
    .description("Create a handoff packet between lanes")
    .requiredOption("--task-id <taskId>", "Task identifier")
    .requiredOption("--from-lane-id <fromLaneId>", "Source lane identifier")
    .requiredOption("--to-lane-id <toLaneId>", "Target lane identifier")
    .requiredOption("--title <packetTitle>", "Handoff packet title")
    .requiredOption("--body <packetBody>", "Handoff packet body")
    .option("--json", "Print as JSON")
    .action(
      async (options: {
        taskId: string;
        fromLaneId: string;
        toLaneId: string;
        title: string;
        body: string;
        json?: boolean;
      }) => {
        try {
          const payload = await createClient().createHandoff({
            taskId: options.taskId,
            fromLaneId: options.fromLaneId,
            toLaneId: options.toLaneId,
            packetTitle: options.title,
            packetBody: options.body,
          });

          if (options.json) {
            printJson(payload);
            return;
          }

          process.stdout.write(
            `handoff created for task ${options.taskId} (${options.fromLaneId} -> ${options.toLaneId})\n`
          );
        } catch (error) {
          failCommand(error, "Failed to create handoff.");
        }
      }
    );
}
