import { spawn } from "node:child_process";
import { failCommand } from "../lib/refusal.js";
import type { Command } from "commander";
import {
  evaluatorVendorIds,
  parseCheckCommand,
  vendorLabel,
  type VendorId,
} from "@muon/protocol";
import { MuonApiClient } from "../lib/api-client.js";
import { resolveApiBase } from "../lib/config.js";
import { ensureRunner } from "../lib/ensure-runner.js";
import { printError, printJson } from "../lib/output.js";

export type ShipCheckResult = {
  command: string;
  exitCode: number;
  durationMs: number;
  tail: string;
};

const DEFAULT_CHECKS = ["npm test"];
const TAIL_CHARS = 1500;
const REVIEW_TERMINAL_WAIT_MS = 135_000;
const REVIEW_POLL_MS = 500;
const TERMINAL_DISPATCH_STATUSES = new Set([
  "done",
  "failed",
  "interrupted",
]);

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function requestSecondOpinionViaDispatch(args: {
  client: MuonApiClient;
  reviewerLaneKey: string;
  taskId: string;
  brief: string;
  workspacePath?: string;
  apiBase: string;
  /** RAW global flags for ensureRunner's credential↔base pairing. */
  apiBaseFlag?: string;
  apiTokenFlag?: string;
  ensureRunnerFn?: typeof ensureRunner;
}): Promise<string> {
  // WAVE D: `authority.evaluator` — the ADR-0018 critique authority, which is
  // exactly what a second opinion is. Same admitted set as the hardcoded
  // `=== "cursor"` refusal this replaces, minus the stale prose; and a lane that
  // has not earned critique is now refused rather than admitted by default.
  if (!evaluatorVendorIds().includes(args.reviewerLaneKey as VendorId)) {
    throw new Error(
      `${vendorLabel(args.reviewerLaneKey)} cannot give a second opinion in MUON; choose one of: ${evaluatorVendorIds()
        .map((vendor) => vendorLabel(vendor))
        .join(", ")}.`
    );
  }
  const runner = await (args.ensureRunnerFn ?? ensureRunner)(args.client, {
    apiBase: args.apiBase,
    ...(args.apiBaseFlag !== undefined ? { apiBaseFlag: args.apiBaseFlag } : {}),
    ...(args.apiTokenFlag !== undefined
      ? { apiTokenFlag: args.apiTokenFlag }
      : {}),
  });
  if (!runner.live) {
    throw new Error(
      runner.note ??
        "No live lease-fenced runner is available for the second opinion.",
      // Keep the lease 401/403 classification for the exit-2 contract.
      { cause: runner.failure }
    );
  }

  const job = await args.client.enqueueDispatch({
    kind: "oneshot",
    vendor: args.reviewerLaneKey,
    taskId: args.taskId,
    brief: args.brief,
    harnessKey: "review",
    ...(args.workspacePath ? { workspacePath: args.workspacePath } : {}),
  });

  const deadline = Date.now() + REVIEW_TERMINAL_WAIT_MS;
  for (;;) {
    const current = await args.client.getDispatchJob(job.id);
    if (TERMINAL_DISPATCH_STATUSES.has(current.status)) {
      if (
        current.status !== "done" ||
        (current.exitCode !== null &&
          current.exitCode !== undefined &&
          current.exitCode !== 0)
      ) {
        throw new Error(
          `Second-opinion dispatch ${current.status}: ${
            current.result?.trim() || "no result was recorded"
          }`
        );
      }
      return (current.result ?? "").slice(-1000).trim();
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Second-opinion dispatch '${job.id}' did not reach a terminal state within ${REVIEW_TERMINAL_WAIT_MS}ms.`
      );
    }
    await delay(REVIEW_POLL_MS);
  }
}

// P3-B (audit M3): ship checks spawn with NO host shell. The command is
// tokenized into a bare argv (`parseCheckCommand`, which refuses shell
// operators) and run directly, a metacharacter in the string is never
// evaluated by /bin/sh, and a command that needs a shell is refused loudly.
/** Default ship-check wall-clock bound. A watch-mode / stdin-waiting / deadlocked
 * check must never block the ship path forever (Wave 1 hang-risk). */
const DEFAULT_CHECK_TIMEOUT_MS = 15 * 60_000;

// Exported for test: a watch-mode/deadlocked check must resolve (fail) within
// the bound, never hang the ship path (Wave 1 "no silent hang" charter).
export function runCheck(
  command: string,
  cwd: string,
  timeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS
): Promise<ShipCheckResult> {
  const startedAt = Date.now();
  let argv: string[];
  try {
    argv = parseCheckCommand(command);
  } catch (error) {
    return Promise.resolve({
      command,
      exitCode: 1,
      durationMs: Date.now() - startedAt,
      tail: `refused: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const [file, ...args] = argv;
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd });
    let output = "";
    let settled = false;
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const finish = (code: number, note?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const body = output.length > TAIL_CHARS ? `…${output.slice(-TAIL_CHARS)}` : output;
      resolve({
        command,
        exitCode: code,
        durationMs: Date.now() - startedAt,
        tail: note ? `${note}\n${body}` : body,
      });
    };
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            try {
              child.kill("SIGTERM");
            } catch {
              // already gone
            }
            const kill = setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {
                // already gone
              }
            }, 2000);
            kill.unref?.();
            finish(1, `check timed out after ${Math.round(timeoutMs / 1000)}s (killed)`);
          }, timeoutMs)
        : null;
    timer?.unref?.();
    child.on("close", (code) => finish(code ?? 1));
    child.on("error", (error) => {
      output += String(error);
      finish(1);
    });
  });
}

