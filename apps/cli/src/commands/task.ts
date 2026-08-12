import { z } from "zod";
import { failCommand } from "../lib/refusal.js";
import type { Command } from "commander";
import { MuonApiClient } from "../lib/api-client.js";
import { printJson, printTask } from "../lib/output.js";
import type { TaskStatus } from "../types.js";

const taskIdSchema = z.string().min(1);

export function registerTaskCommands(program: Command, createClient: () => MuonApiClient) {
  const task = program.command("task").description("Task commands — create, inspect, and settle governed work");

  task
    .command("list")
    .description("List tasks")
    .option("--json", "Print as JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const tasks = await createClient().listTasks();
        if (options.json) {
          printJson({ tasks });
          return;
        }

        tasks.forEach(printTask);
      } catch (error) {
        failCommand(error, "Failed to list tasks.");
      }
    });

  task
    .command("show")
    .description("Show a specific task")
    .requiredOption("--task-id <taskId>", "Task identifier")
    .option("--json", "Print as JSON")
    .action(async (options: { taskId: string; json?: boolean }) => {
      try {
        const taskId = taskIdSchema.parse(options.taskId);
        const tasks = await createClient().listTasks();
        const found = tasks.find((entry) => entry.id === taskId);

        if (!found) {
          throw new Error(`Task not found: ${taskId}`);
        }

        if (options.json) {
          printJson({ task: found });
          return;
        }

        printTask(found);
      } catch (error) {
        failCommand(error, "Failed to show task.");
      }
    });

  task
    .command("create")
    .description("Create a task in the ledger")
    .requiredOption("--title <title>", "Task title")
    .requiredOption("--description <description>", "Task description")
    .option(
      "--priority <priority>",
      "Task priority: low | medium | high",
      "medium"
    )
    .option(
      "--workspace <dir>",
      "Target repo folder agents should work in for this task"
    )
    .option("--json", "Print as JSON")
    .action(
      async (options: {
        title: string;
        description: string;
        priority: "low" | "medium" | "high";
        workspace?: string;
        json?: boolean;
      }) => {
        try {
          const created = await createClient().createTask({
            title: options.title,
            description: options.description,
            priority: options.priority,
            workspacePath: options.workspace,
          });

          if (options.json) {
            printJson({ task: created });
            return;
          }

          printTask(created);
        } catch (error) {
          failCommand(error, "Failed to create task.");
        }
      }
    );

  task
    .command("status")
    .description("Update a task status")
    .requiredOption("--task-id <taskId>", "Task identifier")
    .requiredOption(
      "--status <status>",
      "Status: backlog | in_progress | review | done | blocked"
    )
    .option("--json", "Print as JSON")
    .action(
      async (options: {
        taskId: string;
        status: TaskStatus;
        json?: boolean;
      }) => {
        try {
          const updated = await createClient().updateTaskStatus(
            options.taskId,
            options.status
          );

          if (options.json) {
            printJson({ task: updated });
            return;
          }

          printTask(updated);
        } catch (error) {
          failCommand(error, "Failed to update task status.");
        }
      }
    );
}
