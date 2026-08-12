import type { Command } from "commander";
import { failCommand } from "../lib/refusal.js";
import {
  assertHarnessRequirements,
  ensureTaskWorktree,
  resolveRepoRoot,
  worktreeChangedFiles,
} from "@muon/core";
import {
  emptyHarnessConfig,
  withoutBudgetMarker,
  type HarnessCheck,
} from "@muon/protocol";
import { MuonApiClient } from "../lib/api-client.js";
import { resolveApiBase } from "../lib/config.js";
import { observeDispatch } from "../lib/dispatch-observer.js";
import { ensureRunner } from "../lib/ensure-runner.js";
import { printJson } from "../lib/output.js";

const DISPATCH_GRACE_MS = 60_000;
const DEFAULT_DISPATCH_WAIT_MS = 30 * 60_000;

type LoopOptions = {
  lane: string;
  taskId: string;
  brief: string;
  harness?: string;
  check?: string[];
  maxIterations?: string;
  maxWallMs?: string;
  cwd?: string;
  timeout?: string;
  worktree?: boolean;
  json?: boolean;
};

function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, got '${value}'.`);
  }
  return parsed;
}

export function registerLoopCommands(
  program: Command,
  createClient: () => MuonApiClient
) {
  const loop = program
    .command("loop")
    .description("Budgeted feedback cycles: implement → check → repair");

  loop
    .command("run")
    .description(
      "Run a check_repair loop: dispatch, run checks, repair with the failure tail, until green or the budget escalates to the inbox"
    )
    .requiredOption("--lane <laneKey>", "Lane key: claude-code | codex | cursor | opencode (cursor and opencode are managed for a limited set of crew roles; the dispatch route refuses the rest)")
    .requiredOption("--task-id <taskId>", "Task identifier for provenance")
    .requiredOption("--brief <brief>", "Prompt/brief passed to the lane agent")
    .option("--harness <key>", "Harness supplying checks + profile overlay")
    .option(
      "--check <command...>",
      "Extra check command(s) run after each iteration"
    )
    .option("--max-iterations <n>", "Iteration budget (default 3)")
    .option("--max-wall-ms <ms>", "Wall-clock budget in milliseconds")
    .option("--cwd <dir>", "Working directory for the lane agent")
    .option("--timeout <ms>", "Per-iteration lane timeout in milliseconds")
    .option(
      "--worktree",
      "Run inside an isolated git worktree in MUON's external worktree store"
    )
    .option("--json", "Print outcome as JSON (events still stream to stderr)")
    .action(async (options: LoopOptions) => {
      try {
        const client = createClient();

        const lanes = await client.listLanes();
        const lane = lanes.find((entry) => entry.key === options.lane);
        if (!lane) {
          throw new Error(`Lane key '${options.lane}' not found in backend ledger.`);
        }

        const harness = options.harness
          ? (await client.getHarness(options.harness)).config
          : emptyHarnessConfig;
        assertHarnessRequirements(harness, {
          laneKey: options.lane,
          interactiveAvailable: false,
          worktree: Boolean(options.worktree),
        });

        const extraChecks: HarnessCheck[] = (options.check ?? []).map(
          (command, index) => ({ name: `check-${index + 1}`, command })
        );

        // Workspace: when no --cwd is given, run in the task's target repo.
        let runCwd = options.cwd;
        if (!runCwd) {
          runCwd = await client
            .getTaskDetail(options.taskId)
            .then((detail) => detail.workspacePath ?? undefined)
            .catch(() => undefined);
        }
        let worktreePath: string | undefined;
        let worktreeRepoRoot: string | undefined;
        if (options.worktree) {
          const repoRoot = await resolveRepoRoot(runCwd ?? process.cwd());
          worktreeRepoRoot = repoRoot;
          const worktree = await ensureTaskWorktree({
            repoRoot,
            taskId: options.taskId,
          });
          worktreePath = worktree.path;
          runCwd = worktree.path;
          process.stderr.write(
            `${worktree.created ? "created" : "reusing"} isolated worktree at ${worktree.path}\n`
          );
        }

        // The loop is ledger-native: assignment + every iteration recorded.
        await client.assignTask({
          taskId: options.taskId,
          laneId: lane.id,
          summary: `muon loop: ${options.brief.slice(0, 100)}`,
        });

        const rawFlags = program.opts<{ apiBase?: string; apiToken?: string }>();
        const apiBase = resolveApiBase(rawFlags.apiBase);
        const runner = await ensureRunner(client, {
          apiBase,
          apiBaseFlag: rawFlags.apiBase,
          apiTokenFlag: rawFlags.apiToken,
        });
        if (!runner.live) {
          throw new Error(
            runner.note ??
              "No persistent runner is online. Start one with `muon runner`, then retry.",
            // Keep the lease 401/403 classification for the exit-2 contract.
            { cause: runner.failure }
);
        }
        const baseline = await client
          .listStreamChunks({
            taskId: options.taskId,
            latest: true,
            limit: 1,
          })
          .catch(() => []);
        const maxIterations =
          parsePositiveInt(options.maxIterations, "--max-iterations") ??
          harness.budget.maxIterations;
        const maxWallMs =
          parsePositiveInt(options.maxWallMs, "--max-wall-ms") ??
          harness.budget.maxWallMs;
        const iterationTimeoutMs = parsePositiveInt(
          options.timeout,
          "--timeout"
        );
        const job = await client.enqueueDispatch({
          kind: "loop",
          vendor: options.lane,
          taskId: options.taskId,
          brief: options.brief,
          ...(options.harness ? { harnessKey: options.harness } : {}),
          ...(extraChecks.length > 0 ? { checks: extraChecks } : {}),
          maxIterations,
          ...(maxWallMs ? { maxWallMs } : {}),
          ...(iterationTimeoutMs ? { iterationTimeoutMs } : {}),
          ...(worktreeRepoRoot || runCwd
            ? { workspacePath: worktreeRepoRoot ?? runCwd }
            : {}),
        });
        process.stderr.write(`dispatch ${job.id} queued for loop\n`);
        const terminal = await observeDispatch({
          client,
          jobId: job.id,
          taskId: options.taskId,
          timeoutMs:
            (maxWallMs ?? DEFAULT_DISPATCH_WAIT_MS) + DISPATCH_GRACE_MS,
          afterSeq: baseline.at(-1)?.seq ?? 0,
          onChunk: (chunk) =>
            process.stderr.write(
              `[${chunk.timestamp}] ${chunk.kind} ${chunk.content}\n`
            ),
        });

        // Staleness + module familiarity: report what the loop touched.
        if (worktreePath) {
          const changedFiles = await worktreeChangedFiles(worktreePath).catch(
            () => [] as string[]
          );
          if (changedFiles.length > 0) {
            await client
              .recordEvent({
                laneId: lane.id,
                taskId: options.taskId,
                kind: "task.progress",
                message: `touched ${changedFiles.length} file(s)`,
                metadata: { modules: changedFiles },
              })
              .catch(() => undefined);
          }
        }

        if (options.json) {
          // --json is the machine view: the classifier token stays verbatim.
          printJson(terminal);
        } else if (terminal.status === "done") {
          process.stdout.write(
            `${withoutBudgetMarker(terminal.result ?? "").trim() || "loop passed"}\n`
          );
        } else {
          // A loop killed by its own wall budget prints the honest sentence, not
          // the machine tag in front of it (shared stripper, one definition).
          process.stdout.write(
            `${
              withoutBudgetMarker(terminal.result ?? "").trim() ||
              `loop ${terminal.status}`
            }\n`
          );
          // 3, not 2: a loop that escalated (budget exhausted, checks never
          // green) is a governed outcome, but exit 2 is reserved machine-wide
          // for "the brain refused your authority" — a script gating on rc==2
          // must never mistake an escalation for a refusal.
          process.exitCode = terminal.status === "interrupted" ? 130 : 3;
        }
      } catch (error) {
        failCommand(error, "Loop failed.");
      }
    });
}
