import type { Command } from "commander";
import { failCommand } from "../lib/refusal.js";
import { runLaneDoctor } from "@muon/core";
import { collectCapabilityPreflight } from "@muon/client";
import { MuonApiClient } from "../lib/api-client.js";
import { buildDoctorReport } from "../lib/doctor-report.js";
import { printJson } from "../lib/output.js";
import { defaultVendorIo } from "@muon/client/mcp-vendor-config";
import { enrolmentHealth, repairEnrolment } from "./setup.js";
import { detectLedgerCollision } from "@muon/client/ledger-profile";

export function registerDoctorCommand(program: Command, createClient: () => MuonApiClient) {
  program
    .command("doctor")
    .description("Check MUON backend connectivity and lane health")
    .option("--json", "print only the versioned capability preflight contract")
    .option(
      "--fix",
      "repair what can be repaired: re-register MUON in the agent CLIs you already chose"
    )
    .action(async (options: { json?: boolean; fix?: boolean }) => {
      try {
        const client = createClient();
        // WHAT A USER ACTUALLY MEANS BY "IS MUON WORKING".
        //
        // The backend/lane report below answers "is the brain healthy", which
        // is not the question someone asks when their agent lost MUON's tools.
        // That question is "am I still registered where I asked to be", and
        // nothing answered it — so a drifted vendor config (an upgrade rewrote
        // it, a profile moved, a `claude mcp remove`) looked like a MUON
        // outage with no next step.
        //
        // `--fix` re-applies the choice already recorded on this machine. It
        // restores a decision the human made; it cannot invent one, and it
        // mints nothing.
        // ONE MACHINE, ONE LEDGER (ADR-0050). Reported, never resolved: two
        // databases with overlapping ids cannot be merged into a truthful
        // history, so the only honest move is to name both and let the human
        // keep one. Cheap (two stats) and it runs before anything can fail.
        const ledgers = detectLedgerCollision();

        let enrolment = enrolmentHealth(defaultVendorIo());
        if (options.fix && enrolment.drifted.length > 0) {
          process.stderr.write(
            `repairing MUON's registration in ${enrolment.drifted.join(", ")}…\n`
          );
          const repair = repairEnrolment(defaultVendorIo());
          for (const row of repair) {
            process.stderr.write(
              row.ok
                ? `  ✓ ${row.vendor}\n`
                : `  ✗ ${row.vendor}: ${row.reason}\n`
            );
          }
          // RE-READ rather than assume: a repair that reported success and did
          // not land would otherwise be indistinguishable from one that did.
          enrolment = enrolmentHealth(defaultVendorIo());
        }
        // The one P0.5 contract. refresh:true bypasses the readiness cache so
        // green-checks appear immediately after a login. The collector NEVER
        // rejects: every unreadable source degrades to its unknown state with
        // a stable reason code, so doctor prints honest JSON even with the
        // backend down.
        const preflight = await collectCapabilityPreflight(client, {
          refresh: true,
        });

        if (options.json) {
          // stdout is ONLY the contract, UNCHANGED. The registration is
          // deliberately not merged in and not wrapped around it: this is a
          // versioned contract other surfaces parse, and both growing a field
          // and nesting the whole thing break a consumer that was working.
          // `muon setup --json` reports registration.
          printJson(preflight);
          if (ledgers.split) {
            // stdout stays the contract, byte for byte; the split goes to
            // stderr so a human is told and a parser is unaffected.
            process.stderr.write(`\nledger: ${ledgers.detail}\n`);
          }
          process.exitCode = preflight.status === "ready" ? 0 : 1;
          return;
        }

        // Legacy human payload: each source is best-effort on its own, so one
        // failed read can no longer take down the whole report.
        const [health, lanes, dashboard] = await Promise.all([
          client.health().catch(() => null),
          client.listLanes().catch(() => null),
          client.dashboard().catch(() => null),
        ]);
        const laneDoctor = lanes
          ? await runLaneDoctor(
              lanes.map((laneItem) => ({
                id: laneItem.id,
                key: laneItem.key,
                name: laneItem.name,
                role: laneItem.role,
                status: laneItem.status,
              }))
            ).catch(() => null)
          : null;

        const report = buildDoctorReport({
          preflight,
          health,
          laneCount: lanes?.length ?? 0,
          pendingApprovals: dashboard?.pendingApprovals ?? 0,
          activeHandoffs: dashboard?.activeHandoffs ?? 0,
          laneDoctor,
        });
        printJson({ ...report.payload, mcpRegistration: enrolment, ledgers });
        if (ledgers.split) {
          process.stderr.write(`\nledger: ${ledgers.detail}\n`);
        }
        if (enrolment.status !== "healthy") {
          // On stderr, so `--json`-shaped consumers of stdout are unaffected
          // while a human reading the terminal is told the one thing that has
          // a remedy.
          process.stderr.write(
            `\nMCP registration: ${enrolment.detail}\n` +
              (options.fix
                ? ""
                : "Run `muon doctor --fix` to repair it, or `muon setup` if you have not chosen your agent CLIs yet.\n")
          );
        }
        process.exitCode = report.exitCode;
      } catch (error) {
        // Programmer errors only; degraded environments are handled above.
        failCommand(error, "Doctor check failed.");
      }
    });
}
