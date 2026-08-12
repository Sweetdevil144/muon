import type { Command } from "commander";
import { discoverLiveBrain, isProcessAlive } from "@muon/client";
import { failCommand } from "../lib/refusal.js";
import type { MuonApiClient } from "../lib/api-client.js";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for a pid to exit, bounded. True when it is gone. */
async function waitGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await delay(200);
  }
  return !isProcessAlive(pid);
}

/**
 * `muon shutdown` — stop the persistent local MUON processes cleanly.
 *
 * The embedded brain and the persistent runner are DELIBERATELY detached:
 * consecutive CLI commands reuse them instead of paying a boot each time.
 * The cost of that design is that nothing stops them when you are done — a
 * brain auto-spawned at 01:14 was still running at 22:16, got adopted by a
 * later desktop session, and read as a zombie. This command is the missing
 * OFF switch: runner first (it is the brain's client), then the brain (its
 * SIGTERM handler removes the lockfile), each verified gone.
 *
 * Scope: the LIVE brain this CLI would talk to (its own profile, or the
 * adopted sibling profile — exactly what `muon doctor` reports). The desktop
 * app stops its own processes on quit; this is for the CLI-spawned pair.
 */
export function registerShutdownCommand(
  program: Command,
  createClient: () => MuonApiClient
) {
  program
    .command("shutdown")
    .description(
      "Stop the persistent local brain and runner (the detached processes `muon` commands auto-start)"
    )
    .action(async () => {
      try {
        const brain = discoverLiveBrain();
        if (!brain) {
          process.stdout.write("no live brain found — nothing to stop\n");
          return;
        }
        process.stdout.write(
          `stopping the brain on port ${brain.lock.port} (pid ${brain.lock.pid}, profile ${brain.dataDir})\n`
        );

        // Runner first: it is a client of the brain, and stopping it first
        // means no half-dead runner keeps heartbeating a dying brain.
        try {
          const { runner } = await createClient().getRunner();
          const runnerPid = runner?.pid ?? null;
          if (typeof runnerPid === "number" && runnerPid > 0 && isProcessAlive(runnerPid)) {
            process.kill(runnerPid, "SIGTERM");
            const gone = await waitGone(runnerPid, 5_000);
            process.stdout.write(
              gone
                ? `runner stopped (pid ${runnerPid})\n`
                : `runner (pid ${runnerPid}) did not exit within 5s — inspect it manually before force-killing\n`
            );
          } else {
            process.stdout.write("no live runner registered\n");
          }
        } catch {
          process.stdout.write(
            "could not ask the brain about its runner (continuing to the brain itself)\n"
          );
        }

        process.kill(brain.lock.pid, "SIGTERM");
        const gone = await waitGone(brain.lock.pid, 5_000);
        if (gone) {
          process.stdout.write("brain stopped; lockfile removed by its own shutdown handler\n");
        } else {
          process.stdout.write(
            `brain (pid ${brain.lock.pid}) did not exit within 5s — it may be finishing a write; retry, or inspect it manually\n`
          );
          process.exitCode = 1;
        }
      } catch (error) {
        failCommand(error, "Shutdown failed.");
      }
    });
}
