import { heuristicWorkflowProposal } from "@muon/core";
import { refusalOf } from "@muon/client";
import {
  assignCrewRoles,
  VENDOR_DISPATCH_ROLES,
  type DispatchJobRecord,
  type DispatchKind,
  type MuonApiClient,
  type RolePin,
  type VendorReadiness,
} from "@muon/client";
import {
  applyWorkflowGateTag,
  budgetRaiseGateTag,
  canonicalCounts,
  CREW_TASK_HEADINGS,
  DELEGATION_MAX_CHILDREN,
  fleetGateTag,
  AGENT_ROLES,
  HANDOFF_FINAL_MESSAGE_CHARS,
  ROLE_SPECS,
  briefHeadingMandate,
  childBriefSkeleton,
  declaredHeadings,
  fleetVendorIds,
  FLEET_MAX_AGENTS_PER_VENDOR,
  missingBriefHeadings,
  taskHeadingList,
  vendorRoutingBrief,
  vendorsWhere,
  type AgentRole,
} from "@muon/protocol";
import {
  fail,
  failWithRefusal,
  firstLoopDegradation,
  ok,
  summarizeLoopRun,
  withAgentUi,
  type ToolDefinition,
  type ToolPrincipal,
} from "./agent-ui.js";

/**
 * Orchestrator toolset (v2): what the conversational super-agent uses to run
 * the crew. The gate policy is CODE, not prompt:
 * - dispatch/steer/read are direct (the human's instruction in chat is the
 *   consent to do the work they asked for),
 * - set_fleet and apply_workflow require an APPROVED approval id, the tool
 *   physically cannot proceed without the human's recorded decision,
 * - ship only FILES the merge gate; moving a task to done stays human-only,
 * - sub-agent sessions keep the fail-closed approval bridge: any
 *   un-preauthorized tool call inside a sub-agent pauses into the inbox.
 */

export type OrchestratorScope = {
  jobId?: string;
  delegationToken?: string;
  chatId?: string;
  /** The chat's shadow task, approvals FK to Task, gates hang off this. */
  chatTaskId?: string;
  workspacePath?: string;
  apiBase: string;
  apiToken?: string;
};

/**
 * The lanes the superagent may name on `dispatch`, projected from the registry
 * (ADR-0022 C2). The public slice only: the DEV/TEST seam is never advertised to
 * a vendor process, and the route re-checks admission anyway.
 */
const VENDORS = vendorsWhere(
  (entry) => entry.visibility === "public" && entry.authority.dispatchable
);
/** The 0–3 worker fleet the superagent may resize. */
const FLEET_VENDORS = fleetVendorIds();
const LOOP_LIMIT = 5;
/**
 * Bound on the per-vendor capability rows echoed to the coordinator. Sized to
 * the FULL managed vendor set: a limit smaller than that silently dropped the
 * last lane (opencode sorts last), so the crew was told a lane it can dispatch
 * to does not exist.
 */
const CAPABILITY_VENDOR_LIMIT = VENDORS.length;
/**
 * Bound on the fleet agent rows echoed to the coordinator. Sized to the WHOLE
 * fleet — every sizeable lane at the resize ceiling — for the same reason
 * CAPABILITY_VENDOR_LIMIT is sized to the whole vendor set: this list is how the
 * coordinator learns how many seats it can actually run in parallel, and a bound
 * narrower than the fleet reports capacity that exists as capacity that does
 * not. It was a flat `9` while the fleet seated 4 lanes × 3 seats = 12.
 */
const FLEET_AGENT_LIMIT = FLEET_VENDORS.length * FLEET_MAX_AGENTS_PER_VENDOR;

async function readLoopStatus(client: MuonApiClient, taskId: string) {
  if (typeof client.listLoopRuns !== "function") {
    return {
      loops: [] as ReturnType<typeof summarizeLoopRun>[],
      unavailable:
        "loop/evaluator status is unavailable from this backend/client version",
    };
  }
  try {
    const loops = await client.listLoopRuns({ taskId });
    return {
      loops: loops.slice(-LOOP_LIMIT).map(summarizeLoopRun),
    };
  } catch (error) {
    return {
      loops: [] as ReturnType<typeof summarizeLoopRun>[],
      unavailable: `loop/evaluator status unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 300),
    };
  }
}

/**
 * Per-vendor capability rows for the coordinator. `dispatchReady` answers for
 * UN-PLANNED work (the role a roleless dispatch resolves to), so a role-scoped
 * lane reads as false here and names the roles it CAN hold instead — the crew
 * planner routes on `dispatchRoles`, not on a single boolean.
 */
function capabilitySummary(readiness: VendorReadiness[]) {
  return readiness.slice(0, CAPABILITY_VENDOR_LIMIT).map((entry) => {
    // FAIL-CLOSED: a lane MUON does not name holds no role. This used to read
    // `?? [...AGENT_ROLES]`, so an unrecognized vendor was described to the
    // SUPERAGENT as dispatch-ready for every role — the fail-open with the
    // longest reach, because the coordinator plans against this row.
    const dispatchRoles = VENDOR_DISPATCH_ROLES[entry.vendor] ?? [];
    const roleScoped = !dispatchRoles.includes("implementer");
    const connected = entry.installed && entry.authenticated;
    const dispatchReady = connected && !roleScoped;
    const roleAction =
      dispatchRoles.length === 0
        ? `MUON does not manage ${entry.vendor} for any crew role. Do not dispatch to it.`
        : `Dispatch ${entry.vendor} only under: ${dispatchRoles.join(", ")}.`;
    return {
      vendor: entry.vendor,
      installed: entry.installed,
      authenticated: entry.authenticated,
      dispatchReady,
      dispatchRoles: [...dispatchRoles],
      ...(entry.credentialMethod
        ? { credentialMethod: entry.credentialMethod }
        : {}),
      boundary: dispatchReady
        ? "dispatch-ready"
        : connected
          ? "role-scoped"
          : "setup-required",
      detail: entry.detail,
      ...(dispatchReady
        ? {}
        : {
            action: connected
              ? roleAction
              : (entry.fixHint ?? `Connect ${entry.vendor}, then re-check.`),
          }),
    };
  });
}

async function readFleetCapabilities(client: MuonApiClient) {
  if (typeof client.getVendorReadiness !== "function") {
    return {
      status: "unavailable" as const,
      vendors: [],
      omitted: 0,
      reason: "vendor readiness is unavailable from this backend/client version",
      action: "Run `muon doctor` for local vendor capability evidence.",
    };
  }
  try {
    const readiness = await client.getVendorReadiness();
    return {
      status: "available" as const,
      vendors: capabilitySummary(readiness),
      // Derived from the ACTUAL slice: an envelope that hardcodes "none
      // omitted" over a bounded list is a claim it cannot make.
      omitted: Math.max(0, readiness.length - CAPABILITY_VENDOR_LIMIT),
    };
  } catch (error) {
    return {
      status: "unavailable" as const,
      vendors: [],
      omitted: 0,
      reason: `vendor readiness unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 300),
      action: "Run `muon doctor` for local vendor capability evidence.",
    };
  }
}