/**
 * Ship review (ROADMAP Phase 6): run the configured checks, record the
 * outcome as a ledger event, and file a merge approval. The backend refuses
 * to move a task to "done" until that approval is granted by a human.
 */
export function registerShipCommand(
  program: Command,
  createClient: () => MuonApiClient
) {
  program
    .command("ship")
    .description("Run ship checks and file a merge approval for the task")
    .requiredOption("--task-id <taskId>", "Task identifier")
    .requiredOption("--lane <laneKey>", "Lane that produced the work")
    .option(
      "--check <command...>",
      "Check command(s) to run (default: 'npm test')"
    )
    .option(
      "--second-opinion <laneKey>",
      "Ask another lane to review the work before filing the merge approval"
    )
    .option("--cwd <dir>", "Working directory for checks")
    .option("--json", "Print as JSON")
    .action(
      async (options: {
        taskId: string;
        lane: string;
        check?: string[];
        secondOpinion?: string;
        cwd?: string;
        json?: boolean;
      }) => {
        try {
          const client = createClient();
          const lanes = await client.listLanes();
          const lane = lanes.find((entry) => entry.key === options.lane);
          if (!lane) {
            throw new Error(`Lane key '${options.lane}' not found in backend ledger.`);
          }

          const checks = options.check ?? DEFAULT_CHECKS;
          const cwd = options.cwd ?? process.cwd();
          const results: ShipCheckResult[] = [];

          for (const command of checks) {
            process.stderr.write(`running check: ${command}\n`);
            const result = await runCheck(command, cwd);
            results.push(result);
            process.stderr.write(
              `check ${result.exitCode === 0 ? "passed" : "FAILED"} (${result.durationMs}ms)\n`
            );
          }

          const allPassed = results.every((result) => result.exitCode === 0);
          const summary = results
            .map(
              (result) =>
                `${result.exitCode === 0 ? "PASS" : "FAIL"} ${result.command} (${result.durationMs}ms)`
            )
            .join("; ");

          await client.recordEvent({
            laneId: lane.id,
            taskId: options.taskId,
            kind: allPassed ? "task.completed" : "task.blocked",
            message: `ship review: ${summary}`,
            metadata: {
              shipReview: true,
              checks: results.map((result) => ({
                command: result.command,
                exitCode: result.exitCode,
                durationMs: result.durationMs,
              })),
            },
          });

          if (!allPassed) {
            printError(
              "ship checks failed, fix the work before requesting merge approval"
            );
            if (options.json) {
              printJson({ passed: false, results });
            }
            process.exitCode = 1;
            return;
          }

          // Second opinion (Phase 6): another lane reviews the work before
          // the merge approval is filed. Verdict is recorded with provenance;
          // the human still decides.
          let secondOpinion: string | undefined;
          if (options.secondOpinion) {
            if (options.secondOpinion === options.lane) {
              throw new Error("Second opinion must come from a different lane.");
            }
            const reviewer = lanes.find(
              (entry) => entry.key === options.secondOpinion
            );
            if (!reviewer) {
              throw new Error(
                `Reviewer lane key '${options.secondOpinion}' not found in backend ledger.`
              );
            }

            process.stderr.write(
              `asking ${reviewer.name} for a second opinion...\n`
            );
            secondOpinion = await requestSecondOpinionViaDispatch({
              client,
              reviewerLaneKey: options.secondOpinion,
              taskId: options.taskId,
              brief:
                `You are reviewing another agent's completed work before merge. ` +
                `Task: ${options.taskId}. Ship checks: ${summary}. ` +
                `Reply with VERDICT: APPROVE or VERDICT: CONCERNS followed by one short paragraph.`,
              workspacePath: cwd,
              apiBase: resolveApiBase(
                program.opts<{ apiBase?: string }>().apiBase
              ),
              apiBaseFlag: program.opts<{ apiBase?: string }>().apiBase,
              apiTokenFlag: program.opts<{ apiToken?: string }>().apiToken,
            });

            await client.recordEvent({
              laneId: reviewer.id,
              taskId: options.taskId,
              kind: "task.progress",
              message: `second opinion from ${reviewer.key}: ${secondOpinion.slice(0, 400)}`,
              metadata: { secondOpinion: true, reviewer: reviewer.key },
            });
            process.stderr.write(`second opinion recorded\n`);
          }

          const approval = await client.requestApproval({
            taskId: options.taskId,
            requestedBy: options.lane,
            kind: "merge",
            reason: [
              `ship review passed: ${summary}`,
              ...(secondOpinion
                ? [`second opinion (${options.secondOpinion}): ${secondOpinion.slice(0, 120)}`]
                : []),
            ]
              .join(" | ")
              .slice(0, 300),
          });

          if (options.json) {
            printJson({ passed: true, results, approval });
            return;
          }

          process.stdout.write(
            `ship checks passed, merge approval filed (id: ${approval.id})\n` +
              `approve with: muon approve resolve --approval-id ${approval.id} --status approved\n` +
              `then: muon task status --task-id ${options.taskId} --status done\n`
          );
        } catch (error) {
          failCommand(error, "Ship review failed.");
        }
      }
    );
}
