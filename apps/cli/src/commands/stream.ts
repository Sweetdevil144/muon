import type { Command } from "commander";
import { failCommand } from "../lib/refusal.js";
import { MuonApiClient } from "../lib/api-client.js";
import { printJson } from "../lib/output.js";

// Wave 1/2 read-surface parity: the CLI could only tail a live run/loop. This
// replays an EXISTING job's recorded stream chunks (GET /api/streams) by
// task/run/session/agent — for post-hoc inspection of what a lane actually
// emitted, including a hung/interrupted crew.
export function registerStreamCommands(
  program: Command,
  createClient: () => MuonApiClient
) {
  const stream = program
    .command("stream")
    .description("Replay recorded agent output streams");

  stream
    .command("read")
    .description(
      "Read/replay recorded stream chunks by task/run/session/agent"
    )
    .option("--task-id <id>", "Filter by task")
    .option("--run-id <id>", "Filter by run")
    .option("--session-id <id>", "Filter by session")
    .option("--agent-id <id>", "Filter by agent")
    .option("--after-seq <n>", "Only chunks after this sequence number")
    .option("--limit <n>", "Max chunks to return")
    .option("--latest", "Return the NEWEST chunks (resume a long history)")
    .option("--json", "Print as JSON")
    .action(
      async (options: {
        taskId?: string;
        runId?: string;
        sessionId?: string;
        agentId?: string;
        afterSeq?: string;
        limit?: string;
        latest?: boolean;
        json?: boolean;
      }) => {
        try {
          if (
            !options.taskId &&
            !options.runId &&
            !options.sessionId &&
            !options.agentId
          ) {
            throw new Error(
              "Provide at least one of --task-id / --run-id / --session-id / --agent-id."
            );
          }
          const afterSeq =
            options.afterSeq !== undefined ? Number(options.afterSeq) : undefined;
          if (
            afterSeq !== undefined &&
            (!Number.isInteger(afterSeq) || afterSeq < 0)
          ) {
            throw new Error("--after-seq must be a non-negative integer.");
          }
          const limit =
            options.limit !== undefined ? Number(options.limit) : undefined;
          if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
            throw new Error("--limit must be a positive integer.");
          }
          const chunks = await createClient().listStreamChunks({
            taskId: options.taskId,
            runId: options.runId,
            sessionId: options.sessionId,
            agentId: options.agentId,
            afterSeq,
            limit,
            latest: options.latest,
          });
          if (options.json) {
            printJson({ chunks });
            return;
          }
          if (chunks.length === 0) {
            process.stdout.write("no stream chunks\n");
            return;
          }
          // Replay fidelity: emit the recorded content in sequence.
          for (const chunk of chunks) {
            process.stdout.write(chunk.content);
          }
        } catch (error) {
          failCommand(error, "Stream read failed.");
        }
      }
    );
}
