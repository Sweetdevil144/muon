import { createHash } from "node:crypto";
import { failCommand } from "../lib/refusal.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { describeMissionCost, withoutBudgetMarker } from "@muon/protocol";
import {
  buildRedispatchInput,
  collectCapabilityPreflight,
  collectRunBundle,
  planResume,
  type ApprovalRequest,
  type DispatchJobRecord,
  type LaneSession,
  type ResumeAction,
  type ResumePlan,
  type RunBundle,
} from "@muon/client";
import { collectWorktreeEvidence, locateTaskWorktreePath } from "@muon/core";
import { MuonApiClient } from "../lib/api-client.js";
import { printError } from "../lib/output.js";

/** The injected hasher: run-bundle/run-resume stay browser-pure; node signs here. */
const sha256Hex = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** Keep a caller-supplied id safe to drop into a default filename. */
function safeFileToken(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "run";
}

/** One-line, greppable summary of what landed in the bundle. */
function summarize(bundle: RunBundle, outPath: string): string {
  const phases = bundle.checkpoint.jobs.reduce<Record<string, number>>(
    (acc, job) => {
      acc[job.phase] = (acc[job.phase] ?? 0) + 1;
      return acc;
    },
    {}
  );
  const phaseMix =
    Object.entries(phases)
      .map(([phase, count]) => `${count} ${phase}`)
      .join(", ") || "no jobs";
  const resumableSessions = bundle.checkpoint.sessions.filter(
    (session) => session.vendorSessionId !== null
  ).length;
  const digest8 = bundle.checkpoint.lineageDigest
    ? bundle.checkpoint.lineageDigest.slice(0, 8)
    : "(none)";
  // Round-3 #15: the memory receipt, on the surface a human actually reads —
  // measured vs unknown stay distinct here exactly as in the field itself.
  const informed = bundle.manifest.jobs.filter(
    (job) => (job.memoryInformed?.notes ?? 0) > 0
  ).length;
  const memoryUnknown = bundle.manifest.jobs.filter(
    (job) => job.memoryInformed === null
  ).length;
  const lines = [
    `Wrote run bundle to ${outPath}`,
    `  source: ${bundle.source.kind} ${bundle.source.id}`,
    `  jobs: ${bundle.manifest.jobs.length}/${bundle.manifest.jobCount}` +
      ` · missions: ${bundle.budgets.length}` +
      ` · handoffs: ${bundle.handoffs.length}` +
      ` · approvals: ${bundle.approvals.length}` +
      ` · milestones: ${bundle.milestones.length}` +
      ` · artifacts: ${bundle.artifacts.length}`,
    `  memory-informed: ${informed} of ${bundle.manifest.jobs.length} job(s)` +
      (memoryUnknown > 0 ? ` · ${memoryUnknown} unknown (ledger unread)` : ""),
    // ADR-0036: the crew's cost, where a human closes the mission. Rendered
    // ONLY through describeMissionCost, so the `≥` and the lane coverage
    // always travel with the figure and no surface can print a bare number.
    `  cost: ${
      bundle.cost
        ? describeMissionCost(bundle.cost)
        : "unknown (spend ledger unread)"
    }`,
    `  checkpoint: ${phaseMix}` +
      ` · pending gates: ${bundle.checkpoint.pendingGates.length}` +
      ` · resumable sessions: ${resumableSessions}` +
      ` · lineage ${digest8}`,
    `  bundle v${bundle.version} · generated ${bundle.generatedAt}`,
  ];
  if (bundle.omissions.length > 0) {
    lines.push(`  omitted (bounds): ${bundle.omissions.join("; ")}`);
  }
  return `${lines.join("\n")}\n`;
}

type LiveState = {
  jobs: DispatchJobRecord[];
  approvals: ApprovalRequest[];
  sessions: LaneSession[];
  /**
   * Read endpoints that FAILED mid-collection (never silently coerced to an
   * empty result). A non-empty list means the plan was built from INCOMPLETE
   * evidence — e.g. a dropped `listApprovals` empties `pendingGates`, so a job
   * with a live pending gate would silently miss its `decide-gate` action. The
   * plan must surface this and writes must refuse, mirroring the version-drift
   * refusal — never a clean plan from partial evidence.
   */
  partial: string[];
};

