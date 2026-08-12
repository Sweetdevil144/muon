import type { Command } from "commander";
import type { MuonApiClient } from "@muon/client";
import { defaultCoordinatorVendor } from "@muon/client/vendors";
import { printError, printJson } from "../lib/output.js";
import { exitCodeForError, formatRefusal } from "../lib/refusal.js";

function positiveInt(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function isoDate(raw: string, name: string): string {
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new Error(`${name} must be an ISO date/time.`);
  return new Date(ms).toISOString();
}

export function registerScheduleCommands(
  program: Command,
  createClient: () => MuonApiClient
): void {
  const schedule = program
    .command("schedule")
    .description("Create and pause hard-budgeted governed Mission Chat turns");

  schedule
    .command("list")
    .option("--json", "Print as JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const schedules = await createClient().listSchedules();
        if (options.json) return printJson({ schedules });
        if (schedules.length === 0) {
          process.stdout.write("no governed schedules\n");
          return;
        }
        for (const row of schedules) {
          const cadence = row.cadenceMinutes
            ? `every ${row.cadenceMinutes}m`
            : "one-shot";
          process.stdout.write(
            `${row.id}  ${row.status.padEnd(9)}  ${row.nextRunAt}  ${cadence}  ${row.title}\n`
          );
        }
      } catch (error) {
        printError(formatRefusal(error, "schedule list"));
        process.exitCode = exitCodeForError(error);
      }
    });

  schedule
    .command("create")
    .requiredOption("--title <title>", "Operator-visible label")
    .requiredOption("--objective <text>", "Mission objective")
    .requiredOption("--workspace <path>", "Governed workspace")
    .requiredOption("--next-run <iso>", "First start time (ISO 8601)")
    .option("--vendor <id>", "Coordinator vendor", defaultCoordinatorVendor())
    .option("--model <id>", "Coordinator model override")
    .option("--effort <level>", "Coordinator reasoning effort")
    .option("--cadence-minutes <n>", "Repeat cadence (minimum 5 minutes)")
    .option("--max-runs <n>", "Maximum occurrences")
    .option("--root-minutes <n>", "Root turn wall cap", "30")
    .option("--crew-minutes <n>", "Aggregate descendant wall cap", "160")
    .option("--json", "Print as JSON")
    .action(
      async (options: {
        title: string;
        objective: string;
        workspace: string;
        nextRun: string;
        vendor: string;
        model?: string;
        effort?: string;
        cadenceMinutes?: string;
        maxRuns?: string;
        rootMinutes: string;
        crewMinutes: string;
        json?: boolean;
      }) => {
        try {
          const cadenceMinutes = options.cadenceMinutes
            ? positiveInt(options.cadenceMinutes, "--cadence-minutes")
            : undefined;
          const row = await createClient().createSchedule({
            title: options.title,
            objective: options.objective,
            workspacePath: options.workspace,
            vendor: options.vendor,
            ...(options.model ? { model: options.model } : {}),
            ...(options.effort ? { effort: options.effort } : {}),
            ...(cadenceMinutes ? { cadenceMinutes } : {}),
            nextRunAt: isoDate(options.nextRun, "--next-run"),
            ...(options.maxRuns
              ? { maxRuns: positiveInt(options.maxRuns, "--max-runs") }
              : {}),
            maxWallMs: positiveInt(options.rootMinutes, "--root-minutes") * 60_000,
            maxDescendantWallMs:
              positiveInt(options.crewMinutes, "--crew-minutes") * 60_000,
          });
          if (options.json) return printJson({ schedule: row });
          process.stdout.write(
            `schedule '${row.id}' ${row.status}; next ${row.nextRunAt}\n` +
              "runs only while Desktop Full Auto and its live standing-approver lease are active\n"
          );
        } catch (error) {
          printError(formatRefusal(error, "schedule create"));
          process.exitCode = exitCodeForError(error);
        }
      }
    );

  for (const status of ["paused", "active"] as const) {
    const command = status === "paused" ? "pause" : "resume";
    schedule
      .command(command)
      .requiredOption("--id <scheduleId>", "Schedule id")
      .option("--next-run <iso>", "Replace the next start time (resume only)")
      .option("--json", "Print as JSON")
      .action(
        async (options: { id: string; nextRun?: string; json?: boolean }) => {
          try {
            if (status === "paused" && options.nextRun) {
              throw new Error("--next-run is valid only with schedule resume.");
            }
            const row = await createClient().updateSchedule({
              scheduleId: options.id,
              status,
              ...(options.nextRun
                ? { nextRunAt: isoDate(options.nextRun, "--next-run") }
                : {}),
            });
            if (options.json) return printJson({ schedule: row });
            process.stdout.write(`schedule '${row.id}' ${row.status}\n`);
          } catch (error) {
            printError(formatRefusal(error, `schedule ${command}`));
            process.exitCode = exitCodeForError(error);
          }
        }
      );
  }
}
