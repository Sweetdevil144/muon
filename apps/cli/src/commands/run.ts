import type { Command } from "commander";
import { isAuthorizationFailure } from "@muon/client";
import { failCommand } from "../lib/refusal.js";
import {
  assertHarnessRequirements,
  buildHandoffPacket,
  checkStatusWord,
  collectWorktreeEvidence,
  detectWorktreeCollisions,
  ensureTaskWorktree,
  isCheckGreen,
  toHandoffCheck,
  normalizeVendorAlias,
  renderHandoffPacketMarkdown,
  resolveRepoRoot,
  resolveVendorAction,
  VENDOR_CAPABILITY_DESCRIPTORS,
  runChecksWithCoverage,
  worktreeChangedFiles,
  worktreeDiffStat,
  type LaneEvent,
  type LoopCheckResult,
  type VendorKey,
  type WorktreeCollision,
  type WorktreeEvidence,
} from "@muon/core";
import type { HarnessConfig } from "@muon/protocol";
import {
  ONBOARDING_VENDORS,
  buildOnboardingState,
  classifyVendorFailure,
} from "@muon/client";
import { MuonApiClient } from "../lib/api-client.js";
import { waitForApproval } from "../lib/approval-gate.js";
import { resolveApiBase } from "../lib/config.js";
import { observeDispatch } from "../lib/dispatch-observer.js";
import { ensureRunner } from "../lib/ensure-runner.js";
import { createEventRecorder } from "../lib/event-recorder.js";
import { printError, printJson } from "../lib/output.js";
import type { Lane } from "../types.js";