const LIVE_JOBS_LIMIT = 200;

/**
 * Raw live-state collection over EXISTING read-only GETs (unredacted rows —
 * this stays local; a re-dispatch needs the original brief verbatim). Mission
 * expansion mirrors collectRunBundle: the budget view enumerates descendants.
 */
async function collectLiveState(
  client: MuonApiClient,
  target: { jobId?: string; chatId?: string }
): Promise<LiveState> {
  let jobs: DispatchJobRecord[] = [];
  if (target.chatId) {
    jobs = await client.listDispatchJobs({
      chatId: target.chatId,
      limit: LIVE_JOBS_LIMIT,
    });
  } else {
    const rootJob = await client.getDispatchJob(target.jobId as string);
    const memberIds = new Set<string>([
      rootJob.rootJobId ?? rootJob.id,
      rootJob.id,
    ]);
    const budget = await client
      .getDispatchBudget(rootJob.id)
      .catch(() => null);
    if (budget) {
      memberIds.add(budget.jobId);
      for (const child of budget.children) memberIds.add(child.jobId);
    }
    const fetched = await Promise.all(
      [...memberIds]
        .slice(0, LIVE_JOBS_LIMIT)
        .map((id) =>
          id === rootJob.id
            ? Promise.resolve(rootJob)
            : client.getDispatchJob(id).catch(() => null)
        )
    );
    jobs = fetched.filter((job): job is DispatchJobRecord => job !== null);
  }
  const taskIds = [...new Set(jobs.map((job) => job.taskId))];
  const partial: string[] = [];
  // A failed approvals fetch must NEVER become a clean empty list: that would
  // silently drop every pending gate from the plan (an interrupted job with a
  // live pending gate would lose its decide-gate action with no warning).
  let approvals: ApprovalRequest[] = [];
  try {
    approvals = (await client.listApprovals()).filter((approval) =>
      taskIds.includes(approval.taskId)
    );
  } catch {
    partial.push("approvals (GET /api/approvals failed)");
  }
  const sessions: LaneSession[] = [];
  await Promise.all(
    taskIds.map(async (taskId) => {
      try {
        sessions.push(...(await client.listSessions({ taskId })));
      } catch {
        partial.push(`sessions for task ${taskId} (GET /api/sessions failed)`);
      }
    })
  );
  return { jobs, approvals, sessions, partial };
}

type ArtifactVerification = {
  jobId: string;
  status: "verified-unchanged" | "DIVERGED" | "unverifiable";
  detail: string;
};

/**
 * Read-only artifact verification: locate the still-on-disk worktree via the
 * PURE path helper (never creates, never checks out) and re-hash `git diff`
 * against the packet's diffHash evidence.
 */
async function verifyArtifacts(
  actions: ResumeAction[]
): Promise<ArtifactVerification[]> {
  const results: ArtifactVerification[] = [];
  for (const action of actions) {
    if (action.kind !== "verify-artifacts") continue;
    const root = action.workspacePath ?? process.cwd();
    let worktree: string;
    try {
      worktree = locateTaskWorktreePath(root, action.taskId);
    } catch (error) {
      results.push({
        jobId: action.jobId,
        status: "unverifiable",
        detail: error instanceof Error ? error.message : "bad task id",
      });
      continue;
    }
    if (!existsSync(worktree)) {
      results.push({
        jobId: action.jobId,
        status: "unverifiable",
        detail: `worktree missing (${worktree})`,
      });
      continue;
    }
    const evidence = await collectWorktreeEvidence(worktree);
    if (!("hash" in evidence.diff)) {
      results.push({
        jobId: action.jobId,
        status: "unverifiable",
        detail: evidence.diff.unavailableReason,
      });
      continue;
    }
    results.push(
      evidence.diff.hash === action.diffHash
        ? {
            jobId: action.jobId,
            status: "verified-unchanged",
            detail: `diffHash ${action.diffHash} re-verified from the on-disk worktree`,
          }
        : {
            jobId: action.jobId,
            status: "DIVERGED",
            detail: `packet ${action.diffHash} vs on-disk ${evidence.diff.hash}`,
          }
    );
  }
  return results;
}