/**
 * Defense-in-depth for every job-addressed orchestrator surface: a chat may
 * only observe or control jobs in its own partition. Returns an error string if
 * the job is outside that partition, else null. A job with no chatId (e.g. a
 * CLI-enqueued job) is in scope only when this caller also has no chat scope.
 */
async function assertJobInScope(
  client: MuonApiClient,
  scope: OrchestratorScope,
  jobId: string
): Promise<string | null> {
  const job = await client.getDispatchJob(jobId).catch(() => null);
  if (!job) {
    return `no dispatch job '${jobId}'`;
  }
  if ((job.chatId ?? null) !== (scope.chatId ?? null)) {
    return `job '${jobId}' is outside the current chat scope`;
  }
  return null;
}

/**
 * How much of a worker's `result` each status shape carries.
 *
 * Two numbers because they answer two questions. A LIST of up to 20 jobs is a
 * roster — the coordinator is scanning statuses, not reading reports — so it
 * stays tight. Asking about ONE job by id IS "show me what this worker said",
 * and 1 200 characters was not a report: the founder's two lost closing reports
 * measured 5 431 and 4 910 characters, which is exactly why the handoff
 * packet's own `finalMessage` bound is 8 000. Same evidence, same number, so
 * there is one bound for "a worker's closing report" rather than two that drift.
 */
const DISPATCH_LIST_RESULT_CHARS = 1_200;
const DISPATCH_DETAIL_RESULT_CHARS = HANDOFF_FINAL_MESSAGE_CHARS;

/** Compact view of a dispatch job for the super-agent's status tools. */
function dispatchSummary(
  job: DispatchJobRecord,
  resultChars: number = DISPATCH_LIST_RESULT_CHARS
) {
  return {
    jobId: job.id,
    kind: job.kind,
    vendor: job.vendor,
    // What this worker RUNS AS (VISION §2). Resolved server-side at dispatch, so
    // the coordinator reports the crew from the ledger rather than from memory.
    role: job.role ?? null,
    taskId: job.taskId,
    status: job.status,
    agentId: job.agentId ?? null,
    exitCode: job.exitCode ?? null,
    interruptRequested: job.interruptRequested,
    // The TAIL, because the end of a run is its verdict. Marked when it cut, so
    // the coordinator can tell "this is all the worker said" from "this is the
    // end of what the worker said" — the ambiguity that let a clipped report
    // read as a complete one.
    result: job.result
      ? job.result.length > resultChars
        ? `[muon:truncated to the last ${resultChars} chars; read the full report with handoff_read]\n${job.result.slice(
            -resultChars
          )}`
        : job.result
      : null,
  };
}

/**
 * A gate binds a human approval to ONE specific action + payload. The tag
 * (e.g. `[gate:set_fleet claude-code=2,codex=0,cursor=0]`, from `@muon/protocol`)
 * is filed with the approval, both in the human-readable `reason` and in the
 * structured `gateTag` column, so a `command`/`merge` approval, or a fleet
 * approval for different counts, cannot authorize this action.
 *
 * ADR-0010 Part B moved the REDEMPTION from here (a read-then-consume in the
 * tool) to the ROUTE (`redeemGateAtRoute`, an atomic validate+consume). The
 * tool now just FORWARDS the approval id to the route (`setFleet(counts, id)` /
 * `applyWorkflowRun(runId, "human", id)`); the route is the single consume
 * point (never both, else the second sees an already-consumed gate). A route
 * 403 (used / mismatched / unapproved / non-gate) maps to the friendly message
 * below so the super-agent tells the human to approve or file a fresh gate.
 */
function gateRouteError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b403\b/.test(message)) {
    return "the gate was rejected, it may have been already used (gates are single-use), not yet approved, or filed for a different action/payload. Ask the human to approve, or file a fresh gate and retry.";
  }
  return message;
}

const DISPATCH_ADMISSION_TIMEOUT_MS = 15_000;
const RUNNER_OBSERVATION_TIMEOUT_MS = 2_000;

class DispatchAdmissionTimeoutError extends Error {
  constructor(readonly stage: string) {
    super(
      `dispatch admission timed out during ${stage} after ${DISPATCH_ADMISSION_TIMEOUT_MS}ms`
    );
    this.name = "DispatchAdmissionTimeoutError";
  }
}

