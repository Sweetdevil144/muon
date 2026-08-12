import type { Command } from "commander";
import { failCommand } from "../lib/refusal.js";
import { isBudgetExhausted, withoutBudgetMarker } from "@muon/protocol";
import { MuonApiClient } from "../lib/api-client.js";
import { resolveApiBase } from "../lib/config.js";
import { observeDispatch } from "../lib/dispatch-observer.js";
import { ensureRunner } from "../lib/ensure-runner.js";
import { printJson } from "../lib/output.js";
import { takeOverArgv } from "@muon/core";

const SESSION_OBSERVE_TIMEOUT_MS = 24 * 60 * 60_000;

export function registerSessionCommands(
  program: Command,
  createClient: () => MuonApiClient
) {
  const session = program
    .command("session")
    .description("Interactive lane sessions (official vendor surfaces)");

  session
    .command("start")
    .description(
      "Start an interactive session; un-preapproved tool calls go to the MUON approvals inbox"
    )
    .requiredOption("--lane <laneKey>", "Lane key: claude-code | codex")
    .requiredOption("--task-id <taskId>", "Task identifier")
    .requiredOption("--brief <brief>", "Initial brief for the session")
    .option("--cwd <dir>", "Working directory")
    .option("--resume <vendorSessionId>", "Resume a vendor session")
    .option("--approval-timeout <ms>", "Approval wait before failing closed")
    .option("--json", "Print result as JSON")
    .action(
      async (options: {
        lane: string;
        taskId: string;
        brief: string;
        cwd?: string;
        resume?: string;
        approvalTimeout?: string;
        json?: boolean;
      }) => {
        try {
          const client = createClient();
          const lanes = await client.listLanes();
          const lane = lanes.find((entry) => entry.key === options.lane);
          if (!lane) {
            throw new Error(`Lane key '${options.lane}' not found in backend ledger.`);
          }

          let workspacePath = options.cwd;
          if (!workspacePath) {
            workspacePath = await client
              .getTaskDetail(options.taskId)
              .then((detail) => detail.workspacePath ?? undefined)
              .catch(() => undefined);
          }
          let approvalTimeoutMs: number | undefined;
          if (options.approvalTimeout !== undefined) {
            approvalTimeoutMs = Number(options.approvalTimeout);
            if (
              !Number.isInteger(approvalTimeoutMs) ||
              approvalTimeoutMs <= 0
            ) {
              throw new Error(
                `--approval-timeout must be a positive integer, got '${options.approvalTimeout}'.`
              );
            }
          }

          await client.assignTask({
            taskId: options.taskId,
            laneId: lane.id,
            summary: `muon session: ${options.brief.slice(0, 100)}`,
          });
          const rawFlags = program.opts<{
            apiBase?: string;
            apiToken?: string;
          }>();
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
          const job = await client.enqueueDispatch({
            kind: "session",
            vendor: options.lane,
            taskId: options.taskId,
            brief: options.brief,
            ...(options.resume
              ? { resumeVendorSessionId: options.resume }
              : {}),
            ...(approvalTimeoutMs ? { approvalTimeoutMs } : {}),
            ...(workspacePath ? { workspacePath } : {}),
          });
          process.stderr.write(
            `dispatch ${job.id} queued for session on ${options.lane} (Ctrl+C detaches; runner continues)\n`
          );
          const terminal = await observeDispatch({
            client,
            jobId: job.id,
            taskId: options.taskId,
            timeoutMs: SESSION_OBSERVE_TIMEOUT_MS,
            afterSeq: baseline.at(-1)?.seq ?? 0,
            onChunk: (chunk) =>
              process.stderr.write(
                `[${chunk.timestamp}] ${chunk.kind} ${chunk.content}\n`
              ),
          });
          process.stderr.write(
            `session dispatch ended (${terminal.status}, exit ${terminal.exitCode ?? "n/a"})\n`
          );

          if (options.json) {
            // The MACHINE view keeps the classifier token verbatim: --json is
            // what a script parses.
            printJson(terminal);
          } else {
            // The human view does not. Same shared stripper as the desktop pane
            // and the crew rail.
            process.stdout.write(withoutBudgetMarker(terminal.result ?? ""));
          }
          if (terminal.status !== "done") {
            // MUON's exit codes are its OWN contract: 0 ok, 1 failure, 2 the
            // brain refused your authority, 3 a governed budget/loop ended
            // the work, 130 human interrupt. Passing the vendor's code
            // through let a lane exiting 2 impersonate a governance refusal;
            // and a wall-budget kill SIGINTs the vendor (recorded 130), which
            // would tell the shell "a human pressed Ctrl-C" — MUON ended it,
            // so it exits as what it is: 3, never 2 (budget exhaustion is not
            // an authz refusal) and never the vendor's own code.
            process.exitCode =
              terminal.status === "interrupted"
                ? 130
                : isBudgetExhausted(terminal.result)
                  ? 3
                  : 1;
          }
        } catch (error) {
          failCommand(error, "Session failed.");
        }
      }
    );

  session
    .command("list")
    .description("List sessions from the ledger")
    .option("--task-id <taskId>", "Filter by task")
    .option("--status <status>", "Filter by status")
    .option("--json", "Print as JSON")
    .action(
      async (options: { taskId?: string; status?: string; json?: boolean }) => {
        try {
          const sessions = await createClient().listSessions({
            taskId: options.taskId,
            status: options.status,
          });
          if (options.json) {
            printJson({ sessions });
            return;
          }
          if (sessions.length === 0) {
            process.stdout.write("no sessions\n");
            return;
          }
          for (const entry of sessions) {
            // ADR-0030: the ONE vendor-lore map in @muon/core — this line
            // used to hardcode `claude --resume` for every vendor.
            const argv = entry.vendorSessionId
              ? takeOverArgv(entry.lane?.key ?? entry.laneId, entry.vendorSessionId)
              : null;
            const takeOver = argv ? ` | take over: ${argv}` : "";
            process.stdout.write(
              `- ${entry.id} | ${entry.lane?.key ?? entry.laneId} | task=${entry.taskId} | ${entry.status}${takeOver}\n`
            );
          }
        } catch (error) {
          failCommand(error, "Failed to list sessions.");
        }
      }
    );

  // ── ADR-0030: the governed-to-native round trip ────────────────────────────
  session
    .command("take-over <sessionId>")
    .description(
      "Hand a live session to yourself: automation is suspended for it until you return it"
    )
    .action(async (sessionId: string) => {
      try {
        const result = await createClient().takeOverSession(sessionId);
        const s = result.session;
        const argv = s.vendorSessionId
          ? takeOverArgv(s.lane?.key ?? s.laneId, s.vendorSessionId)
          : null;
        process.stdout.write(
          `${result.alreadyOwned ? "already yours" : "taken over"}: session ${s.id} (owner=${s.owner})\n`
        );
        process.stdout.write(
          argv
            ? `resume it natively:\n  ${argv}\n`
            : "no native resume command exists for this lane; the governed transcript remains the record.\n"
        );
        process.stdout.write(
          "when done: muon session return " + s.id + "\n"
        );
      } catch (error) {
        failCommand(error, "Failed to take the session over.");
      }
    });

  session
    .command("return <sessionId>")
    .description(
      "Return a taken-over session: captures a dirty-file count, re-checks vendor readiness, and lets automation act again"
    )
    .action(async (sessionId: string) => {
      try {
        const result = await createClient().returnSession(sessionId);
        const s = result.session;
        process.stdout.write(
          `${result.alreadyOwned ? "was not taken over" : "returned"}: session ${s.id} (owner=${s.owner})\n`
        );
        if (result.snapshot) {
          process.stdout.write(
            `native work snapshot: ${result.snapshot.dirtyFiles ?? "unknown"} dirty file(s) in the workspace` +
              (result.snapshot.readinessDegraded
                ? "; readiness re-check degraded (recorded in the audit row)\n"
                : "; vendor readiness re-checked\n")
          );
        }
      } catch (error) {
        failCommand(error, "Failed to return the session.");
      }
    });

}

