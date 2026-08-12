import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { discoverLiveBrain, isProcessAlive, resolveDataDir } from "@muon/client";
import { failCommand } from "../lib/refusal.js";
import {
  buildUninstallPlan,
  confirmPrompt,
  describePlan,
  isAffirmative,
} from "../lib/uninstall-plan.js";

function npmUninstall(pkg: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["uninstall", "-g", pkg], { stdio: "ignore" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function askConfirmation(): Promise<boolean> {
  // NOT A TTY = NOT A YES. A piped or redirected stdin cannot consent, and a
  // destructive default in that case is how an uninstall lands inside someone's
  // CI script. `--yes` is the explicit, scriptable path.
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "Refusing to uninstall without a terminal to confirm at. Re-run with `--yes` if you meant it.\n"
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return isAffirmative(await rl.question(confirmPrompt()));
  } finally {
    rl.close();
  }
}

/**
 * `muon uninstall` — remove the CLI and TUI, and nothing else.
 *
 * The data dir is deliberately preserved and SAID SO. An uninstaller that
 * silently took the memory graph with it would be destroying months of
 * human-confirmed decisions on the strength of a single y/n, and no prompt is
 * informed enough to carry that.
 *
 * A live brain is stopped first: it is detached, so it would otherwise outlive
 * the CLI and leave the user with no `muon shutdown` to stop it.
 */
export function registerUninstallCommand(program: Command) {
  program
    .command("uninstall")
    .description("remove the MUON CLI + TUI (your data dir is kept)")
    .option("-y, --yes", "skip the confirmation prompt")
    .action(async (options: { yes?: boolean }) => {
      try {
        const dataDir = resolveDataDir();
        const brain = discoverLiveBrain(dataDir);
        const brainIsLive = Boolean(
          brain?.lock?.pid && isProcessAlive(brain.lock.pid)
        );
        const plan = buildUninstallPlan({ dataDir, brainIsLive });

        if (!options.yes) {
          process.stdout.write(
            `This removes ${plan.remove.join(" and ")}.\nYour data dir is KEPT: ${dataDir}\n`
          );
          if (plan.stopBrainFirst) {
            process.stdout.write(
              "A local brain is running and will be stopped first.\n"
            );
          }
          if (!(await askConfirmation())) {
            process.stdout.write("Nothing was removed.\n");
            return;
          }
        }

        if (plan.stopBrainFirst && brain?.lock?.pid) {
          process.stdout.write(`Stopping the local brain (pid ${brain.lock.pid}) …\n`);
          try {
            process.kill(brain.lock.pid, "SIGTERM");
          } catch {
            // Already gone, or not ours to signal. Either way the uninstall
            // proceeds — a brain we cannot stop is not a reason to leave the
            // tool installed.
          }
        }

        let removedAny = false;
        for (const pkg of plan.remove) {
          if ((await npmUninstall(pkg)) === 0) removedAny = true;
        }
        if (!removedAny) {
          failCommand(
            new Error(
              "npm removed nothing. If MUON was installed another way, remove the `muon` and `muon-tui` binaries from your PATH by hand."
            ),
            "Uninstall failed."
          );
          return;
        }
        process.stdout.write(`${describePlan(plan)}\n`);
      } catch (error) {
        failCommand(error, "Uninstall failed.");
      }
    });
}
