import type { Command } from "commander";
import { MuonApiClient } from "../lib/api-client.js";
import { printError, printJson } from "../lib/output.js";
import { exitCodeForError, formatRefusal } from "../lib/refusal.js";

// Wave 1/2: the CLI mirror of the backend + MCP dispatch-control surface
// (dispatch_status / interrupt / steer). Before this, a CLI/CI operator whose
// run/loop/session timed out had no recourse but killing the whole runner — and
// the timeout messages already pointed at a `dispatch status` that did not exist.

export function registerDispatchCommands(
  program: Command,
  createClient: () => MuonApiClient
) {
  const dispatch = program
    .command("dispatch")
    .description("Inspect and control dispatched jobs (the governed crew)");

  dispatch
    .command("status")
    .description(
      "Show one job's status + crew budget (--job-id), or list active jobs"
    )
    .option("--job-id <id>", "A specific job to inspect")
    .option("--chat-id <id>", "Filter the active-job list to one chat")
    .option("--json", "Print as JSON")
    .action(
      async (options: {
        jobId?: string;
        chatId?: string;
        json?: boolean;
      }) => {
        const client = createClient();
        try {
          if (options.jobId) {
            const job = await client.getDispatchJob(options.jobId);
            const budget = await client
              .getDispatchBudget(options.jobId)
              .catch(() => null);
            if (options.json) {
              printJson({ job, budget });
              return;
            }
            process.stdout.write(
              `job ${job.id}\n` +
                `  status: ${job.status}   vendor: ${job.vendor}   kind: ${job.kind}\n` +
                `  task:   ${job.taskId}\n` +
                (job.parentJobId ? `  parent: ${job.parentJobId}\n` : "") +
                (budget
                  ? `  crew:   ${budget.childrenIssued}/${budget.maxChildren ?? "∞"} direct children · ` +
                    `${budget.descendantsIssued}/${budget.maxDescendants ?? "∞"} descendants · ` +
                    `${Math.round(budget.remainingMs / 1000)}s pool remaining\n`
                  : "")
            );
            return;
          }
          // Review (control-F1): filter active jobs SERVER-SIDE. The backend list
          // is oldest-first, capped at 50; filtering client-side over an unfiltered
          // page silently hid every active (newest) job once >50 terminal jobs
          // accumulated — the exact discovery→interrupt/steer/raise path this
          // command exists for would then dead-end on "No active dispatched jobs".
          // Every other consumer (TUI, desktop, native-proxy) already does this.
          const active = await client.listDispatchJobs({
            activeOnly: true,
            limit: 200,
            ...(options.chatId ? { chatId: options.chatId } : {}),
          });
          if (options.json) {
            printJson({ active });
            return;
          }
          if (active.length === 0) {
            process.stdout.write("No active dispatched jobs.\n");
            return;
          }
          for (const job of active) {
            process.stdout.write(
              `${job.id}  ${job.status.padEnd(11)} ${job.vendor.padEnd(11)} task ${job.taskId}\n`
            );
          }
        } catch (error) {
          printError(formatRefusal(error, "dispatch status"));
          process.exitCode = exitCodeForError(error);
        }
      }
    );

  dispatch
    .command("interrupt")
    .description("Interrupt a running dispatched job (the crew's kill switch)")
    .requiredOption("--job-id <id>", "The job to interrupt")
    .option("--json", "Print as JSON")
    .action(async (options: { jobId: string; json?: boolean }) => {
      try {
        await createClient().interruptDispatchJob(options.jobId);
        if (options.json) {
          printJson({ ok: true, jobId: options.jobId, action: "interrupt" });
          return;
        }
        process.stdout.write(
          `✓ interrupt requested for job ${options.jobId}\n`
        );
      } catch (error) {
        printError(formatRefusal(error, "dispatch interrupt"));
        process.exitCode = exitCodeForError(error);
      }
    });

  dispatch
    .command("revoke-grants")
    .description(
      "Revoke a job's live credential NOW (operator authority). The process may keep running — interrupt stops it; this kills its authenticated identity."
    )
    .requiredOption("--job-id <id>", "The job whose grants die")
    .option("--json", "Print as JSON")
    .action(async (options: { jobId: string; json?: boolean }) => {
      try {
        const result = await createClient().revokeDispatchGrants(options.jobId);
        if (options.json) {
          printJson(result);
          return;
        }
        process.stdout.write(
          `✓ revoked ${result.revoked} grant(s) of job ${result.jobId} — ${result.note}\n`
        );
      } catch (error) {
        printError(formatRefusal(error, "dispatch revoke-grants"));
        process.exitCode = exitCodeForError(error);
      }
    });

  dispatch
    .command("steer")
    .description("Send a steer message to a running dispatched job")
    .requiredOption("--job-id <id>", "The job to steer")
    .requiredOption("--message <text>", "The steer message")
    .option("--json", "Print as JSON")
    .action(async (options: { jobId: string; message: string; json?: boolean }) => {
      try {
        await createClient().steerDispatchJob(options.jobId, options.message);
        if (options.json) {
          printJson({ ok: true, jobId: options.jobId, action: "steer" });
          return;
        }
        process.stdout.write(`✓ steer sent to job ${options.jobId}\n`);
      } catch (error) {
        printError(formatRefusal(error, "dispatch steer"));
        process.exitCode = exitCodeForError(error);
      }
    });

  dispatch
    .command("raise")
    .description(
      "Raise a mission's descendant wall-clock pool (operator recourse when a crew exhausts its budget)"
    )
    // The raise targets the ROOT orchestrator job; delegated children share the
    // root's pool. The CLI carries the operator token, so the backend applies it
    // DIRECTLY — no gate receipt needed (that path is only for the agent tier).
    .requiredOption("--job-id <id>", "The root orchestrator job to raise")
    .requiredOption(
      "--pool-ms <ms>",
      "New descendant wall-clock pool in ms (must exceed the current pool)"
    )
    .option("--json", "Print as JSON")
    .action(
      async (options: { jobId: string; poolMs: string; json?: boolean }) => {
        try {
          const maxDescendantWallMs = Number(options.poolMs);
          if (
            !Number.isInteger(maxDescendantWallMs) ||
            maxDescendantWallMs <= 0
          ) {
            throw new Error("--pool-ms must be a positive integer of milliseconds.");
          }
          const budget = await createClient().raiseDispatchBudget(options.jobId, {
            maxDescendantWallMs,
          });
          if (options.json) {
            printJson({ budget });
            return;
          }
          process.stdout.write(
            `✓ pool raised for mission ${options.jobId}\n` +
              `  crew:   ${budget.childrenIssued}/${budget.maxChildren ?? "∞"} direct children · ` +
              `${budget.descendantsIssued}/${budget.maxDescendants ?? "∞"} descendants · ` +
              `${Math.round(budget.remainingMs / 1000)}s pool remaining\n`
          );
        } catch (error) {
          printError(formatRefusal(error, "dispatch raise"));
          process.exitCode = exitCodeForError(error);
        }
      }
    );
}
