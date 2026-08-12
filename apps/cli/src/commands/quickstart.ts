import type { Command } from "commander";
import {
  classifyVendorFailure,
  isAuthorizationFailure,
  pickQuickstartVendor,
  seedQuickstartTask,
} from "@muon/client";
import { defaultCoordinatorVendor } from "@muon/client/vendors";
import { MuonApiClient } from "../lib/api-client.js";
import { failCommand } from "../lib/refusal.js";
import { resolveApiBase } from "../lib/config.js";
import { ensureRunner } from "../lib/ensure-runner.js";
import { buildOnboardReport } from "../lib/onboard-report.js";
import { printError } from "../lib/output.js";

/**
 * `muon quickstart`, the guided FIRST TASK. Closes the last gap in the
 * install → onboard → first task → see-the-moat journey: once a vendor is
 * connected, it seeds ONE tiny, safe, additive sample task into the chosen
 * workspace and dispatches it, so a fresh user watches the whole loop run
 * (dispatch → agent works → memory captured → hero context) without inventing a
 * task. When nothing is connected it routes to onboarding, never a dead end.
 *
 * Never destructive (the sample only ADDS two files), workspace-scoped (the
 * backend validates the folder against the P3-B allowlist), and never handles a
 * vendor token (it drives the user's already-connected CLI).
 */
export function registerQuickstartCommand(
  program: Command,
  createClient: () => MuonApiClient
) {
  program
    .command("quickstart")
    .description(
      "Guided first task: seed a safe sample task and dispatch it so you can watch MUON's loop run"
    )
    .option(
      "--workspace <dir>",
      "Folder the sample task runs in (default: current directory)"
    )
    .action(async (options: { workspace?: string }) => {
      try {
        const client = createClient();
        const apiBase = resolveApiBase(
          program.opts<{ apiBase?: string }>().apiBase
        );
        const workspacePath = options.workspace ?? process.cwd();

        // refresh:true so a just-completed login is reflected; null (probe/route
        // down) degrades to the onboarding report's honest manual steps.
        const readiness = await client
          .getVendorReadiness({ refresh: true })
          .catch(() => null);

        const vendor = pickQuickstartVendor(readiness);
        if (!vendor) {
          // No dead end: show the exact onboarding guidance + the fix hints, and
          // exit non-zero so scripts see "not ready yet".
          process.stdout.write(
            "No coding agent is connected yet, connect one, then run `muon quickstart` again.\n\n"
          );
          for (const line of buildOnboardReport(readiness).lines) {
            process.stdout.write(`${line}\n`);
          }
          process.exitCode = 1;
          return;
        }

        // Dispatched jobs need a persistent runner to execute, auto-start one so
        // the human never has to (mirrors `muon chat`). RAW flags ride along so
        // the lease + runner env use the same credential pairing as `client`.
        const rawFlags = program.opts<{ apiBase?: string; apiToken?: string }>();
        const runner = await ensureRunner(client, {
          apiBase,
          apiBaseFlag: rawFlags.apiBase,
          apiTokenFlag: rawFlags.apiToken,
        });
        if (runner.live) {
          process.stderr.write(
            runner.started
              ? "✓ started a background runner for the dispatched task\n"
              : "✓ runner online\n"
          );
        } else {
          // Wave 1: no runner ⇒ the dispatched first task would sit QUEUED
          // forever. Fail fast instead of printing a false "✓ dispatched …
          // watch it run" that never executes. Review (CLI-F4): a runner that is
          // still cold-booting should say "re-run shortly", not "start one".
          process.stderr.write(
            runner.started
              ? `✗ ${
                  runner.note ??
                  "A runner is still starting (cold Seatbelt boot)."
                } Re-run \`muon quickstart\` in a few seconds.\n`
              : `✗ ${runner.note ?? "No persistent runner is online."} ` +
                  "Start one with `muon runner`, then rerun `muon quickstart`.\n"
          );
          process.exitCode = 1;
          return;
        }

        const outcome = await seedQuickstartTask(client, {
          workspacePath,
          vendor,
        });
        if (!outcome.ok) {
          // Readiness raced away between the pick and the seed, route to onboarding.
          for (const line of buildOnboardReport(readiness).lines) {
            process.stdout.write(`${line}\n`);
          }
          process.exitCode = 1;
          return;
        }

        process.stdout.write(
          `\n✓ Seeded your first task and dispatched it to ${outcome.vendor}.\n` +
            `  task:  ${outcome.task.id}\n` +
            `  job:   ${outcome.job.id}\n` +
            `  where: ${workspacePath}\n\n` +
            "The agent is summarizing your repository's structure — a safe,\n" +
            "read-only first task that writes nothing. Watch it run:\n" +
            `  muon report --task-id ${outcome.task.id}\n` +
            "  muon task list\n\n" +
            "Then see the moat, the memory MUON captured from the run:\n" +
            `  muon memory recall --task-id ${outcome.task.id}\n`
        );
      } catch (error) {
        // A brain-side authority refusal is NOT a vendor failure: classified
        // FIRST, or a 403 prints "Claude Code isn't connected" and sends the
        // user to re-login a CLI that is fine (same guard as run.ts).
        if (isAuthorizationFailure(error)) {
          failCommand(error, "Quickstart failed.");
          return;
        }
        // A dispatch/setup failure gets a CLEAR, actionable message, not a dump.
        const readiness = await createClient()
          .getVendorReadiness()
          .catch(() => null);
        // WAVE E: the last `?? "claude-code"` in the tree. This one is only a
        // LABEL for the error notice on a path where readiness could not even
        // be re-read, so it names no lane MUON is about to run.
        const vendor = pickQuickstartVendor(readiness) ?? defaultCoordinatorVendor();
        const notice = classifyVendorFailure({ vendor, readiness, error });
        printError(`${notice.title}: ${notice.detail}`);
        if (notice.fixHint) {
          process.stderr.write(`→ ${notice.fixHint}\n`);
        } else if (notice.retryable) {
          process.stderr.write("→ retry: muon quickstart\n");
        }
        process.exitCode = 1;
      }
    });
}