function admissionWaiter(deadline: number) {
  return async <T>(stage: string, operation: () => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new DispatchAdmissionTimeoutError(stage);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new DispatchAdmissionTimeoutError(stage)),
            remaining
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

function admissionTimeoutFailure(error: DispatchAdmissionTimeoutError) {
  return fail(
    `${error.message}. No child job was created. Retry after checking backend/runner health; if it repeats, run \`muon doctor\` and inspect the backend logs.`
  );
}

async function observeRunnerBounded(client: MuonApiClient) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client
        .getRunner()
        .then((runner) => ({ observed: true as const, runner }))
        .catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(
          () => resolve(undefined),
          RUNNER_OBSERVATION_TIMEOUT_MS
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createOrchestratorToolDefinitions(
  client: MuonApiClient,
  scope: OrchestratorScope,
  options: { principal?: ToolPrincipal } = {}
): ToolDefinition[] {
  const workflowControl =
    scope.jobId && scope.delegationToken
      ? {
          callerJobId: scope.jobId,
          delegationToken: scope.delegationToken,
        }
      : undefined;
  const dispatchAgent = async (args: Record<string, unknown>) => {
    const awaitAdmission = admissionWaiter(
      Date.now() + DISPATCH_ADMISSION_TIMEOUT_MS
    );
    const vendor = String(args.vendor ?? "");
    if (!VENDORS.includes(vendor as (typeof VENDORS)[number])) {
      return fail(`vendor must be one of ${VENDORS.join("|")}`);
    }
    const taskId = String(args.taskId ?? "").trim();
    const brief = String(args.brief ?? "").trim();
    if (!taskId || brief.length < 5) {
      return fail("taskId and a brief (≥5 chars) are required");
    }

    // Readiness gate (P2): don't enqueue for a vendor the user isn't logged
    // into, fail HERE in chat with the exact fix, instead of a cryptic
    // runtime failure after an agent has been claimed. Degrade gracefully: if
    // the readiness probe is unavailable (older backend / probe error), never
    // block the dispatch on our own inability to check.
    let capabilityEvidence: {
      status: "verified" | "unavailable";
      vendor: string;
      method?: string;
      detail?: string;
      reason?: string;
      action?: string;
    } = {
      status: "unavailable",
      vendor,
      reason: "vendor readiness evidence was not returned",
      action: "Run `muon doctor`, fix the reported vendor state, then retry.",
    };
    try {
      const readiness = await awaitAdmission("vendor readiness", () =>
        client.getVendorReadiness()
      );
      const cached = readiness.find((entry) => entry.vendor === vendor);
      if (cached && !(cached.installed && cached.authenticated)) {
        // Re-probe once, cache-bypassing, before blocking, the human may have
        // just logged in and the ≤8s-cached result would be stale.
        let fresh;
        try {
          fresh = await awaitAdmission("fresh vendor readiness", () =>
            client.getVendorReadiness({ refresh: true })
          );
        } catch (error) {
          if (error instanceof DispatchAdmissionTimeoutError) {
            return admissionTimeoutFailure(error);
          }
          fresh = null;
        }
        const status = fresh?.find((entry) => entry.vendor === vendor) ?? cached;
        if (!(status.installed && status.authenticated)) {
          const hint = status.fixHint ? ` ${status.fixHint}` : "";
          return fail(`Cannot dispatch to '${vendor}': ${status.detail}.${hint}`);
        }
        capabilityEvidence = {
          status: "verified",
          vendor,
          method: status.credentialMethod ?? "vendor-login",
          detail: status.detail,
        };
      } else if (cached?.installed && cached.authenticated) {
        capabilityEvidence = {
          status: "verified",
          vendor,
          method: cached.credentialMethod ?? "vendor-login",
          detail: cached.detail,
        };
      }
    } catch (error) {
      if (error instanceof DispatchAdmissionTimeoutError) {
        return admissionTimeoutFailure(error);
      }
      capabilityEvidence = {
        status: "unavailable",
        vendor,
        reason: `vendor readiness verification unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`.slice(0, 300),
        action:
          "Dispatch is proceeding degrade-safe. Run `muon doctor` before trusting vendor capability coverage.",
      };
    }

    const mode = String(args.mode ?? "auto");
    const harnessKey = args.harnessKey ? String(args.harnessKey) : undefined;
    const useLoop = args.loop === true;
    // An explicitly requested crew role. Validated HERE only for shape; the
    // route is the authority on whether this vendor may hold it.
    const requestedRole = args.role ? String(args.role) : undefined;
    if (
      requestedRole &&
      !AGENT_ROLES.includes(requestedRole as AgentRole)
    ) {
      return fail(`role must be one of ${AGENT_ROLES.join("|")}`);
    }
    const role = requestedRole as AgentRole | undefined;

    let lanes;
    try {
      lanes = await awaitAdmission("lane lookup", () => client.listLanes());
    } catch (error) {
      if (error instanceof DispatchAdmissionTimeoutError) {
        return admissionTimeoutFailure(error);
      }
      return fail(
        `could not verify dispatch lane: ${error instanceof Error ? error.message : error}`
      );
    }
    const lane = lanes.find((entry) => entry.key === vendor);
    if (!lane) {
      return fail(`lane '${vendor}' not found in the ledger`);
    }

    // Validate the harness key up front so a typo fails right here in chat
    // instead of silently in the runner. The runner re-validates the full
    // requirements (interactive availability, worktree) at execution time.
    let checkCount = 0;
    if (harnessKey) {
      try {
        checkCount = (
          await awaitAdmission("harness lookup", () =>
            client.getHarness(harnessKey)
          )
        ).config.checks.length;
      } catch (error) {
        if (error instanceof DispatchAdmissionTimeoutError) {
          return admissionTimeoutFailure(error);
        }
        return fail(
          `harness '${harnessKey}' not found: ${error instanceof Error ? error.message : error}`
        );
      }
    }
    if (useLoop && checkCount === 0) {
      return fail(
        "loop:true needs a harness with checks (e.g. harnessKey 'repair' or 'implement'), otherwise there is nothing to repair against"
      );
    }

    const kind: DispatchKind = useLoop
      ? "loop"
      : mode === "session"
        ? "session"
        : mode === "oneshot"
          ? "oneshot"
          : "auto";

    let task;
    try {
      task = await awaitAdmission("task lookup", () =>
        client.getTaskDetail(taskId)
      );
    } catch (error) {
      if (error instanceof DispatchAdmissionTimeoutError) {
        return admissionTimeoutFailure(error);
      }
      task = undefined;
    }
    const workspacePath = task?.workspacePath ?? scope.workspacePath;

    if (!scope.jobId || !scope.delegationToken) {
      return fail(
        "the orchestrator job-bound delegate capability is unavailable; fail closed instead of creating an unowned child"
      );
    }

    // The backend derives lineage and compiles a restricted work-only child
    // manifest. The root orchestrator never creates a second orchestrator.
    let job;
    try {
      job = await client.delegateDispatch(
        scope.jobId,
        {
          kind,
          vendor,
          taskId,
          brief,
          harnessKey,
          workspacePath: workspacePath ?? undefined,
          // The crew role this worker runs as. Omitted → the backend resolves
          // it from the chat's crew plan, then the harness. Either way the
          // route refuses a role the vendor cannot hold (fail-closed), so a
          // read-only lane can never be handed write work.
          ...(role ? { role } : {}),
          // Optional right-sizing: when omitted the backend defaults to a
          // right-sized share of the root pool; the route re-checks any explicit
          // value against the parent/root caps (fail-closed).
          ...(typeof args.maxWallMs === "number"
            ? { maxWallMs: args.maxWallMs }
            : {}),
          // Optional model override: the route validates it against the child's
          // execution vendor (fail-closed) and refuses an invalid id with a 400,
          // surfaced below as fail(). An unknown-but-allowed id passes.
          ...(typeof args.model === "string" && args.model.trim().length > 0
            ? { model: args.model.trim() }
            : {}),
        },
        scope.delegationToken
      );
    } catch (error) {
      // ADR-0033. This one line is the funnel every role-ceiling 400 and every
      // budget/cap 409 reaches the coordinator through. It used to flatten all
      // of them to a prefixed string with no status and no evidence, so an
      // agent could not tell "this lane can never hold that role" (stop) from
      // "the pool is momentarily exhausted" (wait). When the route typed its
      // refusal, carry it.
      const refusal = refusalOf(error);
      if (refusal) {
        return failWithRefusal(refusal, `could not enqueue dispatch`);
      }
      return fail(
        `could not enqueue dispatch: ${error instanceof Error ? error.message : error}`
      );
    }

    // A queued job goes nowhere without a live runner, report honestly so the
    // super-agent can tell the human to start one (the desktop app + `muon
    // chat` both auto-start one).
    // Do not race the atomic delegate call itself: a late successful enqueue
    // after returning an error would create an orphaned child. Once admitted,
    // runner observation is read-only and bounded; an observation timeout must
    // report the real job id rather than falsely claiming enqueue failed.
    const runnerObservation = await observeRunnerBounded(client);
    const runner = runnerObservation?.runner ?? {
      runner: null,
      live: false,
    };
    const runnerObserved = runnerObservation?.observed === true;

    // S0: REPORT the dispatch contract here, do NOT refuse it. `runChatTurn`'s
    // `childBriefDeficiency` is the single verifier, and duplicating a refusal in
    // two places is how the two-vocabulary bug happened — so the job still
    // dispatches and this is evidence, not authority.
    //
    // Reporting it at all is the point: an externally launched coordinator never
    // sees the chat turn that convicts its child, so without this it learns "the
    // dispatch contract failed" and not WHICH heading was missing. The check this
    // replaces was a substring test for two of the twelve headings — a private
    // second copy of the contract, and therefore the same drift in miniature.
    const missingHeadings = missingBriefHeadings(brief);
    const briefContract =
      missingHeadings.length === 0
        ? { satisfied: true, missing: [] as string[] }
        : {
            satisfied: false,
            missing: missingHeadings,
            // What the brief DID declare, so a near-miss (`OBJECTIVE:` where the
            // contract wanted `GOAL:`) is visible rather than inferred. Bounded
            // by `declaredHeadings`.
            declared: declaredHeadings(brief),
            verifiedBy:
              "the chat-turn dispatch contract; this child is admitted and running, but MUON will not COUNT it as crew proof until its brief declares every required heading",
            skeleton: childBriefSkeleton(),
          };
    const briefContractHints =
      missingHeadings.length === 0
        ? []
        : [
            `This brief declares no ${missingHeadings.join(", ")}, so the dispatch contract will not count this child; re-dispatch with every heading (briefContract.skeleton is one MUON accepts).`,
          ];

    return ok(
      {
        jobId: job.id,
        status: job.status,
        kind,
        vendor,
        taskId,
        runnerLive: runner.live,
        runnerObserved,
        capabilityEvidence,
        briefContract,
        authority: {
          state: "delegated_work_only",
          control: "steer_or_interrupt_same_chat_job",
          forbidden: ["govern", "approve", "merge", "ship"],
        },
        coordination: {
          lane: vendor,
          taskId,
          runnerState: !runnerObserved
            ? "unknown"
            : runner.live
              ? "live"
              : "offline",
        },
        note: !runnerObserved
          ? "queued; runner observation timed out or failed after admission. The child job exists. Verify it with dispatch_status instead of retrying dispatch."
          : runner.live
            ? "queued, the runner claims a fleet agent (per-vendor 0–3 cap) and executes in the task's workspace. Watch with read_stream (taskId) or dispatch_status (jobId); steer/interrupt by jobId."
            : "queued, but NO runner is live yet, it will run as soon as one comes online (start with `muon runner`, or the desktop app auto-starts one).",
      },
      {
        evidence: {
          bounded: true,
          limit: 1,
          included: capabilityEvidence.status === "verified" ? 1 : 0,
          omitted: 0,
          kind: "vendor capability observation",
        },
        coordination: {
          lane: vendor,
          runnerState: !runnerObserved
            ? "unknown"
            : runner.live
              ? "live"
              : "offline",
        },
        degradation:
          capabilityEvidence.status === "unavailable"
            ? {
                active: true,
                reason: capabilityEvidence.reason,
                action: capabilityEvidence.action,
              }
            : !runnerObserved
              ? {
                  active: true,
                  reason:
                    "runner observation timed out or failed after the child job was admitted",
                  action:
                    "Do not retry dispatch. Check the admitted job with dispatch_status.",
                }
              : !runner.live
                ? {
                    active: true,
                    reason:
                      "no live runner is available to claim the queued job",
                    action:
                      "Start `muon runner` or open the desktop app, then check dispatch_status.",
                  }
                : { active: false },
        nextActions: [
          ...(runnerObserved && runner.live
            ? [
                `Call dispatch_status with jobId '${job.id}'.`,
                `Tail read_stream with taskId '${taskId}'.`,
              ]
            : !runnerObserved
              ? [
                  `Call dispatch_status with admitted jobId '${job.id}'; do not retry dispatch.`,
                ]
              : [
                  "Start `muon runner` or open the desktop app.",
                  `Then call dispatch_status with jobId '${job.id}'.`,
                ]),
          ...briefContractHints,
        ],
      }
    );
  };

  const tools: ToolDefinition[] = [
    {
      name: "assign_roles",
      description:
        "Decide what each agent on this crew is FOR. MUON — not the vendor — assigns the role, and a role is a NARROWING: it can remove tools, tighten the sandbox, and lower the permission mode, never the reverse. A reviewer handed a full-auto lane becomes read-only. Scoped to THIS chat; pin a role to a vendor when you want an adversarial reviewer on a different vendor than the author. Roles the HUMAN pinned survive your reassignment — a binding that comes back with assignedBy 'human' was the operator's choice, not yours. This is the COMMIT: until it runs, crew_roles reports the crew as 'proposed' and nobody is actually bound. Returns each binding with a fit score and MUON's reason, plus any role no available lane could hold.",
      inputSchema: {
        type: "object",
        properties: {
          roles: {
            type: "array",
            maxItems: AGENT_ROLES.length,
            items: { type: "string", enum: [...AGENT_ROLES] },
            description:
              "The roles this mission needs. Omit to let MUON size the crew from the available lanes.",
          },
          pin: {
            type: "array",
            maxItems: AGENT_ROLES.length,
            items: {
              type: "object",
              properties: {
                role: { type: "string", enum: [...AGENT_ROLES] },
                vendor: { type: "string", maxLength: 64 },
              },
              required: ["role", "vendor"],
              additionalProperties: false,
            },
            description:
              "Force a role onto a specific vendor. A pin selects WHICH lane holds the role; it can never lift that role's authority ceiling.",
          },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        // The orchestrator assigns roles for its OWN chat only; there is no
        // chat argument, so a coordinator cannot re-crew someone else's mission.
        if (!scope.chatId) {
          return fail(
            "no chat in scope; role assignment is bound to the orchestrator's own chat"
          );
        }
        const rawRoles = args.roles;
        if (
          rawRoles !== undefined &&
          (!Array.isArray(rawRoles) ||
            rawRoles.length > AGENT_ROLES.length ||
            rawRoles.some((role) => !AGENT_ROLES.includes(role as AgentRole)))
        ) {
          return fail(`roles must contain only ${AGENT_ROLES.join("|")}`);
        }
        const rawPins = args.pin;
        const pinned: RolePin[] = [];
        if (rawPins !== undefined) {
          if (!Array.isArray(rawPins) || rawPins.length > AGENT_ROLES.length) {
            return fail(
              `pin must contain at most ${AGENT_ROLES.length} {role, vendor} entries`
            );
          }
          for (const entry of rawPins) {
            const pin = (entry ?? {}) as Record<string, unknown>;
            const role = String(pin.role ?? "");
            const vendor = String(pin.vendor ?? "").trim();
            if (!AGENT_ROLES.includes(role as AgentRole) || !vendor) {
              return fail(
                `each pin needs a role (${AGENT_ROLES.join("|")}) and a vendor`
              );
            }
            pinned.push({ role: role as AgentRole, vendor });
          }
        }

        const plan = await assignCrewRoles({
          apiBase: scope.apiBase,
          apiToken: scope.apiToken,
          chatId: scope.chatId,
          ...(rawRoles === undefined
            ? {}
            : { roles: rawRoles as AgentRole[] }),
          ...(rawPins === undefined ? {} : { pinned }),
        });
        const blocked = plan.bindings.filter((binding) => binding.blocked);
        // Human pins survive an agent-initiated reassignment. Name them so the
        // coordinator reports "the operator pinned this" instead of claiming it
        // chose a binding it did not.
        const humanPinned = plan.bindings.filter(
          (binding) => binding.assignedBy === "human"
        );
        return ok(
          {
            bindings: plan.bindings.map((binding) => ({
              role: binding.role,
              vendor: binding.vendor,
              fit: binding.fit,
              reason: binding.reason,
              assignedBy: binding.assignedBy,
              authority: ROLE_SPECS[binding.role].authority,
              blocked: binding.blocked,
              ...(binding.blockedReason
                ? { blockedReason: binding.blockedReason }
                : {}),
            })),
            unfilled: plan.unfilled,
            humanPinned: humanPinned.map((binding) => binding.role),
            // `crew_roles` distinguishes an ASSIGNED plan from the PROPOSED one
            // the read computes for an unbound chat. This call is the commit, so
            // it says so explicitly rather than leaving the coordinator to infer
            // which kind of plan it is now holding.
            planStatus: "assigned",
            note: "ASSIGNED — this crew is now stored for the chat and replaces any proposed plan crew_roles was previewing. A role only narrows a lane. Dispatch each worker on the vendor its role was bound to; the runner refuses to launch a lane wider than its role. Any binding with assignedBy 'human' was pinned by the operator and was preserved, not chosen by you — report it that way.",
          },
          {
            evidence: {
              bounded: true,
              limit: AGENT_ROLES.length,
              included: plan.bindings.length,
              omitted: 0,
              kind: "crew role bindings",
            },
            coordination: {
              crewSize: plan.bindings.length,
              unfilled: plan.unfilled.length,
              blocked: blocked.length,
              humanPinned: humanPinned.length,
              state:
                plan.unfilled.length > 0 || blocked.length > 0
                  ? "attention"
                  : "clear",
            },
            degradation:
              plan.unfilled.length > 0
                ? {
                    active: true,
                    reason: `no available lane can hold: ${plan.unfilled.join(", ")}`,
                    action:
                      "Resize or connect a vendor with the required capabilities, or plan the mission without those roles.",
                  }
                : blocked.length > 0
                  ? {
                      active: true,
                      reason: blocked
                        .map(
                          (binding) =>
                            `${binding.role}/${binding.vendor}: ${
                              binding.blockedReason ?? "lane cannot hold this role"
                            }`
                        )
                        .join("; ")
                        .slice(0, 300),
                      action:
                        "Fix the reported lane state (see capability_preflight) or pin the role to another vendor.",
                    }
                  : { active: false },
            nextActions: [
              "Dispatch each role to the vendor it was bound to.",
              ...(humanPinned.length > 0
                ? [
                    `Operator-pinned and preserved: ${humanPinned
                      .map((binding) => `${binding.role}=${binding.vendor}`)
                      .join(", ")}. Report these as the human's choice.`,
                  ]
                : []),
              ...(plan.unfilled.length > 0
                ? [`Unfilled roles: ${plan.unfilled.join(", ")}.`]
                : []),
            ],
          }
        );
      },
    },
    {
      name: "fleet_status",
      description:
        "The whole crew at a glance: fleet counts per vendor and every agent instance with status (idle/working), current task, and session id. `parallelCapacity` is how many of a vendor's agents can run AT THE SAME TIME (its seats) and how many are free right now — a fan-out wider than that queues instead of running in parallel.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const [fleet, capabilities] = await Promise.all([
          client.getFleet(),
          readFleetCapabilities(client),
        ]);
        const agents = fleet.agents.slice(0, FLEET_AGENT_LIMIT);
        // Stated, not implied. `counts` already carries the per-vendor total,
        // but the coordinator's question is "how many of these can run at
        // once", and it planned a 3-way parallel crew against a one-seat lane
        // because nothing on this surface answered it.
        const parallelCapacity = FLEET_VENDORS.map((vendor) => {
          const seats = agents.filter((agent) => agent.vendor === vendor);
          const idle = seats.filter((agent) => agent.status === "idle").length;
          return {
            vendor,
            seats: seats.length,
            idleSeats: idle,
            maxConcurrentChildren: Math.min(
              seats.length,
              DELEGATION_MAX_CHILDREN
            ),
            serializesAtFullFanout: seats.length < DELEGATION_MAX_CHILDREN,
          };
        });
        return ok(
          {
            ...fleet,
            agents,
            parallelCapacity,
            capabilities,
          },
          {
            evidence: {
              bounded: true,
              limit: CAPABILITY_VENDOR_LIMIT,
              included: capabilities.vendors.length,
              omitted: capabilities.omitted,
              kind: "vendor capability observations",
            },
            degradation:
              capabilities.status === "unavailable"
                ? {
                    active: true,
                    reason: capabilities.reason,
                    action: capabilities.action,
                  }
                : { active: false },
            nextActions: [
              ...(capabilities.status === "unavailable"
                ? [capabilities.action]
                : capabilities.vendors
                    .filter((vendor) => !vendor.dispatchReady)
                    .map(
                      (vendor) =>
                        `${vendor.vendor}: ${vendor.action ?? vendor.detail}`
                    )),
              // The queueing the founder's run hit invisibly, said out loud.
              ...parallelCapacity
                .filter((entry) => entry.serializesAtFullFanout)
                .map(
                  (entry) =>
                    `${entry.vendor}: ${entry.seats} seat(s), so at most ${entry.maxConcurrentChildren} of its children run at once — a wider fan-out on this vendor QUEUES. Split the crew across vendors or plan that many.`
                ),
            ],
          }
        );
      },
    },
    {
      name: "set_fleet",
      description:
        "Resize the fleet (0–3 instances per vendor). HUMAN-GATED: without an approved approvalId this files an approval into the inbox and returns pending, call again with the approvalId once the human approves (check with check_approval).",
      inputSchema: {
        type: "object",
        properties: {
          counts: {
            type: "object",
            properties: Object.fromEntries(
              FLEET_VENDORS.map((vendor) => [vendor, { type: "number" }])
            ),
          },
          approvalId: { type: "string" },
        },
        required: ["counts"],
      },
      handler: async (args) => {
        const counts = (args.counts ?? {}) as Record<string, number>;
        // The gate binds the EXACT counts; a later call with different counts
        // and the same approvalId will not match this tag at the route.
        const tag = fleetGateTag(counts);
        if (args.approvalId) {
          // Forward the id, the ROUTE redeems (atomic single-use) and applies.
          // A 403 means the gate was used / unapproved / mismatched / non-gate.
          try {
            const fleet = await client.setFleet(counts, String(args.approvalId));
            return ok({ applied: true, ...fleet });
          } catch (error) {
            return fail(gateRouteError(error));
          }
        }
        if (!scope.chatTaskId) {
          return fail(
            "no chat task in scope, ask the human to resize with `muon fleet set`"
          );
        }
        const approval = await client.requestApproval({
          taskId: scope.chatTaskId,
          requestedBy: "muon-orchestrator",
          kind: "gate",
          reason: `${tag} super-agent requests fleet resize to ${canonicalCounts(counts)}`,
          gateTag: tag,
        });
        return ok({
          applied: false,
          status: "waiting_for_human",
          approvalId: approval.id,
          note: "tell the human an approval is waiting in the inbox; retry set_fleet with the SAME counts and this approvalId after they approve",
        });
      },
    },
    {
      name: "create_task",
      // S0: RENDERED from CREW_TASK_HEADINGS. This description happened to be
      // correct while `dispatch`'s drifted — luck, not a lock. The count and the
      // names now come from the array `missingTaskHeadings` counts.
      description:
        "Create a task in the shared ledger (one role/scope per task, so a crew maps cleanly onto tasks). The task carries the workspace folder agents will work in. " +
        `For a crew task the brief MUST declare ${CREW_TASK_HEADINGS.length} exact non-empty headings — ${taskHeadingList()} — because the dispatch contract reads them off this record and matches them against the child brief; prose without them is backlog that no dispatch can prove.`,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          brief: { type: "string", description: "Full description / brief" },
          priority: { type: "string", enum: ["low", "medium", "high"] },
          workspacePath: {
            type: "string",
            description: "Defaults to the chat's workspace",
          },
        },
        required: ["title", "brief"],
      },
      handler: async (args) => {
        const task = await client.createTask({
          title: String(args.title ?? ""),
          description: String(args.brief ?? ""),
          priority: (String(args.priority ?? "medium") || "medium") as
            | "low"
            | "medium"
            | "high",
          workspacePath:
            (args.workspacePath as string | undefined) ?? scope.workspacePath,
        });
        return ok({ task });
      },
    },
    {
      name: "list_tasks",
      description: "List ledger tasks (id, title, status, workspace).",
      inputSchema: {
        type: "object",
        properties: { status: { type: "string" } },
      },
      handler: async (args) => {
        const tasks = await client.listTasks();
        const filtered = args.status
          ? tasks.filter((task) => task.status === String(args.status))
          : tasks;
        return ok({
          tasks: filtered.slice(0, 30).map((task) => ({
            id: task.id,
            title: task.title,
            status: task.status,
            priority: task.priority,
            workspacePath: task.workspacePath ?? null,
            workflowRunId: task.workflowRunId ?? null,
          })),
        });
      },
    },
    {
      name: "dispatch",
      // S0: the heading LIST is RENDERED from the brief contract, never restated.
      // This description is the only artifact an externally launched coordinator
      // reads — it never sees ORCHESTRATOR_SYSTEM_PROMPT — and the hand-written
      // version drifted to ten of twelve headings (it omitted COORDINATION and
      // FINAL REPORT), so a session that followed it verbatim had every child
      // refused by the chat-turn verifier. `briefHeadingMandate()` is the SAME
      // renderer the system prompt uses, appended with the same `. ` boundary, so
      // ONE drift-lock parser reads both surfaces.
      description:
        "Send a sub-agent to work: enqueues a job for the persistent runner, which claims an idle fleet instance of the vendor (per-vendor 0–3 cap) and runs the brief in the task's workspace. Returns IMMEDIATELY with a jobId, the work runs in the background and survives across chat turns. mode 'auto' opens an interactive session for claude-code/codex (approvals fail closed into the inbox) and a one-shot for cursor; 'oneshot' forces one-shot; loop:true runs implement→check→repair with the harness checks. Monitor with read_stream or dispatch_status; interrupt by jobId. Live STEER (send a new instruction into the running session) works for codex only; claude-code is watch + interrupt (interrupt and re-dispatch to redirect it). Substantial work dispatches as a role-specialized crew (disjoint scopes; an adversarial reviewer on a different vendor than wrote the code), not one broad job; only a trivial ask is a single dispatch. The brief is a one-shot contract. " +
        `${briefHeadingMandate()}. ROLE and OWNED SCOPE are the two MUON compares against the filed task — repeat that task's declarations verbatim, and note that a brief opening with GOAL: instead declares no ROLE and does not count. GRAPH DISCIPLINE means code_query FIRST — before any file read or grep; code_context to confirm named symbols; atomic preflight_edit with exact target + filePath before edits. A heading may carry its content on the same line or in the block beneath it; an empty one counts as missing, and the \`brief\` argument's own description quotes one compliant brief verbatim. ` +
        "After dispatch: poll dispatch_status until terminal, tail read_stream with the previous nextAfterSeq, then read the typed packet via handoff_read; report a milestone after each check. Jobs survive turns; you do not — reconcile at every turn start.",
      inputSchema: {
        type: "object",
        properties: {
          vendor: {
            type: "string",
            enum: [...VENDORS],
            // WAVE E (ADR-0022 §5): RENDERED from the registry, not written.
            // The sentence this replaces named `claude-code` as the default
            // implementer and recommended `cursor` for triage — advice the role
            // ceiling contradicts, since cursor cannot hold a write role at all.
            // It also disagreed with the orchestrator system prompt, which is
            // the §1.2(i) finding. Both surfaces read this one renderer now, so
            // a new vendor appears in both with no edit and none is named as a
            // default.
            description: vendorRoutingBrief(),
          },
          taskId: { type: "string" },
          brief: {
            type: "string",
            // The argument the whole dispatch contract is about, and it carried
            // NO description at all — the contract only existed in the tool
            // description, which is exactly where it drifted. Rendered from the
            // one contract, and the compliant skeleton is quoted so a
            // coordinator never spends a corrective round guessing the shape.
            description:
              `${briefHeadingMandate()}. A heading may carry its content on the same line or in the block beneath it; an empty one counts as missing. ROLE and OWNED SCOPE must repeat the filed task's declarations verbatim. One compliant brief:\n` +
              childBriefSkeleton(),
          },
          role: {
            type: "string",
            enum: [...AGENT_ROLES],
            description:
              "The crew role this worker runs as. Omit to inherit the chat's crew plan (crew_roles), else the harness decides. A role only NARROWS: a read-only role (reviewer/qa/architect/scout) loses every write tool, and a vendor is refused a role it cannot hold — cursor and opencode are managed for part of the taxonomy only.",
          },
          harnessKey: {
            type: "string",
            description: "implement | review | security-audit | repair | custom",
          },
          mode: { type: "string", enum: ["auto", "oneshot", "session"] },
          loop: { type: "boolean" },
          maxWallMs: {
            type: "number",
            description:
              "Optional wall-clock budget (ms) for this child. Omit to take a right-sized share of the root pool; an explicit value is re-checked against the parent/root caps.",
          },
          model: {
            type: "string",
            description:
              "Optional model override for this worker (e.g. 'opus' for an architect, 'haiku' for a sweeper). Prefer a known id; MUON validates it against the vendor and refuses an invalid/unsupported id, an unknown-but-allowed id passes.",
          },
        },
        required: ["vendor", "taskId", "brief"],
      },
      handler: dispatchAgent,
    },
    {
      name: "read_stream",
      description:
        "Watch one sub-agent dispatch from this chat: replay/tail its output stream by immutable jobId. Pass afterSeq from the previous call to tail.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string" },
          afterSeq: { type: "number" },
        },
        required: ["jobId"],
      },
      handler: async (args) => {
        const jobId = String(args.jobId ?? "").trim();
        if (!jobId) {
          return fail("jobId is required");
        }
        const scopeError = await assertJobInScope(client, scope, jobId);
        if (scopeError) {
          return fail(scopeError);
        }
        const chunks = await client.listStreamChunks({
          runId: jobId,
          afterSeq: (args.afterSeq as number | undefined) ?? 0,
          limit: 100,
        });
        return ok({
          nextAfterSeq: chunks.length > 0 ? chunks[chunks.length - 1].seq : (args.afterSeq ?? 0),
          lines: chunks.map((chunk) => `[${chunk.kind}] ${chunk.content}`),
        });
      },
    },
    {
      name: "dispatch_status",
      description:
        "Check dispatched sub-agent jobs. Pass a jobId for one job's status (queued/running/done/failed/interrupted, exit code, result tail); omit it to list this chat's recent jobs (optionally filter by status or taskId).",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string" },
          taskId: { type: "string" },
          status: {
            type: "string",
            enum: ["queued", "running", "done", "failed", "interrupted"],
          },
        },
      },
      handler: async (args) => {
        if (args.jobId) {
          const scopeError = await assertJobInScope(
            client,
            scope,
            String(args.jobId)
          );
          if (scopeError) {
            return fail(scopeError);
          }
          const job = await client
            .getDispatchJob(String(args.jobId))
            .catch(() => null);
          if (!job) {
            return fail(`no dispatch job '${String(args.jobId)}'`);
          }
          const loopStatus = await readLoopStatus(client, job.taskId);
          const loops = loopStatus.loops;
          const unavailable = loopStatus.unavailable;
          const degraded = firstLoopDegradation(loops);
          return ok(
            {
              // ONE job by id = "what did this worker say", so it carries the
              // report-sized tail, not the roster-sized one.
              job: dispatchSummary(job, DISPATCH_DETAIL_RESULT_CHARS),
              loops,
              loopEvidence: unavailable
                ? {
                    status: "unavailable",
                    reason: unavailable,
                    action:
                      "Use read_stream now; run `muon doctor` before relying on evaluator coverage.",
                  }
                : { status: "available" },
            },
            {
              evidence: {
                bounded: true,
                limit: LOOP_LIMIT,
                included: loops.length,
                omitted: 0,
                kind: "loop/evaluator summaries",
              },
              degradation: unavailable
                ? {
                    active: true,
                    reason: unavailable,
                    action:
                      "Use read_stream now; run `muon doctor` before relying on evaluator coverage.",
                  }
                : degraded
                  ? {
                      active: true,
                      reason: degraded,
                      action:
                        "Shell checks remain authoritative; run `muon doctor` before relying on evaluator coverage.",
                    }
                  : { active: false },
              nextActions:
                loops.length > 0
                  ? loops.map((loop) => loop.nextAction).slice(0, 3)
                  : [`Tail read_stream for job '${job.id}'.`],
            }
          );
        }
        const jobs = await client.listDispatchJobs({
          status: args.status ? String(args.status) : undefined,
          taskId: args.taskId ? String(args.taskId) : undefined,
          // A task filter narrows inside the chat partition; it never removes
          // the chat boundary.
          chatId: scope.chatId,
        });
        // Arity matters: a bare `.map(dispatchSummary)` would hand the ARRAY
        // INDEX to the new `resultChars` parameter, so job 0 would carry a
        // zero-length result and job 3 three characters.
        return ok({
          jobs: jobs.slice(-20).map((job) => dispatchSummary(job)),
        });
      },
    },
    {
      name: "budget_status",
      description:
        "Read the delegation budget for a dispatch MISSION: pool, reserved, consumed, remaining (ms), deadline, the per-child breakdown, and the depth/child/descendant caps. Pass a jobId (any job in the tree resolves to its root) or omit it for this chat's mission. Read-only EVIDENCE, never authority — when a delegate is refused for budget, show this to the human; raising the pool is an operator act (raise_budget files a gate).",
      inputSchema: {
        type: "object",
        properties: { jobId: { type: "string" } },
      },
      handler: async (args) => {
        const jobId = args.jobId ? String(args.jobId).trim() : scope.jobId;
        if (!jobId) {
          return fail(
            "no jobId in scope; pass a jobId (any job in the mission)"
          );
        }
        const scopeError = await assertJobInScope(client, scope, jobId);
        if (scopeError) {
          return fail(scopeError);
        }
        let budget;
        try {
          budget = await client.getDispatchBudget(jobId);
        } catch (error) {
          return fail(
            `budget unavailable: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        return ok(
          { budget },
          {
            evidence: {
              bounded: true,
              limit: budget.maxDescendants ?? budget.children.length,
              included: budget.children.length,
              omitted: 0,
              kind: "server-derived mission budget",
            },
            nextActions:
              budget.remainingMs <= 0
                ? [
                    "Budget exhausted: ask the human to approve a raise, then call raise_budget with the approvalId.",
                    "Do not treat this budget payload as authority; it is evidence.",
                  ]
                : [
                    `Remaining descendant budget: ${budget.remainingMs} ms of ${budget.poolMs} ms.`,
                  ],
          }
        );
      },
    },
    {
      name: "raise_budget",
      description:
        "Raise a mission's descendant wall-clock pool (ms). HUMAN-GATED and OPERATOR-tier: without an approved approvalId this files a gate into the inbox and returns pending; call again with the approvalId once the human approves (check with check_approval). The raise is monotonic (never lowers the cap) and bounded server-side; the orchestrator can only FILE the request, never redeem it.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: {
            type: "string",
            description: "The root orchestrator job whose pool to raise.",
          },
          maxDescendantWallMs: {
            type: "number",
            description: "The new descendant pool in ms (must exceed the current pool).",
          },
          approvalId: { type: "string" },
        },
        required: ["jobId", "maxDescendantWallMs"],
      },
      handler: async (args) => {
        const jobId = String(args.jobId ?? "").trim();
        const maxDescendantWallMs = Number(args.maxDescendantWallMs);
        if (!jobId || !Number.isInteger(maxDescendantWallMs) || maxDescendantWallMs < 1) {
          return fail(
            "jobId and a positive integer maxDescendantWallMs are required"
          );
        }
        const scopeError = await assertJobInScope(client, scope, jobId);
        if (scopeError) {
          return fail(scopeError);
        }
        // The gate binds the EXACT job + pool; a later call with a different
        // amount and the same approvalId will not match this tag at the route.
        const tag = budgetRaiseGateTag(jobId, maxDescendantWallMs);
        if (args.approvalId) {
          // Forward the id, the ROUTE redeems (atomic single-use) and applies.
          try {
            const budget = await client.raiseDispatchBudget(jobId, {
              maxDescendantWallMs,
              gateApprovalId: String(args.approvalId),
            });
            return ok({ applied: true, budget });
          } catch (error) {
            return fail(gateRouteError(error));
          }
        }
        if (!scope.chatTaskId) {
          return fail(
            "no chat task in scope, ask the human to raise the budget with `muon` (operator)"
          );
        }
        const approval = await client.requestApproval({
          taskId: scope.chatTaskId,
          requestedBy: "muon-orchestrator",
          kind: "gate",
          reason: `${tag} super-agent requests a delegation-budget raise to ${maxDescendantWallMs} ms`,
          gateTag: tag,
        });
        return ok({
          applied: false,
          status: "waiting_for_human",
          approvalId: approval.id,
          note: "tell the human an approval is waiting in the inbox; retry raise_budget with the SAME jobId + amount and this approvalId after they approve",
        });
      },
    },
    {
      name: "steer",
      description:
        "Send a follow-up instruction into a running codex session by jobId (mode 'session' or 'auto'). It is queued to the job and delivered by the runner on its next poll, so it works across chat turns. claude-code CANNOT be live-steered (its SDK session driver has no send channel) — the backend rejects a steer to it; interrupt and re-dispatch instead. One-shot, loop, and cursor jobs also have no live channel.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string" },
          message: { type: "string" },
        },
        required: ["jobId", "message"],
      },
      handler: async (args) => {
        const jobId = String(args.jobId ?? "").trim();
        const message = String(args.message ?? "").trim();
        if (!jobId || !message) {
          return fail("jobId and a non-empty message are required");
        }
        // Defense-in-depth: only steer jobs dispatched from THIS chat.
        const scopeError = await assertJobInScope(client, scope, jobId);
        if (scopeError) {
          return fail(scopeError);
        }
        try {
          await client.steerDispatchJob(jobId, message, {
            callerJobId: scope.jobId!,
            delegationToken: scope.delegationToken!,
          });
          return ok({
            steered: true,
            note: "queued to the job; the runner delivers it to the live session on its next poll",
          });
        } catch (error) {
          return fail(
            error instanceof Error ? error.message : "steer failed"
          );
        }
      },
    },
    {
      name: "interrupt",
      description:
        "Interrupt an active MUON dispatch by jobId. The runner propagates cancellation to interactive sessions, loops, and one-shot jobs; queued jobs terminate immediately. Cancellation works across chat turns and propagates through the selected delegation subtree.",
      inputSchema: {
        type: "object",
        properties: { jobId: { type: "string" } },
        required: ["jobId"],
      },
      handler: async (args) => {
        const jobId = String(args.jobId ?? "").trim();
        if (!jobId) {
          return fail("jobId is required");
        }
        const scopeError = await assertJobInScope(client, scope, jobId);
        if (scopeError) {
          return fail(scopeError);
        }
        try {
          await client.interruptDispatchJob(jobId, {
            callerJobId: scope.jobId!,
            delegationToken: scope.delegationToken!,
          });
          return ok({
            interrupted: true,
            note: "flagged; the runner propagates cancellation to the active execution and its delegated subtree",
          });
        } catch (error) {
          return fail(
            error instanceof Error ? error.message : "interrupt failed"
          );
        }
      },
    },
    {
      name: "propose_workflow",
      description:
        "Draft a multi-step plan (workflow proposal) from a request. Stored INERT, the human applies it (or you call apply_workflow after they approve).",
      inputSchema: {
        type: "object",
        properties: {
          request: { type: "string" },
          workspacePath: { type: "string" },
        },
        required: ["request"],
      },
      handler: async (args) => {
        const request = String(args.request ?? "");
        const proposal = heuristicWorkflowProposal(request);
        for (const step of proposal.steps) {
          if (step.role === "suggest" && !step.laneKey) {
            const suggestions = await client
              .suggestLanes(undefined, `${step.title} ${step.brief}`)
              .catch(() => []);
            const top = suggestions[0];
            if (top) {
              step.laneKey = top.laneKey;
              step.laneReason = top.reason;
            }
          }
        }
        const run = await client.createWorkflowRun(
          {
            request,
            workspacePath:
              (args.workspacePath as string | undefined) ?? scope.workspacePath,
            chatId: scope.chatId,
            proposal,
            proposedBy: "muon-orchestrator",
          },
          workflowControl
        );
        return ok({
          runId: run.id,
          status: run.status,
          steps: proposal.steps.map((step) => ({
            stepKey: step.stepKey,
            title: step.title,
            laneKey: step.laneKey ?? step.role,
          })),
          note: "inert until applied, ask the human, or apply_workflow with an approved approvalId",
        });
      },
    },
    {
      name: "apply_workflow",
      description:
        "Apply a proposed workflow run (steps become tasks). HUMAN-GATED like set_fleet: without an approved approvalId this files the approval and returns pending.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          approvalId: { type: "string" },
        },
        required: ["runId"],
      },
      handler: async (args) => {
        const runId = String(args.runId ?? "");
        // The gate binds this exact runId; the same approval cannot apply a
        // different run at the route.
        const tag = applyWorkflowGateTag(runId);
        if (args.approvalId) {
          // Forward the id, the ROUTE redeems (atomic single-use) and applies.
          try {
            const applied = await client.applyWorkflowRun(
              runId,
              "human",
              String(args.approvalId),
              workflowControl
            );
            return ok({
              applied: true,
              runId,
              tasks: applied.tasks.map((task) => ({
                id: task.id,
                stepKey: task.stepKey,
                title: task.title,
              })),
            });
          } catch (error) {
            return fail(gateRouteError(error));
          }
        }
        if (!scope.chatTaskId) {
          return fail(
            "no chat task in scope, ask the human to apply with `muon workflow apply`"
          );
        }
        const approval = await client.requestApproval({
          taskId: scope.chatTaskId,
          requestedBy: "muon-orchestrator",
          kind: "gate",
          reason: `${tag} super-agent requests APPLY of workflow run ${runId}`,
          gateTag: tag,
        });
        return ok({
          applied: false,
          status: "waiting_for_human",
          approvalId: approval.id,
        });
      },
    },
    {
      name: "workflow_status",
      description: "A workflow run's steps with each step task's status.",
      inputSchema: {
        type: "object",
        properties: { runId: { type: "string" } },
        required: ["runId"],
      },
      handler: async (args) => {
        const detail = await client.getWorkflowRun(
          String(args.runId ?? ""),
          workflowControl
        );
        return ok({
          run: {
            id: detail.run.id,
            status: detail.run.status,
            summary: detail.run.proposal.summary,
            workspacePath: detail.run.workspacePath ?? null,
          },
          steps: detail.run.proposal.steps.map((step) => {
            const task = detail.tasks.find(
              (entry) => entry.stepKey === step.stepKey
            );
            return {
              stepKey: step.stepKey,
              laneKey: step.laneKey ?? step.role,
              taskId: task?.id ?? null,
              status: task?.status ?? "not-applied",
            };
          }),
        });
      },
    },
    {
      name: "ship",
      description:
        "File the merge gate for a task (the final human checkpoint). The task cannot reach done until the human approves it, this tool never ships by itself.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          summary: { type: "string", description: "What was done / checked" },
        },
        required: ["taskId", "summary"],
      },
      handler: async (args) => {
        const approval = await client.requestApproval({
          taskId: String(args.taskId ?? ""),
          requestedBy: "muon-orchestrator",
          kind: "merge",
          reason: `ship review requested by the super-agent: ${String(args.summary ?? "").slice(0, 300)}`,
        });
        return ok({
          filed: true,
          approvalId: approval.id,
          note: "waiting on the human's ship review",
        });
      },
    },
    {
      name: "check_approval",
      description: "Check the status of an approval you filed.",
      inputSchema: {
        type: "object",
        properties: { approvalId: { type: "string" } },
        required: ["approvalId"],
      },
      handler: async (args) => {
        const approvals = await client.listApprovals();
        const approval = approvals.find(
          (entry) => entry.id === String(args.approvalId)
        );
        if (!approval) {
          return fail("approval not found");
        }
        return ok({
          id: approval.id,
          status: approval.status,
          kind: approval.kind,
        });
      },
    },
  ];
  return withAgentUi(tools, {
    principal: options.principal ?? "orchestrator",
    taskScoped: Boolean(scope.chatTaskId),
    laneScoped: false,
    chatScoped: Boolean(scope.chatId),
  });
}
