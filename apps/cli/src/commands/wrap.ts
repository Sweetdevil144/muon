import type { Command } from "commander";
import {
  classifyHandoffPacket,
  describeHandoffContract,
} from "@muon/client";
import { failCommand } from "../lib/refusal.js";
import { MuonApiClient } from "../lib/api-client.js";
import { printJson } from "../lib/output.js";

/**
 * H7 — the session wrap, readable from the terminal.
 *
 * A finished job's typed handoff packet IS the wrap (ADR-0051 §5: the
 * human-readable artifact is the same facts as the packet, never a second
 * narrative). Desktop shows it in the handoff panel; agents read it via
 * `handoff_read`; this command is the CLI leg of the same coordinates: the
 * packet id printed here is the id a successor's `handoff_read` cites, and
 * the classification sentence comes from the ONE shared classifier
 * (`classifyHandoffPacket`), so the three surfaces cannot disagree about
 * whether a packet is typed, degraded, or prose.
 *
 * Read-only by construction. Memory proposals inside a packet are printed
 * under their real trust label — UNCONFIRMED — because a wrap never
 * auto-confirms anything.
 */
export function registerWrapCommand(
  program: Command,
  createClient: () => MuonApiClient
) {
  program
    .command("wrap")
    .description(
      "Show a finished task's wrap: the typed handoff packet, classified and skimmable"
    )
    .requiredOption("--task-id <taskId>", "Task identifier")
    .option("--all", "Show every handoff row, oldest first (default: newest only)")
    .option("--json", "Print as JSON")
    .action(
      async (options: { taskId: string; all?: boolean; json?: boolean }) => {
        try {
          const task = await createClient().getTaskDetail(options.taskId);
          const handoffs = task?.handoffs ?? [];
          if (handoffs.length === 0) {
            // Honest absence: a task with no packet has no wrap, and saying
            // so beats an empty screen a reader must interpret.
            process.stdout.write(
              `no wrap exists for task ${options.taskId}: no handoff packet has been filed.\n`
            );
            return;
          }
          const rows = options.all ? handoffs : handoffs.slice(-1);
          const views = rows.map((row) => {
            const classified = classifyHandoffPacket(row.packetJson);
            return {
              id: row.id,
              contract: classified.contract,
              contractSentence: describeHandoffContract(classified.contract),
              title: row.packetTitle,
              status: row.status,
              createdAt: row.createdAt,
              fromLane: row.fromLane?.name ?? null,
              toLane: row.toLane?.name ?? null,
              body: row.packetBody,
            };
          });
          if (options.json) {
            printJson({ taskId: options.taskId, wraps: views });
            return;
          }
          for (const view of views) {
            process.stdout.write(
              [
                `wrap ${view.id} · ${view.status} · ${view.createdAt}`,
                `${view.fromLane ?? "?"} -> ${view.toLane ?? "?"} · ${view.contractSentence}`,
                `# ${view.title}`,
                "",
                view.body.trimEnd(),
                "",
                `(successors cite packet id ${view.id} via handoff_read; memory proposals inside are UNCONFIRMED until a human confirms them)`,
                "",
              ].join("\n")
            );
          }
        } catch (error) {
          failCommand(error, "Failed to read the wrap.");
        }
      }
    );
}