function describeAction(action: ResumeAction): string {
  switch (action.kind) {
    case "none-still-queued":
      return `  none-still-queued   ${action.jobId} — still queued; the next live runner claims it (zero writes)`;
    case "await-runner-reclaim":
      return `  await-runner-reclaim ${action.jobId} — running with a possibly-dead lease; the successor runner's startup reclaim owns reconciliation`;
    case "decide-gate":
      return (
        `  decide-gate         ${action.jobId} — pending approval ${action.approvalId}` +
        (action.payloadDigest ? ` (payload ${action.payloadDigest.slice(0, 12)}…)` : "") +
        (action.sessionInterrupted
          ? " · session DEAD: this approval can never be delivered — reject it, then redispatch"
          : " · decide it in the approvals inbox")
      );
    case "redispatch-fresh":
      return `  redispatch-fresh    ${action.jobId} — provably unstarted (no vendor process ever launched); --execute re-dispatches it as a fresh job`;
    case "already-resumed":
      return `  already-resumed     ${action.jobId} — already resumed by job ${action.resumedByJobId ?? "(unknown)"}; skipped (a terminal job is resumed at most once, so no duplicate redispatch)`;
    case "human-review":
      return (
        `  human-review        ${action.jobId} — UNCERTAIN outcome; only --redispatch ${action.jobId} re-dispatches it\n` +
        `      evidence: vendor=${action.evidence.vendor} kind=${action.evidence.jobKind}` +
        ` started=${action.evidence.startedAt ?? "-"} ended=${action.evidence.endedAt ?? "-"}\n` +
        // Rendered evidence: the operator reads the sentence, not the
        // `[muon:budget-exhausted]` classifier. The plan's own evidence field
        // (and the --out JSON report) keeps the marker for machines.
        `      result: ${
          action.evidence.result
            ? withoutBudgetMarker(action.evidence.result)
            : "(none)"
        }`
      );
    case "verify-artifacts":
      return `  verify-artifacts    ${action.jobId} — read-only re-hash of the worktree diff evidence`;
  }
}

function printPlan(
  plan: ResumePlan,
  verifications: ArtifactVerification[],
  write: (line: string) => void
): void {
  write(
    `Resume plan (read-only): live lineage ${plan.lineage.live?.slice(0, 8) ?? "(none)"}` +
      ` · bundle ${plan.lineage.bundle?.slice(0, 8) ?? "(none)"}` +
      ` · match ${plan.lineage.match === null ? "n/a" : plan.lineage.match}`
  );
  if (plan.versionDrift.length > 0) {
    for (const drift of plan.versionDrift) {
      write(
        `  version drift: ${drift.vendor} exported=${drift.exported ?? "(unknown)"} live=${drift.live ?? "(unknown)"}`
      );
    }
  }
  for (const action of plan.actions) {
    write(describeAction(action));
  }
  for (const verification of verifications) {
    write(
      `  artifacts ${verification.jobId}: ${verification.status} — ${verification.detail}`
    );
  }
}

/**
 * `muon bundle …`, P0.1. `export` assembles a single, portable, STRICTLY
 * read-only JSON evidence bundle (v2: including the last-safe-checkpoint
 * projection + provider/version fingerprints) from existing ledger data.
 * `resume` is the explicit HUMAN resume act: reconcile against the live
 * ledger first, prove what already happened, re-dispatch only
 * provably-unstarted work as fresh lineage-linked jobs — dry-run by default,
 * never an autonomous replay. Free text is redacted-then-bounded; no
 * credential material is carried.
 */
