import type { Command } from "commander";
import { failCommand } from "../lib/refusal.js";
import { MuonApiClient } from "../lib/api-client.js";
import { buildOnboardReport } from "../lib/onboard-report.js";

/**
 * `muon onboard`, the guided first-run flow. Prints the per-vendor readiness
 * table (installed? logged in?) + the exact fix hint for any gap + the "you're
 * ready, try `muon run …`" next step, and exits non-zero when nothing is ready.
 *
 * Complements `muon doctor` (the machine-readable JSON diagnostic): onboard is
 * the human-facing guided path. It only READS readiness booleans + hints and
 * GUIDES the user to run the vendor's native login, MUON never handles a token.
 */
export function registerOnboardCommand(
  program: Command,
  createClient: () => MuonApiClient
) {
  program
    .command("onboard")
    .description(
      "Guided first-run: connect a coding-agent CLI, then run your first task"
    )
    .action(async () => {
      try {
        const client = createClient();
        // refresh:true so a just-completed login is reflected immediately.
        // null (probe/route down) degrades to honest manual steps + exit 1.
        const readiness = await client
          .getVendorReadiness({ refresh: true })
          .catch(() => null);
        const report = buildOnboardReport(readiness);
        for (const line of report.lines) {
          process.stdout.write(`${line}\n`);
        }
        if (report.exitCode !== 0) {
          process.exitCode = report.exitCode;
        }
      } catch (error) {
        failCommand(error, "Onboard failed.");
      }
    });
}
