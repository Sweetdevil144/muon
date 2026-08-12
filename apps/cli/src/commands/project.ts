import type { Command } from "commander";
import {
  executeProjectRun,
  resolveEffectiveProjectSetup,
  resolveRepoRoot,
  taskWorktreeCandidates,
} from "@muon/core";
import { resolveCheckArgv } from "@muon/protocol";
import { existsSync } from "node:fs";
import { failCommand } from "../lib/refusal.js";
import { printJson } from "../lib/output.js";

/**
 * T5 — the declarative project lifecycle from the terminal.
 *
 * `status` shows the resolved setup/teardown/run plan and whether its
 * confirmation-bound commands are cleared to run; `run` executes the run
 * lifecycle in the foreground (dev-server shaped: inherited stdio, no
 * timeout, MUON credentials stripped). Confirmation is decided in the
 * approvals inbox — the gate a dispatch files — never here; this surface
 * only OBEYS the recorded confirmation.
 */
export function registerProjectCommands(program: Command) {
  const project = program
    .command("project")
    .description(
      "Declarative per-project lifecycle (muon.project.json): inspect and run it"
    );

  project
    .command("status")
    .description("Show the resolved setup/teardown/run plan for this repository")
    .option("--workspace <dir>", "Repository (default: cwd)")
    .option("--json", "Print as JSON")
    .action(async (options: { workspace?: string; json?: boolean }) => {
      try {
        const repoRoot = await resolveRepoRoot(options.workspace ?? process.cwd());
        const plan = await resolveEffectiveProjectSetup({ repoRoot });
        if (options.json) {
          printJson({ plan });
          return;
        }
        const render = (label: string, steps: unknown[]) =>
          `${label}: ${steps.length === 0 ? "—" : steps.map((step) => resolveCheckArgv(step as never).join(" ")).join("  ·  ")}`;
        process.stdout.write(
          [
            `repository: ${repoRoot}`,
            render("setup", plan.setup),
            render("teardown", plan.teardown),
            render("run", plan.run),
            plan.confirmationBound.setup.length +
              plan.confirmationBound.teardown.length +
              plan.confirmationBound.run.length >
            0
              ? "confirmation: required for the non-user commands above — a dispatch files the gate in the approvals inbox; approving records it."
              : "confirmation: not required (no repo-declared commands, or user override only).",
            "",
          ].join("\n")
        );
      } catch (error) {
        failCommand(error, "Failed to resolve the project lifecycle.");
      }
    });

  project
    .command("run")
    .description(
      "Run the project's declared run lifecycle in the foreground (Ctrl-C stops it)"
    )
    .option("--workspace <dir>", "Repository (default: cwd)")
    .option(
      "--task <taskId>",
      "Run inside this task's worktree instead of the repository root"
    )
    .action(async (options: { workspace?: string; task?: string }) => {
      try {
        const repoRoot = await resolveRepoRoot(options.workspace ?? process.cwd());
        let cwd = repoRoot;
        if (options.task) {
          const candidate = taskWorktreeCandidates(repoRoot, options.task).find(
            (path) => existsSync(path)
          );
          if (!candidate) {
            failCommand(
              new Error(
                `no worktree exists for task ${options.task} under this repository`
              ),
              "Failed to run the project lifecycle."
            );
            return;
          }
          cwd = candidate;
        }
        const outcome = await executeProjectRun({ repoRoot, cwd });
        if (outcome.refused) {
          failCommand(new Error(outcome.refused), "Project run refused.");
          return;
        }
        process.exitCode = outcome.exitCode === 0 ? 0 : 1;
      } catch (error) {
        failCommand(error, "Failed to run the project lifecycle.");
      }
    });
}