export function registerBundleCommand(
  program: Command,
  createClient: () => MuonApiClient
) {
  const bundle = program
    .command("bundle")
    .description("Portable, read-only evidence bundles of what the crew did");

  bundle
    .command("export <id>")
    .description(
      "Export a read-only JSON run bundle for a dispatch job (or a chat with --chat)"
    )
    .option("--chat", "interpret <id> as a chat id instead of a job id")
    .option(
      "--out <file>",
      "write the bundle to this path (default: ./muon-bundle-<id>.json)"
    )
    .action(async (id: string, options: { chat?: boolean; out?: string }) => {
      try {
        const client = createClient();
        const runBundle = await collectRunBundle(client, {
          ...(options.chat ? { chatId: id } : { jobId: id }),
          sha256Hex,
        });
        const outPath = path.resolve(
          options.out ?? `muon-bundle-${safeFileToken(id)}.json`
        );
        writeFileSync(outPath, `${JSON.stringify(runBundle, null, 2)}\n`, "utf8");
        process.stdout.write(summarize(runBundle, outPath));
      } catch (error) {
        failCommand(error, "Failed to export run bundle.");
      }
    });

  bundle
    .command("resume <id>")
    .description(
      "Plan (and, explicitly, execute) a resume after a kill/restart: dry-run by default, zero ledger writes"
    )
    .option("--chat", "interpret <id> as a chat id instead of a job id")
    .option("--from <bundle.json>", "verify against an exported run bundle")
    .option(
      "--execute",
      "re-dispatch ONLY the provably-unstarted set as fresh lineage-linked jobs"
    )
    .option(
      "--redispatch <jobId...>",
      "explicitly re-dispatch an uncertain (human-review) job by id"
    )
    .option(
      "--allow-version-drift",
      "proceed with --execute/--redispatch despite vendor CLI version drift"
    )
    .option("--out <report.json>", "write the full plan/verification report")
    .action(
      async (
        id: string,
        options: {
          chat?: boolean;
          from?: string;
          execute?: boolean;
          redispatch?: string[];
          allowVersionDrift?: boolean;
          out?: string;
        }
      ) => {
        const write = (line: string) => process.stdout.write(`${line}\n`);
        try {
          const client = createClient();

          // ---- parse the (optional) bundle evidence first ----
          let fromBundle: RunBundle | undefined;
          if (options.from) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(readFileSync(options.from, "utf8"));
            } catch (error) {
              printError(
                `Refusing: could not read bundle '${options.from}' (${
                  error instanceof Error ? error.message : "unreadable"
                }).`
              );
              process.exitCode = 1;
              return;
            }
            const shape = parsed as Partial<RunBundle> | null;
            if (
              !shape ||
              shape.version !== 2 ||
              typeof shape.checkpoint !== "object" ||
              shape.checkpoint === null ||
              !Array.isArray(shape.manifest?.jobs)
            ) {
              printError(
                "Refusing: the file is not a v2 run bundle with a checkpoint section (stale or corrupt evidence is never guessed from). Re-export with `muon bundle export`."
              );
              process.exitCode = 1;
              return;
            }
            fromBundle = shape as RunBundle;
          }

          // ---- live ledger reachable? (resume WRITES require the local brain) ----
          const brainUp = await client
            .health()
            .then(() => true)
            .catch(() => false);
          if (!brainUp) {
            if (fromBundle) {
              write(
                "live ledger unreachable; resume execution unavailable — resume writes require the local brain. Report-only from the bundle:"
              );
              for (const job of fromBundle.checkpoint.jobs) {
                write(
                  `  ${job.jobId}: phase=${job.phase} uncertain=${job.uncertain}` +
                    ` provablyUnstarted=${job.provablyUnstarted} → ${job.resume.mechanism} (${job.resume.reason})`
                );
              }
              return;
            }
            printError(
              "The local brain is unreachable and no --from bundle was given; nothing to report and resume writes are unavailable."
            );
            process.exitCode = 1;
            return;
          }

          // ---- reconcile: live state (GETs only) + pure plan ----
          const live = await collectLiveState(
            client,
            options.chat ? { chatId: id } : { jobId: id }
          );
          const livePreflight = await collectCapabilityPreflight(client).catch(
            () => null
          );
          const plan = planResume({
            live,
            bundle: fromBundle,
            livePreflight,
            sha256Hex,
          });

          if (plan.refused) {
            printError(`Refusing to resume: ${plan.refused.reason}`);
            process.exitCode = 1;
            return;
          }

          const verifications = await verifyArtifacts(plan.actions);
          printPlan(plan, verifications, write);

          // Honest degradation: a live GET failed, so the plan was built from
          // INCOMPLETE evidence and may omit decide-gate / redispatch actions.
          if (live.partial.length > 0) {
            write(
              "  ! DEGRADED PLAN: live evidence is INCOMPLETE — this plan may omit decide-gate/redispatch actions:"
            );
            for (const gap of live.partial) write(`      - ${gap}`);
          }

          const executed: Array<{ from: string; to: string }> = [];
          const wantsWrites =
            options.execute === true ||
            (options.redispatch !== undefined && options.redispatch.length > 0);

          // Refuse writes from an incomplete snapshot, mirroring the version-
          // drift refusal — resume execution requires a COMPLETE live ledger,
          // never a plan silently missing gates.
          if (wantsWrites && live.partial.length > 0) {
            printError(
              "Refusing to execute from INCOMPLETE live evidence (see the degraded plan above): " +
                `${live.partial.join("; ")}. Resume writes require a complete live snapshot; retry when the brain is healthy.`
            );
            process.exitCode = 1;
            return;
          }

          if (wantsWrites && plan.versionDrift.length > 0 && !options.allowVersionDrift) {
            printError(
              "Refusing to execute under vendor CLI version drift (see the plan). Re-run with --allow-version-drift to acknowledge it."
            );
            process.exitCode = 1;
            return;
          }

          if (options.execute) {
            // ONLY the provably-unstarted set; uncertain jobs are untouched.
            for (const action of plan.actions) {
              if (action.kind !== "redispatch-fresh") continue;
              const fresh = await client.enqueueDispatch(action.dispatch);
              executed.push({ from: action.jobId, to: fresh.id });
              write(`  redispatched ${action.jobId} → ${fresh.id}`);
            }
            if (executed.length === 0) {
              write(
                "  --execute: nothing provably unstarted to re-dispatch (uncertain work is never auto-replayed)."
              );
            }
          }

          for (const jobId of options.redispatch ?? []) {
            const reviewable = plan.actions.find(
              (action) => action.kind === "human-review" && action.jobId === jobId
            );
            if (!reviewable || reviewable.kind !== "human-review") {
              printError(
                `--redispatch ${jobId}: only a job the plan classed 'human-review' may be explicitly re-dispatched.`
              );
              process.exitCode = 1;
              return;
            }
            const job = live.jobs.find((candidate) => candidate.id === jobId);
            if (!job) {
              printError(`--redispatch ${jobId}: job not found in the live ledger.`);
              process.exitCode = 1;
              return;
            }
            write(`  re-dispatching UNCERTAIN job ${jobId} on your explicit authority:`);
            write(describeAction(reviewable));
            const fresh = await client.enqueueDispatch(
              buildRedispatchInput(job, live.sessions)
            );
            executed.push({ from: jobId, to: fresh.id });
            write(`  redispatched ${jobId} → ${fresh.id}`);
          }

          if (!wantsWrites) {
            write(
              "dry run — zero ledger writes were performed. Use --execute for the provably-unstarted set, or --redispatch <jobId> for an uncertain job."
            );
          }

          if (options.out) {
            const outPath = path.resolve(options.out);
            writeFileSync(
              outPath,
              `${JSON.stringify({ plan, verifications, executed }, null, 2)}\n`,
              "utf8"
            );
            write(`Wrote resume report to ${outPath}`);
          }
        } catch (error) {
          failCommand(error, "Failed to plan the resume.");
        }
      }
    );
}