function parseMsOption(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative number of milliseconds, got '${value}'.`);
  }
  return parsed;
}

type RunOptions = {
  lane: string;
  taskId: string;
  brief: string;
  cwd?: string;
  timeout?: string;
  record?: boolean;
  handoffTo?: string;
  requireApproval?: boolean;
  approvalTimeout?: string;
  worktree?: boolean;
  harness?: string;
  json?: boolean;
  // ADR-0013 #52 v2, vendor-native action surface.
  action?: string;
  vendor?: string;
  actionArg?: string[];
  egressOptIn?: boolean;
};

/** Commander collector for a repeatable `--action-arg`. */
function collectActionArg(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * ADR-0013 #52 v2, `muon run --action <action> [--vendor <v>] [--action-arg <a>…]
 * [target]`. Posts the dispatch with the vendor-action fields; the backend ROUTE
 * re-resolves + ENFORCES every guard (the tier is authenticated there, so the
 * local resolve below is advisory preview only, it fails fast on an obviously
 * bad action/target and shows what the action resolves to). Kept as an exported
 * helper so it can be unit-tested against a stub client without commander.
 */
export async function dispatchVendorAction(
  client: MuonApiClient,
  input: {
    action: string;
    vendor?: string;
    lane?: string;
    taskId?: string;
    brief?: string;
    actionArgs: string[];
    positionals: string[];
    egressOptIn: boolean;
    json: boolean;
  }
): Promise<void> {
  const rest = [...input.positionals];
  // vendor: explicit --vendor, else --lane, else the first positional token.
  let vendorToken = input.vendor ?? input.lane;
  if (!vendorToken) {
    vendorToken = rest.shift();
  }
  if (!vendorToken) {
    throw new Error(
      "muon run --action needs a vendor: pass --vendor <v> or a positional (e.g. `muon run --action ultrareview claude src/app.ts`)."
    );
  }
  const descriptorVendor = normalizeVendorAlias(vendorToken);
  // Same fact the dispatch route reads: a non-empty action set. `!== "fake"`
  // alone would let opencode through the moment TODO 3.4 gives it an action
  // without anyone updating this guard (and the error still named only three).
  const actionVendors = (
    Object.entries(VENDOR_CAPABILITY_DESCRIPTORS) as Array<
      [VendorKey, (typeof VENDOR_CAPABILITY_DESCRIPTORS)[VendorKey]]
    >
  )
    .filter(
      ([id, descriptor]) => id !== "fake" && descriptor.actions.length > 0
    )
    .map(([id]) => id);
  if (
    !descriptorVendor ||
    descriptorVendor === "fake" ||
    !actionVendors.includes(descriptorVendor)
  ) {
    const expected = actionVendors
      .map((id) => (id === "claude-code" ? "claude" : id))
      .join(" | ");
    throw new Error(
      `Unknown vendor '${vendorToken}'. Expected one of: ${expected}.`
    );
  }
  // Any remaining positional is the action target (e.g. the ultrareview path).
  const target = rest.shift();

  // Advisory local resolve (mirrors the TUI preview). The ROUTE is authoritative:
  // it re-resolves with the AUTH tier and enforces the four guards there.
  const preview = resolveVendorAction(descriptorVendor as VendorKey, input.action, {
    args: input.actionArgs,
    target,
    mode: "one-shot",
    egressOptIn: input.egressOptIn,
  });
  if (!preview.supported) {
    throw new Error(
      preview.reason ?? `Action '${input.action}' is not available for ${vendorToken}.`
    );
  }
  if (preview.argvOverride) {
    process.stderr.write(
      `→ resolves to: ${[preview.argvOverride.command ?? descriptorVendor, ...preview.argvOverride.args].join(" ")}\n`
    );
  } else if (preview.briefPrefix) {
    process.stderr.write(`→ brief prefix: ${preview.briefPrefix}\n`);
  } else if (preview.profilePatch) {
    process.stderr.write(`→ profile patch: ${JSON.stringify(preview.profilePatch)}\n`);
  }
  for (const warning of preview.warnings) {
    process.stderr.write(`  ⚠ ${warning}\n`);
  }

  const taskId = input.taskId ?? `action-${Date.now()}`;
  const brief =
    input.brief ??
    `MUON vendor action: ${input.action}${target ? ` (${target})` : ""}`;

  const job = await client.enqueueDispatch({
    kind: "oneshot",
    vendor: descriptorVendor,
    taskId,
    brief,
    action: input.action,
    actionVendor: descriptorVendor,
    actionArgs: input.actionArgs.length > 0 ? input.actionArgs : undefined,
    target,
    egressOptIn: input.egressOptIn || undefined,
  });

  process.stderr.write(
    `dispatched vendor action '${input.action}' on ${descriptorVendor} → job ${job.id}\n`
  );
  if (input.json) {
    printJson({ jobId: job.id, action: input.action, vendor: descriptorVendor, target });
  }
}

export function registerRunCommand(program: Command, createClient: () => MuonApiClient) {
  program
    .command("run")
    .description("Run a task brief on a lane's local agent CLI (non-interactive)")
    // --lane/--task-id/--brief are required for a plain run, but OPTIONAL in
    // `--action` mode (validated in the handler), so back-compat is preserved
    // without forcing a task/brief for a one-keystroke vendor action.
    .option("--lane <laneKey>", "Lane key: claude-code | codex | cursor | opencode (cursor and opencode are managed for a limited set of crew roles; the dispatch route refuses the rest)")
    .option("--task-id <taskId>", "Task identifier for provenance")
    .option("--brief <brief>", "Prompt/brief passed to the lane agent")
    .option(
      "--action <action>",
      "Vendor-native action, e.g. ultrareview, plan, model, full-auto"
    )
    .option(
      "--vendor <vendor>",
      "Vendor descriptor for --action (claude | codex | cursor); defaults to --lane or the first positional"
    )
    .option(
      "--action-arg <arg>",
      "Argument for --action (repeatable, e.g. a model name or effort level)",
      collectActionArg,
      [] as string[]
    )
    .option(
      "--egress-opt-in",
      "Opt into egress for a cloud/remote action (operator only; withheld by default)"
    )
    .argument(
      "[args...]",
      "In --action mode: an optional [vendor] and/or action target (e.g. `claude src/app.ts`)"
    )
    .option("--cwd <dir>", "Working directory for the lane agent")
    .option("--timeout <ms>", "Timeout in milliseconds")
    .option(
      "--record",
      "Record this run as an assignment plus per-event log in the backend ledger"
    )
    .option(
      "--handoff-to <laneKey>",
      "After the run, create a handoff packet targeting this lane key"
    )
    .option(
      "--require-approval",
      "Create an approval request and refuse to run until it is approved"
    )
    .option(
      "--worktree",
      "Run inside an isolated git worktree in MUON's external worktree store"
    )
    .option(
      "--approval-timeout <ms>",
      "How long to wait for approval before failing closed (default 300000)"
    )
    .option(
      "--harness <key>",
      "Apply a named harness: profile overlay, pre-authorized tools, checks"
    )
    .option("--json", "Print result as JSON (events still stream to stderr)")
    .action(async (positionals: string[], options: RunOptions) => {
      try {
        const client = createClient();

        // ADR-0013 #52 v2, vendor-native action surface. Posts the dispatch with
        // the action fields; the ROUTE re-resolves + ENFORCES the guards. Keeps
        // the plain `muon run` (below) byte-for-byte unchanged when --action is
        // absent (back-compat).
        if (options.action) {
          // Wave 1: fail FAST if no runner is live — otherwise the action is
          // enqueued and the command exits 0 while the job sits queued forever
          // (false success). Mirrors the plain `run` path below.
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
            // Review (CLI-F2): surface the RUNNER-infra reason DIRECTLY and
            // return, never letting it fall to the outer catch's vendor
            // classifier — a "start a runner" problem must not be mislabeled
            // "Claude Code isn't connected". Review (CLI-F4): a runner that is
            // still cold-booting (started, not yet live) should say "re-run
            // shortly", not "start one".
            printError(
              runner.note ??
                (runner.started
                  ? "A runner is still starting (cold Seatbelt boot); re-run in a few seconds."
                  : "No persistent runner is online. Start one with `muon runner`, then retry.")
            );
            process.exitCode = 1;
            return;
          }
          await dispatchVendorAction(client, {
            action: options.action,
            vendor: options.vendor,
            lane: options.lane,
            taskId: options.taskId,
            brief: options.brief,
            actionArgs: options.actionArg ?? [],
            positionals: positionals ?? [],
            egressOptIn: Boolean(options.egressOptIn),
            json: Boolean(options.json),
          });
          return;
        }

        // Plain run still requires --lane / --task-id / --brief.
        if (!options.lane || !options.taskId || !options.brief) {
          throw new Error(
            "muon run requires --lane, --task-id, and --brief (or use --action <action> for a vendor action)."
          );
        }

        const timeoutMs = parseMsOption(options.timeout, "--timeout");
        const approvalTimeoutMs = parseMsOption(
          options.approvalTimeout,
          "--approval-timeout"
        );

        let lanesCache: Lane[] | undefined;
        const requireLane = async (key: string): Promise<Lane> => {
          lanesCache ??= await client.listLanes();
          const lane = lanesCache.find((entry) => entry.key === key);
          if (!lane) {
            throw new Error(`Lane key '${key}' not found in backend ledger.`);
          }
          return lane;
        };

        // Resolve every lane reference before spawning the agent so typos
        // fail fast instead of after an expensive run.
        let handoffTarget: { fromLane: Lane; toLane: Lane } | undefined;
        if (options.handoffTo) {
          if (options.handoffTo === options.lane) {
            throw new Error("A handoff must target a different lane.");
          }
          handoffTarget = {
            fromLane: await requireLane(options.lane),
            toLane: await requireLane(options.handoffTo),
          };
        }

        // Resolve the record lane before gating so a bad lane key fails fast,
        // but create the assignment only after approval is granted, a
        // rejected run must not leave an "assigned" row in the ledger.
        const recordLane = options.record
          ? await requireLane(options.lane)
          : undefined;

        const runLane = recordLane ?? (await requireLane(options.lane));

        // Harness requirements are validated here; the runner compiles the
        // stored lane profile, memory slice, and governed MCP injection.
        let harness: HarnessConfig | undefined;
        if (options.harness) {
          harness = (await client.getHarness(options.harness)).config;
          assertHarnessRequirements(harness, {
            laneKey: options.lane,
            interactiveAvailable: false,
            worktree: Boolean(options.worktree),
          });
        }

        if (options.requireApproval) {
          const approval = await client.requestApproval({
            taskId: options.taskId,
            requestedBy: options.lane,
            kind: "command",
            reason: `muon run on lane '${options.lane}': ${options.brief.slice(0, 160)}`,
            evidence: {
              action: "Run lane task",
              scope: `Task ${options.taskId} · lane ${options.lane}`,
              riskLevel: "medium",
              impactIfApproved:
                "Starts one lease-fenced vendor dispatch in the selected workspace; later governed actions keep their own gates.",
              details: {
                lane: options.lane,
                taskId: options.taskId,
                brief: options.brief.slice(0, 500),
              },
            },
          });
          process.stderr.write(
            `approval required before running (id: ${approval.id})\n` +
              `resolve with: muon approve resolve --approval-id ${approval.id} --status approved\n`
          );

          await waitForApproval(client, approval.id, {
            timeoutMs: approvalTimeoutMs,
            onPoll: () => {
              process.stderr.write("approval still pending...\n");
            },
          });
          process.stderr.write(`approval ${approval.id} granted, running\n`);
        }

        if (recordLane) {
          await client.assignTask({
            taskId: options.taskId,
            laneId: recordLane.id,
            summary: `muon run: ${options.brief.slice(0, 120)}`,
          });
        }

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
          const repoRoot = await resolveRepoRoot(options.cwd ?? process.cwd());
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

        // Readiness gate (P6): for a KNOWN vendor lane, fail fast with a clear,
        // actionable "connect it first" message + the exact fix command instead
        // of letting the run die deep in the vendor CLI with a cryptic error.
        // Skipped for non-vendor (echo/sh/fake) lanes and when the probe is down
        // (readiness null), degrade, never block on a probe we couldn't run.
        if ((ONBOARDING_VENDORS as readonly string[]).includes(options.lane)) {
          const readiness = await client
            .getVendorReadiness({ refresh: true })
            .catch(() => null);
          const entry = readiness?.find((item) => item.vendor === options.lane);
          if (entry && !(entry.installed && entry.authenticated)) {
            const notice = classifyVendorFailure({
              vendor: options.lane,
              readiness,
            });
            process.stderr.write(`${notice.title}: ${notice.detail}\n`);
            if (notice.fixHint) {
              process.stderr.write(`→ ${notice.fixHint}\n`);
            }
            process.stderr.write(
              "Then re-check with `muon onboard` and run again.\n"
            );
            process.exitCode = 1;
            return;
          }
          // Belt-and-suspenders: if the whole fleet is unconnected, say so plainly.
          if (readiness && !buildOnboardingState(readiness).anyReady) {
            process.stderr.write(
              "No coding agent is connected yet, run `muon onboard` to connect one.\n"
            );
            process.exitCode = 1;
            return;
          }
        }

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
        const afterSeq = baseline.at(-1)?.seq ?? 0;
        const dispatchWorkspace =
          options.worktree && harness?.requires.worktree
            ? worktreeRepoRoot
            : runCwd;
        const job = await client.enqueueDispatch({
          kind: "oneshot",
          vendor: options.lane,
          taskId: options.taskId,
          brief: options.brief,
          ...(options.harness ? { harnessKey: options.harness } : {}),
          ...(timeoutMs && timeoutMs > 0 ? { maxWallMs: timeoutMs } : {}),
          ...(dispatchWorkspace
            ? { workspacePath: dispatchWorkspace }
            : {}),
        });
        process.stderr.write(`dispatch ${job.id} queued\n`);

        const events: LaneEvent[] = [];
        // Milestones are persisted one-to-one; streamed progress chunks are
        // coalesced so a chatty agent does not flood the events API.
        const recorder = createEventRecorder({
          record: (event) => client.recordEvent(event),
        });
        const startedAt = Date.now();
        const terminal = await observeDispatch({
          client,
          jobId: job.id,
          taskId: options.taskId,
          afterSeq,
          timeoutMs:
            (timeoutMs && timeoutMs > 0
              ? timeoutMs
              : harness?.budget.maxWallMs ?? 30 * 60_000) + 60_000,
          onChunk: (chunk) => {
            const event: LaneEvent = {
              id: `dispatch-${job.id}-stream-${chunk.seq}`,
              laneId: chunk.laneId,
              taskId: chunk.taskId,
              kind: chunk.kind === "gate" ? "task.blocked" : "task.progress",
              message: chunk.content,
              timestamp: chunk.timestamp,
              metadata: {
                jobId: job.id,
                streamSeq: chunk.seq,
                streamKind: chunk.kind,
              },
            };
            events.push(event);
            process.stderr.write(
              `[${event.timestamp}] ${event.kind} ${event.message}\n`
            );
            if (options.record) {
              recorder.handle(event);
            }
          },
        });
        const result = {
          exitCode:
            terminal.exitCode ?? (terminal.status === "done" ? 0 : 1),
          durationMs: Date.now() - startedAt,
          output: terminal.result ?? "",
          errorOutput:
            terminal.status === "done" ? "" : terminal.result ?? "",
        };

        if (options.record) {
          const summary = await recorder.flush();
          process.stderr.write(
            `recorded ${summary.recorded} event record(s) to the ledger (${events.length} lane events)\n`
          );
          if (summary.failures > 0) {
            process.stderr.write(
              `warning: ${summary.failures} event record(s) could not be stored\n`
            );
          }
        }

        // Harness checks are the run's success criteria, run once and
        // recorded; a failed check fails the command (use `muon loop run`
        // for the repair cycle). Hoisted so the handoff packet can carry the
        // typed check evidence (P0.3).
        let checkResults: LoopCheckResult[] = [];
        if (harness && harness.checks.length > 0 && result.exitCode === 0) {
          // The SAME entry point the loop runs its checks through: the command
          // is run shell-free, each green result is qualified against the run's
          // changed paths, and a package the declared check cannot see gets its
          // own suite run. A surface that re-implemented `ok ? pass : fail` here
          // would report a green check that observed none of the diff, which is
          // exactly the attestation this path exists to prevent.
          const checkRun = await runChecksWithCoverage({
            checks: harness.checks,
            cwd: runCwd,
          });
          checkResults = checkRun.checks;
          for (const checkResult of checkResults) {
            process.stderr.write(
              `harness check '${checkResult.name}': ${checkStatusWord(
                checkResult
              )}${
                !checkResult.ok && !checkResult.skip
                  ? ` (exit ${checkResult.exitCode})`
                  : ""
              }\n`
            );
          }
          if (checkRun.unqualified) {
            // Said out loud rather than left to look like a qualified pass.
            process.stderr.write(
              `harness checks were NOT qualified against a diff (${checkRun.unqualified}): a green check here does not prove it observed the change\n`
            );
          }
          const allGreen = checkResults.every(isCheckGreen);
          if (options.record) {
            await client
              .recordEvent({
                laneId: runLane.id,
                taskId: options.taskId,
                kind: allGreen ? "task.progress" : "task.blocked",
                message: `harness '${options.harness}' checks: ${checkResults
                  .map((entry) => `${entry.name}:${checkStatusWord(entry)}`)
                  .join(" ")}`,
                metadata: {
                  harness: options.harness,
                  checks: checkResults.map(
                    ({ outputTail: _tail, ...rest }) => rest
                  ),
                },
              })
              .catch(() => undefined);
          }
          if (!allGreen) {
            process.exitCode = 1;
          }
        }

        let diffStat: string | undefined;
        let collisions: WorktreeCollision[] = [];
        if (worktreePath && worktreeRepoRoot) {
          // Evidence capture must degrade, never throw away a finished run.
          // A THROWN capture (git failure) is distinct from a genuinely empty
          // diff: reporting both as "no tracked changes" would silently hide a
          // failed evidence probe, so the failure case is called out honestly.
          let diffStatCaptureFailed = false;
          diffStat = await worktreeDiffStat(worktreePath).catch(() => {
            diffStatCaptureFailed = true;
            return undefined;
          });
          process.stderr.write(
            diffStat && diffStat.length > 0
              ? `worktree diff --stat:\n${diffStat}\n`
              : diffStatCaptureFailed
                ? "worktree diff --stat: unavailable (capture failed)\n"
                : "worktree diff --stat: no tracked changes\n"
          );

          // Feed touched modules into the brain: staleness for anchored
          // memory notes + module-familiarity routing signals.
          if (options.record) {
            const changedFiles = await worktreeChangedFiles(worktreePath).catch(
              () => [] as string[]
            );
            if (changedFiles.length > 0) {
              await client
                .recordEvent({
                  laneId: (recordLane ?? runLane).id,
                  taskId: options.taskId,
                  kind: "task.progress",
                  message: `touched ${changedFiles.length} file(s)`,
                  metadata: { modules: changedFiles },
                })
                .catch(() => undefined);
            }
          }

          collisions = await detectWorktreeCollisions({
            repoRoot: worktreeRepoRoot,
            taskId: options.taskId,
          });
          for (const collision of collisions) {
            process.stderr.write(
              `warning: task '${collision.taskId}' also touches: ${collision.files.join(", ")}\n`
            );
          }
        }

        if (handoffTarget) {
          // Typed evidence for the packet (P0.3): verified diff hash from the
          // isolated worktree when available; honest degradation otherwise.
          const evidence: WorktreeEvidence | undefined = worktreePath
            ? await collectWorktreeEvidence(worktreePath).catch(
                (): WorktreeEvidence => ({
                  diff: { unavailableReason: "diff_error:collect_failed" },
                })
              )
            : undefined;
          // Coverage was already settled where the checks RAN
          // (runChecksWithCoverage), so the packet just maps the results it was
          // given. Qualifying a second time here is what let this surface drift
          // from the loop's verdict in the first place.
          const handoffChecks = checkResults.map((check) =>
            toHandoffCheck(check)
          );
          const packet = buildHandoffPacket({
            laneKey: options.lane,
            taskId: options.taskId,
            brief: options.brief,
            result,
            events,
            diffStat,
            collisions,
            checks: handoffChecks,
            diff: evidence?.diff,
            changedFiles: evidence?.changedFiles,
            recommendedNextAction: `Continue task '${options.taskId}' in lane '${options.handoffTo}'.`,
          });
          await client.createHandoff({
            taskId: options.taskId,
            fromLaneId: handoffTarget.fromLane.id,
            toLaneId: handoffTarget.toLane.id,
            packetTitle: `Run handoff: ${options.lane} -> ${options.handoffTo} (task ${options.taskId})`,
            packetBody: renderHandoffPacketMarkdown(packet),
            packet,
          });
          process.stderr.write(
            `handoff packet created: ${options.lane} -> ${options.handoffTo}\n`
          );
        }

        if (options.json) {
          printJson({
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            output: result.output,
          });
        } else {
          process.stdout.write(result.output);
        }

        if (result.exitCode !== 0) {
          // MUON's exit codes are its OWN contract: 0 ok, 1 failure, 2 the
          // brain refused your authority. Passing the vendor child's code
          // through meant a lane exiting 2 read as a governance refusal to
          // any script honoring that contract. The vendor's actual code stays
          // visible — in the JSON payload above and on stderr here.
          process.stderr.write(`vendor exited ${result.exitCode}\n`);
          process.exitCode = 1;
        }
      } catch (error) {
        // A brain-side authority refusal is NOT a vendor failure: it must not
        // be classified as "Claude Code isn't connected", and it owes the
        // contract exit 2. Checked FIRST, before the vendor classifier.
        if (isAuthorizationFailure(error)) {
          failCommand(error, "Run failed.");
          return;
        }
        // Turn a vendor-run failure into a CLEAR, actionable message (not a raw
        // dump): a login/auth failure routes to onboarding + fixHint; a genuine
        // run failure shows a sanitized reason + a retry hint. For non-vendor
        // lanes the classifier degrades to the sanitized error + retry.
        if ((ONBOARDING_VENDORS as readonly string[]).includes(options.lane)) {
          const readiness = await createClient()
            .getVendorReadiness()
            .catch(() => null);
          const notice = classifyVendorFailure({
            vendor: options.lane,
            readiness,
            error,
          });
          printError(`${notice.title}: ${notice.detail}`);
          if (notice.fixHint) {
            process.stderr.write(`→ ${notice.fixHint}\n`);
          } else if (notice.retryable) {
            process.stderr.write("→ retry the run once the issue is resolved\n");
          }
        } else {
          printError(error instanceof Error ? error.message : "Run failed.");
        }
        process.exitCode = 1;
      }
    });
}
