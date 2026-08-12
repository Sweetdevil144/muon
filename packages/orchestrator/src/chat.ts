import type {
  DispatchJobRecord,
  FleetReadinessReport,
  FleetSnapshot,
  MuonApiClient,
  OrchestratorChatRecord,
  StreamChunkDetail,
  TaskDetail,
} from "@muon/client";
import {
  coordinatorVendorIds,
  defaultCoordinatorVendor,
  sessionCapability,
  type VendorId,
} from "@muon/protocol";
import {
  briefHeadingList,
  childBriefSkeleton,
  declaredHeadings,
  headingValue,
  missingBriefHeadings,
  missingTaskHeadings,
  taskHeadingList,
} from "./brief-contract.js";
import {
  FULL_AUTO_ORCHESTRATOR_BLOCK,
  ORCHESTRATOR_SYSTEM_PROMPT,
  ORCHESTRATOR_TURN_PREAMBLE,
} from "./system-prompt.js";

/**
 * One chat turn with the super-orchestrator. Each turn is a durable session
 * dispatch: the persistent runner resumes the vendor session, compiles the
 * deny-first orchestrator MCP profile, and persists every turn as StreamChunks
 * keyed by the chat id, so CLI, TUI, and desktop share one authority path.
 *
 * Safety: the runner owns the managed-session ledger. Any tool call outside the
 * exact MUON orchestrator allowlist pauses into the human inbox, fail closed.
 */

/**
 * A dispatched worker job reaching terminal (done/failed) while the
 * orchestrator's session was idle (S4 durable-nudge). `result` is untrusted
 * agent-produced data, so it rides tail-only inside a typed JSON envelope
 * (payload-is-data, mirrors <human_request>), never as prose the turn obeys.
 */
export type JobTerminalEvent = {
  jobId: string;
  taskId: string;
  status: string;
  exitCode: number | null;
  resultTail: string;
  /**
   * The mission roster at wake time: MUON's OWN ledger rows for this chat's
   * governed children, so the continuation turn can say WHICH children finished
   * and where each final report lives instead of naming only the one job whose
   * terminal event happened to fire.
   *
   * Ledger facts, not agent text — jobId/taskId/vendor/status all come from the
   * DispatchJob rows, so this rides in the TRUSTED control block while the
   * untrusted `resultTail` stays inside the JSON envelope. Optional so a caller
   * that cannot read the roster (or an older surface) still nudges with the one
   * event, exactly as before.
   */
  mission?: MissionRoster;
};

/** This chat's governed children, split by whether they are still working. */
export type MissionRoster = {
  finished: Array<{
    jobId: string;
    taskId: string;
    vendor: string;
    status: string;
  }>;
  /** How many governed children of this mission are still queued/running. */
  live: number;
};

export type ChatTurnInput = {
  client: MuonApiClient;
  chat: OrchestratorChatRecord;
  message: string;
  apiBase: string;
  apiToken?: string;
  approvalTimeoutMs?: number;
  /** Root coordinator wall cap; omitted keeps the interactive 30-minute default. */
  maxWallMs?: number;
  /** Aggregate descendant wall cap; omitted keeps the fleet-sized default. */
  maxDescendantWallMs?: number;
  /**
   * S4: when set, this turn is a DURABLE reconciliation nudge fired because a
   * worker job reached terminal while the orchestrator was idle — not a human
   * message. The turn skips the human-only `[you]` milestone + chat titling and
   * delivers the typed <job_terminal_event> envelope instead of <human_request>.
   * The caller writes the `[event] job <id> terminal` dedupe milestone first.
   */
  event?: JobTerminalEvent;
  /**
   * Which managed vendor seats the super-orchestrator for this turn. Must have
   * a reserved coordinator agent (ordinal 0). Omitted → CHAT_LANE_KEY.
   */
  vendor?: OrchestratorLaneKey;
  /**
   * S10: the chat-level DEFAULT model the super-orchestrator runs this turn on
   * ("the model to use during orchestration"). Threaded onto the session
   * dispatch as the `model` override, which the route validates FAIL-CLOSED
   * against the execution vendor (S6, `validateModelForVendor`) before it can
   * reach vendor argv, then persists as a merged `actionProfilePatch: {model}`.
   * Omitted → today's behavior (the lane's stored profile model). This is a
   * DEFAULT the orchestrator applies to its own turn; per-dispatch worker model
   * choices remain the super-agent's own `dispatch(model=…)` lever (S6).
   */
  model?: string;
  /**
   * Reasoning effort for this orchestrator turn (`--effort` / Codex
   * `model_reasoning_effort`). Applied via the vendor `effort` action so the
   * dispatch route remains the fail-closed compiler. Omitted → lane default.
   */
  effort?: string;
  /**
   * Full-Auto active: append the FULL-AUTO safety block to this turn's brief so
   * the orchestrator operates conservatively with the gates auto-approved.
   * Threaded from the desktop (operator tier) per turn; omitted → today's brief
   * exactly, byte-identical.
   */
  fullAuto?: boolean;
  /** Streaming assistant output plus its explicit provider boundary. */
  onAssistantText?: (text: string, mode: "delta" | "message") => void;
  /**
   * Gate notifications (approval filed by the super-agent's own tool use).
   *
   * U4: `detail` rides along so a LIVE turn's tool cards can show the same
   * bounded args/result a SETTLED turn already shows. Dropping it here was why
   * `mcp__muon__*` calls rendered as bare "started / completed" for exactly as
   * long as the coordinator was working. Already scrubbed by `redactedTail` on
   * the way in — consumers bound it for display and must NOT re-redact.
   */
  onStatus?: (line: string, detail?: StreamChunkDetail) => void;
  /**
   * Abort the turn's completion poll early. Used by the persistent runner when
   * it drains: a machine reconciliation turn it fired mid-poll must not keep the
   * process alive for the full 30-min budget. The dispatch stays runner-owned
   * and is reconciled by the next runner incarnation. Omitted by the human
   * surfaces (CLI/desktop), so their behavior is byte-identical.
   */
  signal?: AbortSignal;
};

/**
 * Wrap a terminal-job event as a typed JSON envelope for a nudge turn. The
 * untrusted `resultTail` is JSON-escaped inside the envelope, so it can only be
 * read as evidence — the orchestrator's trust boundary treats it as data. We
 * also escape `<` to `<` (still valid JSON, round-trips via JSON.parse) so
 * an injected `</job_terminal_event>` in worker output can never forge the
 * envelope boundary: the closing tag is unforgeable payload-side.
 */
export function buildJobTerminalEnvelope(event: JobTerminalEvent): string {
  // `mission` is deliberately NOT in here: it is MUON's own ledger, so it
  // belongs in the trusted control block. This envelope stays the untrusted
  // half — exactly the fields a worker's process produced.
  const { mission: _mission, ...payload } = event;
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<job_terminal_event encoding="json">${json}</job_terminal_event>`;
}

/**
 * The TRUSTED half of a wake turn: MUON telling the coordinator why it is
 * awake, which children finished, and which of the two endings this turn must
 * reach — the next already-filed dispatch, or the final mission summary.
 *
 * The founder's live symptom this exists for: two children finished, both
 * produced real work, and nothing ever collected it. The chat showed "Done"
 * while the crew was mid-flight, the queued Wave-2 reviewer was never
 * dispatched, and no summary was ever posted. A wake with no instruction is a
 * wake the coordinator answers with "the jobs are running" and goes idle again.
 *
 * Ledger data only (job/task ids, vendors, statuses). Worker prose stays in the
 * untrusted `<job_terminal_event>` envelope beside it.
 */
function jobTerminalContinuation(event: JobTerminalEvent): string {
  const roster: MissionRoster = event.mission ?? {
    finished: [
      {
        jobId: event.jobId,
        taskId: event.taskId,
        vendor: "unknown",
        status: event.status,
      },
    ],
    live: 0,
  };
  const encoded = JSON.stringify({
    // Bounded: the coordinator needs the shape of the crew, not every row.
    finished: roster.finished.slice(0, 12),
    live: roster.live,
  }).replace(/</g, "\\u003c");
  return [
    '<muon_control kind="job-terminal-continuation">',
    "MUON woke this chat: a governed child of this mission reached terminal while you were idle. This is a reconciliation turn, not a new human request.",
    "Reconcile first: dispatch_status, then handoff_read(taskId) for EVERY child listed as finished below — that typed packet is the child's final report.",
    "Then do exactly ONE of two things. (1) If filed work is now runnable — a sequential role whose dependsOn tasks have terminated, the queued reviewer, the verification pass — dispatch it now, and only it; never file a NEW crew for a NEW objective on this turn. (2) If nothing filed is runnable and no child is live, the mission is over: post the FINAL MISSION SUMMARY collecting every child's final report (role, vendor, jobId, what changed, checks and their results, graph queries run, uncertainties), then the mission verdict.",
    "Do not end this turn with only a status line. Silence here is how a finished crew's work reaches nobody.",
    `<mission_children encoding="json">${encoded}</mission_children>`,
    "</muon_control>",
  ].join("\n");
}

/**
 * The durable dedupe milestone a local surface writes to the chat lane the
 * first time it observes a job go terminal. The append-only stream is the CAS:
 * whichever surface writes it owns the reaction, so desktop + CLI never
 * double-nudge. `[event]`, never `[you]` — this is not a human message.
 */
export function jobTerminalMilestone(jobId: string): string {
  return `[event] job ${jobId} terminal`;
}

export type ChatTurnResult = {
  vendorSessionId?: string;
  exitCode: number;
  /** Set when the turn failed, the reason to show the human. */
  errorText?: string;
};

/**
 * Vendors that may run the super-orchestrator — the registry's
 * `authority.coordinatorSeat` column (ADR-0022 C3), never a copy of it.
 */
export const ORCHESTRATOR_LANE_KEYS: readonly VendorId[] = coordinatorVendorIds();
/**
 * Deliberately the whole namespace rather than `(typeof
 * ORCHESTRATOR_LANE_KEYS)[number]`: the boundary is the VALUE above, and the
 * backend re-checks the seat against the same column on every dispatch.
 */
export type OrchestratorLaneKey = VendorId;
/**
 * Default orchestrator lane when the operator has not chosen another vendor.
 *
 * WAVE E: the ordered OPERATOR preference (ADR-0022 §4), INTERSECTED with the
 * coordinator-seated set so a preference can never grant a seat. With the
 * shipped default it resolves to the same vendor registry order did, which is
 * why this is a no-op today and a lever tomorrow.
 */
export const CHAT_LANE_KEY: OrchestratorLaneKey = defaultCoordinatorVendor();
const CHAT_TURN_TIMEOUT_MS = 30 * 60_000;
const CHAT_POLL_MS = 250;
/** The bounded job window the dispatch contract may be judged within. */
const CHAT_JOB_WINDOW = 200;
/**
 * How long a FAILING contract verdict waits before re-reading durable state and
 * judging again. A check that can convict on ordering alone is not a check, so
 * every negative verdict is confirmed against current evidence first.
 */
const CONTRACT_RECHECK_DELAY_MS = 750;
const TERMINAL_STATUSES = new Set(["done", "failed", "interrupted"]);
const SUBSTANTIAL_MISSION_PATTERN =
  /\b(?:analy[sz]e|audit|build|codebase|combined|debug|design|end[- ]to[- ]end|fix|implement|investigate|migrat(?:e|ion)|refactor|repository|review|secur(?:e|ity)|test|understand)\b/i;
const EXPLICIT_SINGLE_AGENT_PATTERN =
  /\b(?:single[- ]agent|no (?:crew|subagents?)|without (?:a )?(?:crew|subagents?)|do not (?:dispatch|delegate|use (?:a )?(?:crew|subagents?)))\b/i;
/**
 * A codebase imperative in IMPERATIVE POSITION — turn start, sentence start, a
 * clause the human opened with "and"/"then"/"please", or an explicit "can you
 * …". POSITION, not vocabulary, is what separates "refactor the auth module"
 * (commissioning) from "why did the refactor fail" (asking). This is the only
 * signal allowed to override the retrospective exemption below, so it must mean
 * the human is asking for NEW work rather than merely uttering a mission word.
 *
 * The verb list is WIDER than `SUBSTANTIAL_MISSION_PATTERN` on purpose: "ship
 * the onboarding flow" commissions as much work as "refactor" does, and the
 * deleted length floor was the only thing that used to catch such a turn — and
 * then only if the human happened to type 160 characters. Widening here is
 * safe precisely because it is position-gated: "did you add the button?" says
 * `add` but never in imperative position. Two idioms are carved out because
 * they are retrieval, not work: "<verb> me" ("update me on the crew") and
 * "make sure" ("make sure you reconcile everything").
 */
const MISSION_IMPERATIVE_PATTERN =
  /(?:^|[.!?;:]\s*|\n\s*|,\s*(?:also\s+|and\s+|then\s+)?|\b(?:also|and|finally|first|next|now|please|then)\s+|\b(?:can|could|will|would)\s+you\s+(?:please\s+)?|\b(?:go\s+ahead\s+and|i(?:'d)?\s+(?:like|need|want)\s+you\s+to|let'?s)\s+)(add|analy[sz]e|assess|audit|build|clean|complete|create|debug|delete|deliver|design|diagnose|document|examine|explore|extend|extract|finish|fix|generate|harden|implement|improve|integrate|investigate|make(?!\s+sure\b)|migrate|moderni[sz]e|move|optimi[sz]e|polish|port|profile|refactor|remove|rename|repair|replace|research|review|rewrite|scaffold|secure|ship|split|survey|test|trace|triage|understand|update|upgrade|verify|wire|write)\b(?!\s+me\b)/i;
/**
 * The two imperative verbs above that AUTHOR a document instead of changing the
 * workspace. Everything else in that list commissions work on the code; these
 * two are ambiguous, because "write the migration" is a mission and "write down
 * what we found" is a report. Only the OBJECT tells them apart.
 */
const AUTHORING_IMPERATIVE_VERBS = new Set(["document", "write"]);
/**
 * The object of an authoring imperative when the thing being written down is the
 * mission's OWN accumulated knowledge — the crew's findings, or what this chat
 * already has in hand. Deliberately narrow: it keys on POSSESSION by the mission
 * ("what we got", "their results"), never on a bare crew noun, so "write the
 * dispatch route" stays a mission while "write all information we got" does not.
 */
const REPORTING_OBJECT_PATTERN =
  /\b(?:i|we|you)\s+(?:already\s+|just\s+)?(?:collected|discovered|found|gathered|got|have|know|learned|produced)\b|\b(?:already|earlier|previously|so far)\b|\b(?:its|their|these|those|the)\s+(?:findings?|handoffs?|outputs?|packets?|reports?|results?)\b|\b(?:agents?|crew|subagents?|workers?)'?s?\s+(?:findings?|outputs?|reports?|results?|work)\b/i;

/** Every codebase imperative in the turn, lowercased, in the order written. */
function missionImperativeVerbs(message: string): string[] {
  // A fresh global copy per call: a module-level `g` regex carries `lastIndex`
  // between turns, and a classifier that depends on call order is not a rule.
  const scan = new RegExp(MISSION_IMPERATIVE_PATTERN.source, "gi");
  return [...message.matchAll(scan)].map((match) => match[1]!.toLowerCase());
}

/**
 * Is this an imperative to REPORT ON work rather than to do work? True only when
 * EVERY imperative in the turn is an authoring verb AND the turn names the
 * mission's own accumulated knowledge as what to write down. One non-authoring
 * imperative ("…, then fix the login bug") re-arms the whole turn.
 */
function isReportingImperative(message: string, verbs: string[]): boolean {
  return (
    verbs.every((verb) => AUTHORING_IMPERATIVE_VERBS.has(verb)) &&
    REPORTING_OBJECT_PATTERN.test(message)
  );
}

/**
 * The interrogative/retrieval FORM of a turn that asks about work instead of
 * commissioning it.
 */
const RETROSPECTIVE_FORM_PATTERN =
  /\b(?:are|did|do|does|has|have|is|was|were)\s+(?:all|i|it|that|the|these|they|this|those|we|you)\b|\b(?:how|what|when|where|which|who|why)\s+(?:are|did|do|does|files|had|happened|has|have|is|was|went|were|you)\b|\b(?:describe|explain|list|recap|summari[sz]e)\b|\b(?:remind|show|tell|walk)\s+me\b/i;
/**
 * A reference to work that ALREADY EXISTS: the crew's nouns, an explicitly past
 * frame, or an outcome that has already happened. `jobs?`/`tasks?` is also how a
 * turn naming concrete ids ("job-abc123") matches. Deliberately NOT satisfied by
 * codebase nouns — "explain the codebase" names no prior work, so it stays a
 * mission, while "explain the crew results" does not.
 */
const PRIOR_WORK_REFERENCE_PATTERN =
  /\b(?:agents?|children|contract|crew|delegat\w*|dispatch\w*|handoff|jobs?|outputs?|reconcil\w*|reports?|results?|runs?|sessions?|subagents?|tasks?|workers?)\b|\b(?:already|earlier|previously|prior|so far)\b|\b(?:completed|crashed|errored|fail(?:ed|ing|ure)|finished|returned)\b/i;

type CoordinatorDispatchMode =
  | "crew-required"
  | "single-agent-allowed"
  | "not-applicable";

type CrewMissionShape = "change" | "assessment" | "research";

/**
 * Seat counts for the coordinator-seated lanes. `Partial` because the KEYS are
 * `ORCHESTRATOR_LANE_KEYS` (a runtime registry projection) rather than a literal
 * union the compiler can total — every reader below therefore states its own
 * `?? 0`, which is the honest reading of "this lane has no seats".
 */
type CoordinatorSeatCounts = Partial<Record<VendorId, number>>;

type CrewRolePlan = {
  role: string;
  vendor: OrchestratorLaneKey;
  sequence: number;
  dependsOn: string[];
  execution: "parallel-independent" | "sequential-after-handoff";
  scopeRule: string;
};

type CoordinatorCrewPlan = {
  missionShape: CrewMissionShape;
  evidence: "fleet-and-readiness" | "fleet-only" | "unavailable";
  configured: CoordinatorSeatCounts;
  workerSlots: CoordinatorSeatCounts;
  idleWorkerSlots: CoordinatorSeatCounts;
  desiredCrewSize: number;
  firstWaveConcurrency: number;
  requiredChildCount: number;
  capacityBlocked: boolean;
  immediateCapacityBlocked: boolean;
  roles: CrewRolePlan[];
};

/**
 * What the verifier saw for ONE governed child, so a failure verdict can name
 * the child and the single clause it missed instead of restating the whole
 * checklist. `counted` children are the proof; the rest carry their reason.
 */
type CrewChildFinding = {
  job: DispatchJobRecord;
  /** The filed crew task this child was dispatched for, when it named one. */
  taskId?: string;
  counted: boolean;
  /** Why it was not counted — one clause, in evidence terms. */
  reason?: string;
};

type CrewProof = {
  complete: boolean;
  children: DispatchJobRecord[];
  taskIds: string[];
  deficiencies: string[];
  findings: CrewChildFinding[];
  /** One sentence: what the contract required, what was actually proved. */
  summary: string;
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const boundedObservation = async <T>(
  operation: () => Promise<T>,
  timeoutMs = 2_000
): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

function missionShape(message: string): CrewMissionShape {
  if (
    /\b(?:build|debug|fix|implement|migrat(?:e|ion)|refactor|repair)\b/i.test(
      message
    )
  ) {
    return "change";
  }
  if (
    /\b(?:audit|review|secur(?:e|ity)|threat|verify|vulnerab)\w*\b/i.test(
      message
    )
  ) {
    return "assessment";
  }
  return "research";
}

function boundedFleetCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(3, Math.max(0, Math.trunc(value)))
    : 0;
}

function desiredCrewSize(message: string): number {
  const broadMission =
    /\b(?:all (?:core|major|product|runtime|user)|codebase|combined|complete (?:codebase|repository|request flow|system|workflow)|entire|repository-wide|whole)\b/i.test(
      message
    );
  return broadMission ? 3 : 2;
}

function buildCoordinatorCrewPlan(
  message: string,
  coordinatorVendor: OrchestratorLaneKey,
  fleet?: FleetSnapshot,
  readiness?: FleetReadinessReport
): CoordinatorCrewPlan {
  // The crew's candidate worker lanes are the coordinator-seated ones (ADR-0022
  // C3): the only lanes that hold a write role, so the only ones a change
  // mission can be planned onto. Read from the registry rather than named here.
  const vendors = ORCHESTRATOR_LANE_KEYS;
  const seats = (
    of: (vendor: OrchestratorLaneKey) => number
  ): CoordinatorSeatCounts =>
    Object.fromEntries(vendors.map((vendor) => [vendor, of(vendor)]));
  const ready = readiness
    ? new Set(
        readiness.vendors
          .filter((entry) => entry.installed && entry.authenticated)
          .map((entry) => entry.vendor)
      )
    : undefined;
  const configured = seats((vendor) =>
    boundedFleetCount(fleet?.counts[vendor])
  );
  const workerSlots = seats((vendor) =>
    ready && !ready.has(vendor) ? 0 : configured[vendor] ?? 0
  );
  // `/api/fleet` is already worker-only: backend fleetSnapshot excludes every
  // reserved ordinal-0 coordinator. Do not subtract the selected coordinator
  // again or a real worker seat disappears from the plan.
  const idleWorkerSlots = seats((vendor) =>
    Math.min(
      workerSlots[vendor] ?? 0,
      fleet?.agents.filter(
        (agent) => agent.vendor === vendor && agent.status === "idle"
      ).length ?? 0
    )
  );
  const idleVendors = vendors.flatMap((vendor) =>
    Array.from({ length: idleWorkerSlots[vendor] ?? 0 }, () => vendor)
  );
  const workingWorkerSlots = seats((vendor) =>
    Math.min(
      (workerSlots[vendor] ?? 0) - (idleWorkerSlots[vendor] ?? 0),
      fleet?.agents.filter(
        (agent) => agent.vendor === vendor && agent.status === "working"
      ).length ?? 0
    )
  );
  const deferredVendors = vendors.flatMap((vendor) =>
    Array.from({ length: workingWorkerSlots[vendor] ?? 0 }, () => vendor)
  );
  // Put currently idle seats first so first-wave routing never points at a
  // working seat when another ready lane is idle. Working seats remain valid
  // serialized capacity for later roles; explicitly offline seats do not.
  const availableVendors = [...idleVendors, ...deferredVendors];
  const availableWorkerCount = Math.min(3, availableVendors.length);
  const idleWorkerCount = Math.min(3, idleVendors.length);
  const configuredVendors = vendors.flatMap((vendor) =>
    Array.from({ length: workerSlots[vendor] ?? 0 }, () => vendor)
  );
  const desired = desiredCrewSize(message);
  // Even unavailable capacity evidence cannot waive the substantial-mission
  // contract. It falls back to one child and requires the coordinator's own
  // capability_preflight/fleet_status to prove or surface the blocker.
  const requiredChildCount = Math.max(
    1,
    Math.min(desired, availableWorkerCount || 1)
  );
  const shape = missionShape(message);
  const rolesByShape: Record<CrewMissionShape, string[]> = {
    change: [
      "implementation-owner",
      "adversarial-reviewer",
      "verification-repair",
    ],
    assessment: [
      "control-flow-auditor",
      "security-authority-reviewer",
      "runtime-evidence-reviewer",
    ],
    research: [
      "runtime-control-plane-researcher",
      "user-surface-researcher",
      "architecture-gap-synthesizer",
    ],
  };
  const roles = rolesByShape[shape]
    .slice(0, requiredChildCount)
    .map((role, index) => {
      let vendor =
        availableVendors[index] ??
        configuredVendors[index] ??
        coordinatorVendor;
      const upstreamVendor =
        index > 0
          ? availableVendors[index - 1] ?? coordinatorVendor
          : coordinatorVendor;
      if (
        role.includes("reviewer") &&
        availableVendors.some((candidate) => candidate !== upstreamVendor)
      ) {
        vendor = availableVendors.find(
          (candidate) => candidate !== upstreamVendor
        )!;
      }
      const priorRole = index > 0 ? rolesByShape[shape][index - 1]! : undefined;
      const sequential =
        (shape === "change" && index > 0) ||
        (shape === "research" && index === 2);
      const execution: CrewRolePlan["execution"] = sequential
        ? "sequential-after-handoff"
        : "parallel-independent";
      return {
        role,
        vendor,
        sequence: index + 1,
        dependsOn: sequential
          ? shape === "research" && index === 2
            ? rolesByShape.research.slice(0, 2)
            : [priorRole!]
          : [],
        execution,
        scopeRule:
          role.includes("reviewer")
            ? "Read-only review of the actual upstream diff; own the review evidence, not implementation files."
            : shape === "change" && index > 0
              ? "Start only after typed upstream handoff; own the verification/repair unit declared by RepoMap/flow_scope."
              : index === 0
                ? "Own one RepoMap-derived work unit."
                : "Own a distinct RepoMap/flow_scope work unit; shared contracts are read-only and sequenced.",
      };
    });
  const firstWaveConcurrency =
    idleWorkerCount === 0
      ? 0
      : shape === "change"
        ? Math.min(1, idleWorkerCount)
        : shape === "research"
          ? Math.min(2, requiredChildCount, idleWorkerCount)
          : Math.min(requiredChildCount, idleWorkerCount);
  return {
    missionShape: shape,
    evidence: readiness
      ? "fleet-and-readiness"
      : fleet
        ? "fleet-only"
        : "unavailable",
    configured,
    workerSlots,
    idleWorkerSlots,
    desiredCrewSize: desired,
    firstWaveConcurrency,
    requiredChildCount,
    capacityBlocked: availableWorkerCount === 0,
    immediateCapacityBlocked:
      availableWorkerCount > 0 && idleWorkerCount === 0,
    roles,
  };
}

/**
 * Conservative admission rule for the coordinator outcome contract. This is
 * not an authority decision: it only decides whether a successful root turn
 * must leave behind at least one governed child DispatchJob. Explicit human
 * single-agent requests and small conversational requests may complete without
 * fan-out. Machine reconciliation turns never launch a fresh crew.
 *
 * Classification is on INTENT, never size. The deleted `length >= 160` floor
 * admitted a 196-character QUESTION ABOUT THE PREVIOUS TURN as a substantial
 * mission; the coordinator then correctly dispatched nothing — it had not been
 * asked for work — and was told its dispatch contract had failed. Raising the
 * number only moves the same bug behind a longer question, so the rule now
 * reads the turn instead of measuring it, in four ordered clauses:
 *
 *   1. an explicit human single-agent request wins outright (unchanged);
 *   2. a codebase imperative in imperative position is a commissioned mission,
 *      and beats everything below it — so "show me the crew output, then
 *      refactor auth" is still crew-required. EXCEPT when the imperative asks
 *      for a REPORT ON work rather than for work: "WRITE ALL INFORMATION WE GOT
 *      INTO A new FILE INFO.md" is `write` in imperative position, and the rule
 *      read the verb and admitted a crew to narrate what the crew had already
 *      done. Position was the right insight and is untouched; what was missing
 *      is that two of these verbs (`document`, `write`) take an OBJECT that
 *      decides which kind of turn it is. Both conjuncts are required — every
 *      imperative must be an authoring verb, and the object must be the
 *      mission's own accumulated knowledge — and the turn then FALLS THROUGH to
 *      clauses 3 and 4 rather than returning, so mission vocabulary or a
 *      multi-line brief can still re-arm it ("document everything we learned
 *      about the codebase" keeps its crew on `codebase`);
 *   3. a retrospective turn — interrogative/retrieval FORM *and* a reference to
 *      work that already exists — is asking, not commissioning. BOTH conjuncts
 *      are required, which is what keeps "explain the codebase" (a mission) on
 *      the other side of the line from "explain the crew results";
 *   4. otherwise: mission vocabulary anywhere, or a multi-line turn in which
 *      SOME line is not itself a question. Multi-line stays deliberately: a
 *      structured brief ("Goals:\n- ship X") carries no imperative verb and no
 *      mission noun, and letting that run ungoverned is the failure that
 *      actually costs something — but line COUNT was never the signal. What
 *      makes a brief a brief is that it contains work items, and a work item
 *      does not read as a question. So a turn whose every line is interrogative
 *      /retrospective in FORM ("is the demo ready\nwhat do you think") is not a
 *      mission at any length, while one line that reads as anything else
 *      ("- desktop packaging still pending") re-arms the whole turn. The
 *      vocabulary half of this clause is untouched and still runs, so an
 *      all-question turn about substantial work ("how did the migration
 *      go\nwhat is left") keeps its crew. Ambiguity resolves toward requiring
 *      one: a line the retrospective vocabulary does not recognise is not a
 *      question, so it costs a crew rather than losing one.
 *
 * The bound that makes clause 4 safe to narrow: WHEN the exemption fires, every
 * line of the turn would also be `single-agent-allowed` ON ITS OWN — an
 * imperative in any line returns at clause 2, and mission vocabulary in any line
 * is vocabulary in the turn. So it can only ever admit a turn that pressing
 * Enter once instead of twice already admitted; it opens no new shape. And
 * `single-agent-allowed` is a FLOOR, not a ceiling: it drops the requirement to
 * leave governed children behind, never the ability to dispatch them, and never
 * the ban on provider-native subagents.
 */
export function classifyCoordinatorDispatchMode(
  message: string,
  isEventTurn = false
): CoordinatorDispatchMode {
  if (isEventTurn) return "not-applicable";
  const normalized = message.trim();
  if (EXPLICIT_SINGLE_AGENT_PATTERN.test(normalized)) {
    return "single-agent-allowed";
  }
  const imperatives = missionImperativeVerbs(normalized);
  if (
    imperatives.length > 0 &&
    !isReportingImperative(normalized, imperatives)
  ) {
    return "crew-required";
  }
  if (
    RETROSPECTIVE_FORM_PATTERN.test(normalized) &&
    PRIOR_WORK_REFERENCE_PATTERN.test(normalized)
  ) {
    return "single-agent-allowed";
  }
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // Read PER LINE with the same two vocabularies clause 2 and 3 already use: a
  // line is "asking" when it has the interrogative/retrieval form and does not
  // commission work. The imperative half is belt-and-braces — clause 2 already
  // returned for any imperative in the turn — but it keeps this clause readable
  // on its own, and it is the half that must never be dropped.
  const isMultiLineBrief =
    lines.length > 1 &&
    !lines.every(
      (line) =>
        RETROSPECTIVE_FORM_PATTERN.test(line) &&
        !MISSION_IMPERATIVE_PATTERN.test(line)
    );
  return isMultiLineBrief || SUBSTANTIAL_MISSION_PATTERN.test(normalized)
    ? "crew-required"
    : "single-agent-allowed";
}

function coordinatorDispatchContract(
  mode: CoordinatorDispatchMode,
  crewPlan?: CoordinatorCrewPlan
): string {
  if (mode === "not-applicable") return "";
  if (mode === "single-agent-allowed") {
    return [
      '<muon_dispatch_contract mode="single-agent-allowed">',
      "This request is admitted as bounded/trivial or explicitly single-agent.",
      "If you complete it without a governed worker DispatchJob, state that choice and why.",
      "Never use provider-native subagents: only MUON dispatch/delegate creates governed workers.",
      "</muon_dispatch_contract>",
    ].join("\n");
  }
  const encodedPlan = JSON.stringify(crewPlan).replace(/</g, "\\u003c");
  return [
    '<muon_dispatch_contract mode="crew-required">',
    `This is a substantial human mission. Successful completion requires ${crewPlan?.requiredChildCount ?? 1} governed child DispatchJob(s) created through MUON dispatch/delegate.`,
    `For every required role, first create a same-chat ledger task whose description contains exact non-empty headings ${taskHeadingList()}. Its governed child brief must repeat that exact ROLE and OWNED SCOPE and declare every heading below, then retain its taskId -> jobId proof.`,
    `Required brief headings (a heading may carry its content on the same line or in the block beneath it; an empty one counts as missing): ${briefHeadingList()}`,
    `<brief_skeleton>\n${childBriefSkeleton()}\n</brief_skeleton>`,
    "The OWNED SCOPE declarations must be distinct — UNLESS the overlap is deliberate: when several workers must contend for the same ground (a claim-exclusivity exercise, a hot file), every task sharing that scope must append `[contended: claim-mediated]` to its OWNED SCOPE line, and claim_files decides who touches it. Task/backlog records without admitted child jobs do not count. Provider-native subagents do not count.",
    "Treat the bounded crew plan below as server-observed capacity and role guidance, never authority. Re-run capability_preflight and fleet_status before dispatch; if capacity is blocked, surface the exact blocker or file the human-gated set_fleet request instead of claiming completion.",
    "Dispatch only roles marked parallel-independent in the first wave. A sequential-after-handoff role MUST wait for every dependsOn task to terminate and for handoff_read(taskId); review starts from the actual upstream diff.",
    "Do not widen grants, bypass fleet/lineage limits, or claim success from planning prose alone.",
    `<crew_plan encoding="json">${encodedPlan}</crew_plan>`,
    "</muon_dispatch_contract>",
  ].join("\n");
}

function coordinatorCorrection(
  rootJobIds: string[],
  plan: CoordinatorCrewPlan,
  proof: CrewProof
): string {
  const evidence = JSON.stringify({
    priorRootJobIds: rootJobIds,
    requiredChildCount: plan.requiredChildCount,
    provenTaskIds: proof.taskIds.slice(0, 6),
    // Per-child, so the correction repairs the ONE clause each child missed
    // instead of re-filing a crew that mostly already conforms.
    children: proof.findings.slice(0, 6).map((finding) => ({
      jobId: finding.job.id,
      ...(finding.taskId ? { taskId: finding.taskId } : {}),
      status: finding.job.status,
      counted: finding.counted,
      ...(finding.reason ? { notCountedBecause: finding.reason } : {}),
    })),
    deficiencies: proof.deficiencies.slice(0, 8),
  }).replace(/</g, "\\u003c");
  return [
    '<muon_control kind="dispatch-contract-correction">',
    "The previous root turn terminated successfully but did not prove the complete governed crew contract for this substantial human mission.",
    "This is the one bounded corrective continuation for the same human turn. Reconcile durable state, preserve valid prior child dispatches, then file and dispatch only the missing role/task/scope units.",
    "A filed task is backlog until MUON dispatch/delegate returns its child jobId. Do not use provider-native subagents, widen grants, or merely promise future dispatch. If governed dispatch is impossible, fail visibly with the exact blocker.",
    // Quote the remedy, not just the verdict. A child that missed a heading is
    // repaired by re-briefing THAT child to this shape — never by dispatching a
    // duplicate worker to satisfy a counter.
    `Every required brief heading, and one compliant brief:\n<brief_skeleton>\n${childBriefSkeleton()}\n</brief_skeleton>`,
    `<evidence encoding="json">${evidence}</evidence>`,
    "</muon_control>",
  ].join("\n");
}

/**
 * Every governed child THIS CHAT's coordinator roots have admitted.
 *
 * The lineage anchor is the chat, not the turn. A crew is filed once and then
 * worked across several turns, so anchoring the proof on the current turn's own
 * root made a coordinator that correctly monitored its already-running crew —
 * instead of dispatching a redundant second one — look like it had dispatched
 * nothing at all. The chat is the unit MUON already treats as the mission (one
 * workspace, one shadow task, one crew plan, one resolved role set), and every
 * per-child clause below is unchanged. `turnRootJobIds` still counts, so a root
 * that has not yet surfaced in the bounded listing is never missed, and it is
 * what decides CURRENCY in `verifyCrewProof` — a terminated crew from an
 * earlier turn cannot be coasted on.
 *
 * There is deliberately NO status filter. Only the governed delegate route can
 * create a row carrying a parentJobId, so the row IS the proof of admission;
 * `status` says how the child later exited, which is a different question. The
 * old filter erased a child the moment it was interrupted, so one turn's
 * verdict changed between two reads of the same durable state. `queued` — a
 * child that has not executed a single instruction — was always admitted, so
 * admitting one that ran and was interrupted cannot widen anything.
 */
function governedChildren(
  jobs: DispatchJobRecord[],
  chatId: string,
  turnRootJobIds: string[]
): DispatchJobRecord[] {
  const turnRoots = new Set(turnRootJobIds);
  const chatRoots = new Set(
    jobs
      .filter((job) => !job.parentJobId && job.chatId === chatId)
      .map((job) => job.id)
  );
  return jobs.filter(
    (candidate) =>
      Boolean(candidate.parentJobId) &&
      (turnRoots.has(candidate.parentJobId!) ||
        chatRoots.has(candidate.parentJobId!))
  );
}

/** `(it declares GOAL, MODE, SCOPE)` — the evidence half of a failure reason. */
function declaredHeadingsNote(text: string): string {
  const declared = declaredHeadings(text);
  return declared.length > 0
    ? ` (it declares ${declared.join(", ")})`
    : " (it declares no headings at all)";
}

type FiledTaskContract = {
  role: string;
  scope: string;
  /**
   * #95 — this task DECLARES that its scope is deliberately shared and the
   * overlap is mediated by `claim_files` (a `[contended: …]` marker inside
   * the OWNED SCOPE declaration). Two agents contending for one coordinate is
   * exactly what the claim layer exists to mediate — measured 2026-08-10, it
   * did so correctly (one GRANTED, one refused naming the holder) while this
   * contract still failed the turn. Deny-first: absent the marker, sharing a
   * scope stays a contract violation, so an ACCIDENTAL collision still fails.
   */
  contended: boolean;
};

/** The exact marker an OWNED SCOPE uses to declare deliberate contention. */
const CONTENDED_SCOPE_MARKER = /\[contended:[^\]]+\]/i;

const normalizedDeclaration = (value: string): string =>
  value.replace(/\s+/g, " ").trim().toLowerCase();

function taskContract(
  task: TaskDetail,
  chatId: string
): FiledTaskContract | undefined {
  if (task.chatId !== chatId) return undefined;
  const role = headingValue(task.description, "ROLE");
  const scope = headingValue(task.description, "OWNED SCOPE");
  const coordination = headingValue(task.description, "COORDINATION");
  return role && scope && coordination
    ? {
        role: normalizedDeclaration(role),
        scope: normalizedDeclaration(scope),
        contended: CONTENDED_SCOPE_MARKER.test(scope),
      }
    : undefined;
}

/**
 * The path-like tokens a scope declaration names — `packages/core/**`,
 * `src/app.ts`, `/abs/dir/`. These are the AUTHORITY-bearing part of an OWNED
 * SCOPE line: they say what the worker may touch. The prose around them is
 * guidance addressed to the worker.
 *
 * Normalized on the way in, because the filed side arrives already normalized
 * (`taskContract`) and the brief side arrives raw — comparing the two without
 * this made every absolute path (`/Users/…/GitNexus/`) look like a divergence.
 */
function scopePaths(scope: string): Set<string> {
  return new Set(
    normalizedDeclaration(scope)
      .split(/[\s,;]+/)
      .map((token) => token.replace(/^[("'`]+|[)"'`.,:;]+$/g, ""))
      .filter((token) => token.length > 1 && /[/\\]|\*\*/.test(token))
  );
}

/**
 * Does the child brief own the SAME ground the filed task declared?
 *
 * Set equality on the declared paths, not equality of the sentence. The check
 * this replaces demanded the two free-text paragraphs match byte for byte, so a
 * coordinator that filed `… owned by a peer (user-surface-researcher, codex).`
 * and briefed `… (user-surface-researcher, codex, on a different job).` was
 * told it had not proved the contract — over a four-word clarification inside
 * an otherwise identical 659-character scope. Nothing is loosened about the
 * authority: the brief may not drop a filed path (the worker would own less
 * than the ledger says) and may not add one (it would quietly own more).
 * Declarations that name no path at all fall back to the old text comparison,
 * so prose-only scopes keep exactly the strength they had.
 */
function scopeMatchesFiledTask(taskScope: string, briefScope: string): boolean {
  const filed = scopePaths(taskScope);
  const briefed = scopePaths(briefScope);
  if (filed.size === 0 && briefed.size === 0) {
    return normalizedDeclaration(taskScope) === normalizedDeclaration(briefScope);
  }
  return (
    filed.size === briefed.size &&
    [...filed].every((path) => briefed.has(path))
  );
}

/**
 * The one clause this child's brief misses, or undefined when it satisfies the
 * contract. A reason rather than a boolean so the human reading a failure can
 * tell "the crew is wrong" from "the check is confused".
 */
function childBriefDeficiency(
  child: DispatchJobRecord,
  contract: FiledTaskContract
): string | undefined {
  if (typeof child.brief !== "string") return "its brief could not be read";
  const role = headingValue(child.brief, "ROLE");
  const scope = headingValue(child.brief, "OWNED SCOPE");
  if (!role) {
    return `its brief declares no ROLE${declaredHeadingsNote(child.brief)}`;
  }
  if (normalizedDeclaration(role) !== contract.role) {
    return "its brief ROLE is not the ROLE its filed task declares";
  }
  if (!scope) {
    return `its brief declares no OWNED SCOPE${declaredHeadingsNote(child.brief)}`;
  }
  if (!scopeMatchesFiledTask(contract.scope, scope)) {
    return "its brief OWNED SCOPE declares different paths than its filed task";
  }
  // Every remaining heading in ONE verdict, named. Reporting them one at a time
  // cost one corrective round per missing heading, and the coordinator repaired
  // the one it was told about while the next was already waiting to fail it.
  const missing = missingBriefHeadings(child.brief);
  if (missing.length > 0) {
    return (
      `its brief has no ${missing.join(", ")}${declaredHeadingsNote(child.brief)}` +
      " — every required heading is listed in the dispatch contract's brief skeleton"
    );
  }
  return undefined;
}

async function verifyCrewProof(
  client: MuonApiClient,
  chatId: string,
  sessionTaskId: string,
  jobs: DispatchJobRecord[],
  turnRootJobIds: string[],
  requiredChildCount: number
): Promise<CrewProof> {
  const children = governedChildren(jobs, chatId, turnRootJobIds);
  const uniqueTaskIds = [
    ...new Set(
      children
        .map((child) => child.taskId)
        .filter(
          (taskId): taskId is string =>
            Boolean(taskId) && taskId !== sessionTaskId
        )
    ),
  ];
  // Direct-child lineage is capped by the backend (three per root). Fetch every
  // candidate so invalid early jobs cannot hide later valid task contracts or
  // make proof depend on list ordering.
  const details = await Promise.all(
    uniqueTaskIds.map((taskId) =>
      boundedObservation(() => client.getTaskDetail(taskId))
    )
  );
  const detailByTask = new Map(
    uniqueTaskIds.map((taskId, index) => [taskId, details[index]] as const)
  );
  // An observation that timed out is NOT a task without headings. Keeping the
  // two apart is what lets the re-read below fix a slow read instead of
  // reporting a contract breach that never happened.
  const unreadable = uniqueTaskIds.filter(
    (taskId) => detailByTask.get(taskId) === undefined
  );
  const contractByTask = new Map<string, FiledTaskContract>();
  for (const taskId of uniqueTaskIds) {
    const detail = detailByTask.get(taskId);
    const contract = detail ? taskContract(detail, chatId) : undefined;
    if (contract) contractByTask.set(taskId, contract);
  }
  const findings: CrewChildFinding[] = children.map((child) => {
    const taskId = child.taskId;
    if (!taskId || taskId === sessionTaskId) {
      return {
        job: child,
        counted: false,
        reason:
          "it reuses the chat's root shadow task instead of a filed crew task",
      };
    }
    if (detailByTask.get(taskId) === undefined) {
      return {
        job: child,
        taskId,
        counted: false,
        reason: "its filed task record could not be read",
      };
    }
    const contract = contractByTask.get(taskId);
    if (!contract) {
      const detail = detailByTask.get(taskId)!;
      return {
        job: child,
        taskId,
        counted: false,
        reason:
          detail.chatId !== chatId
            ? "its filed task belongs to another chat"
            : `its filed task declares no ${missingTaskHeadings(
                detail.description
              ).join(", ")}` + declaredHeadingsNote(detail.description),
      };
    }
    const deficiency = childBriefDeficiency(child, contract);
    return deficiency
      ? { job: child, taskId, counted: false, reason: deficiency }
      : { job: child, taskId, counted: true };
  });
  // One filed task is one proven role, however many children were dispatched
  // for it: re-dispatching an interrupted worker does not buy a second role.
  const provenTaskIds = [
    ...new Set(
      findings
        .filter((finding) => finding.counted)
        .map((finding) => finding.taskId!)
    ),
  ];
  const proven = provenTaskIds.map((taskId) => contractByTask.get(taskId)!);
  // #95: a scope shared by SEVERAL proven tasks counts once — an accidental
  // collision — unless EVERY task sharing it carries the contended marker, in
  // which case each counts: the crew told the truth about the overlap, and the
  // claim layer (not this contract) mediates who touches the ground. A MIXED
  // group (some declared, some not) still counts once; the undeclared members
  // do not inherit their siblings' honesty.
  // Grouped by the scope's PATH TOKENS (its authority-bearing part), not its
  // literal prose: the marker itself changes the string, so literal grouping
  // would let one marked task dodge its unmarked sibling — and two scopes
  // naming the same ground in different words were never really distinct.
  // A prose-only scope (no path tokens) falls back to its normalized text
  // with the marker stripped, so unrelated prose scopes never collide.
  const contentionGround = (scope: string): string => {
    const tokens = [...scopePaths(scope)].sort();
    return tokens.length > 0
      ? tokens.join(" ")
      : normalizedDeclaration(scope.replace(CONTENDED_SCOPE_MARKER, ""));
  };
  const scopeGroups = new Map<string, { count: number; allContended: boolean }>();
  for (const entry of proven) {
    const ground = contentionGround(entry.scope);
    const group = scopeGroups.get(ground) ?? {
      count: 0,
      allContended: true,
    };
    group.count += 1;
    group.allContended = group.allContended && entry.contended;
    scopeGroups.set(ground, group);
  }
  let effectiveScopeCount = 0;
  for (const group of scopeGroups.values()) {
    effectiveScopeCount +=
      group.count > 1 && group.allContended ? group.count : 1;
  }
  const distinctRoles = new Set(proven.map((entry) => entry.role));
  // Chat-wide proof must still be CURRENT proof: at least one counted child was
  // filed by this turn or is still running for it. A crew that was filed and
  // finished in an earlier turn proves that turn's contract, never this one's,
  // so a coordinator can never answer a fresh mission with an old crew.
  const turnRoots = new Set(turnRootJobIds);
  const currentCrew = findings.some(
    (finding) =>
      finding.counted &&
      (turnRoots.has(finding.job.parentJobId!) ||
        ["queued", "running"].includes(finding.job.status))
  );
  // Report the FIRST binding constraint, not all seven clauses: the later ones
  // are arithmetic consequences of the earlier ones, and a wall of derived
  // clauses is what made a real failure unreadable.
  const missing = (count: number): number => requiredChildCount - count;
  const deficiencies: string[] = [];
  if (children.length < requiredChildCount) {
    deficiencies.push(
      `missing ${missing(children.length)} admitted child DispatchJob(s)`
    );
  } else if (uniqueTaskIds.length < requiredChildCount) {
    deficiencies.push(
      `missing ${missing(uniqueTaskIds.length)} unique child taskId(s); root shadow/backlog tasks do not count`
    );
  } else if (
    unreadable.length > 0 &&
    provenTaskIds.length + unreadable.length >= requiredChildCount
  ) {
    deficiencies.push(
      `could not read ${unreadable.length} filed task record(s), so the contract could not be judged for them`
    );
  } else if (contractByTask.size < requiredChildCount) {
    deficiencies.push(
      `missing ${missing(contractByTask.size)} same-chat task description(s) with ${taskHeadingList()} headings`
    );
  } else if (provenTaskIds.length < requiredChildCount) {
    deficiencies.push(
      `missing ${missing(provenTaskIds.length)} child brief contract(s) matching the filed task ROLE/OWNED SCOPE and declaring ${briefHeadingList()}`
    );
  } else {
    if (effectiveScopeCount < requiredChildCount) {
      deficiencies.push(
        `missing ${missing(effectiveScopeCount)} distinct OWNED SCOPE declaration(s) — a deliberately shared scope counts only when EVERY task sharing it marks it \`[contended: claim-mediated]\`, leaving the overlap to claim_files`
      );
    }
    if (distinctRoles.size < requiredChildCount) {
      deficiencies.push(
        `missing ${missing(distinctRoles.size)} distinct ROLE declaration(s)`
      );
    }
    if (!currentCrew) {
      deficiencies.push(
        `the ${provenTaskIds.length} proven child dispatch(es) all belong to earlier turns and have already terminated; this turn filed none`
      );
    }
  }
  return {
    complete:
      children.length >= requiredChildCount &&
      provenTaskIds.length >= requiredChildCount &&
      effectiveScopeCount >= requiredChildCount &&
      distinctRoles.size >= requiredChildCount &&
      currentCrew,
    children,
    taskIds: provenTaskIds,
    deficiencies,
    findings,
    summary:
      `required ${requiredChildCount} governed child dispatch(es) with distinct ROLE and OWNED SCOPE, ` +
      `proved ${provenTaskIds.length} from ${children.length} admitted child job(s)`,
  };
}

/**
 * Verify, and CONFIRM a failure against current durable state before acting on
 * it — exactly the reconciliation a coordinator performs by hand when it does
 * not believe the verdict. A negative verdict costs a corrective vendor turn or
 * shows the human a red box, so it is worth one bounded re-read; a positive one
 * is already proved and returns immediately.
 *
 * The stronger of the two readings wins, so a slow or failed observation on
 * either pass can only be corrected, never used to convict.
 */
async function confirmCrewProof(
  client: MuonApiClient,
  chatId: string,
  sessionTaskId: string,
  jobs: DispatchJobRecord[],
  turnRootJobIds: string[],
  requiredChildCount: number
): Promise<CrewProof> {
  const first = await verifyCrewProof(
    client,
    chatId,
    sessionTaskId,
    jobs,
    turnRootJobIds,
    requiredChildCount
  );
  if (first.complete) return first;
  await delay(CONTRACT_RECHECK_DELAY_MS);
  const fresh = await boundedObservation(() =>
    client.listDispatchJobs({ chatId, limit: CHAT_JOB_WINDOW })
  );
  if (!fresh || fresh.length >= CHAT_JOB_WINDOW) return first;
  const second = await verifyCrewProof(
    client,
    chatId,
    sessionTaskId,
    fresh,
    turnRootJobIds,
    requiredChildCount
  );
  return second.complete || second.taskIds.length >= first.taskIds.length
    ? second
    : first;
}

const shortId = (id: string): string => id.slice(0, 8);

const describeChild = (finding: CrewChildFinding): string =>
  `job ${shortId(finding.job.id)} (${finding.job.vendor}` +
  `${finding.taskId ? `, task ${shortId(finding.taskId)}` : ""})`;

/**
 * The children a proof actually counted, and — when it failed — the ones it
 * did not, each with its own reason. Bounded: a human needs the shape of the
 * evidence, not every row.
 */
function crewEvidence(proof: CrewProof, includeRejected: boolean): string {
  const bounded = (
    findings: CrewChildFinding[],
    render: (finding: CrewChildFinding) => string
  ): string =>
    findings.slice(0, 3).map(render).join("; ") +
    (findings.length > 3 ? `; +${findings.length - 3} more` : "");
  const counted = proof.findings.filter((finding) => finding.counted);
  const rejected = proof.findings.filter((finding) => !finding.counted);
  const parts = [
    counted.length > 0
      ? `Counted: ${bounded(counted, describeChild)}.`
      : "Counted: none.",
  ];
  if (includeRejected && rejected.length > 0) {
    parts.push(
      `Not counted: ${bounded(
        rejected,
        (finding) => `${describeChild(finding)} — ${finding.reason}`
      )}.`
    );
  }
  return parts.join(" ");
}

export async function runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
  const { client, chat } = input;
  if (chat.status === "archived") {
    throw new Error("Cannot run an archived orchestrator chat.");
  }
  const laneKey = input.vendor ?? CHAT_LANE_KEY;
  // A process restart loses the surface's in-memory "turn running" lock while
  // the durable dispatch can still be queued/running. Refuse before recording a
  // second human milestone; the backend transaction remains the race-safe
  // authority if two surfaces pass this advisory preflight simultaneously.
  //
  // B1: the SAME listing now answers a second question the old per-chat query
  // could not even see. There is exactly ONE coordinator seat per vendor (fleet
  // ordinal 0, `ensureCoordinatorAgent`) and an `orchestrator` job may claim
  // ONLY that ordinal, so a second chat's turn on the same lane cannot run — it
  // can only sit `queued` behind the first while its author watches a spinner
  // for the full CHAT_TURN_TIMEOUT_MS with nothing written anywhere. Refusing
  // here is strictly better than admitting it: no job, no `[you]` row, no
  // spinner, and the message names WHOSE turn holds the seat.
  //
  // Advisory, exactly like the check above it — two surfaces can pass this
  // simultaneously — so it is BACKED by the runner-side bound (loop.ts), which
  // is what actually makes a silent 30-minute wait impossible.
  const activeRoots = (
    await client.listDispatchJobs({ activeRootOnly: true, limit: 200 })
  ).filter((job) => !job.parentJobId);
  const activeRootJob = activeRoots.find((job) => job.chatId === chat.id);
  if (activeRootJob) {
    // Typed, not string-matched: the reconciler treats this as the BENIGN
    // "another turn is running, its own terminal event will re-fire us" race
    // (skip, no red event) — not a failure to retry and report.
    throw Object.assign(
      new Error(
        `Orchestrator chat already has active root dispatch '${activeRootJob.id}' (${activeRootJob.status}). Wait for it to finish or interrupt it before sending another turn.`
      ),
      { code: "MUON_ACTIVE_ROOT_EXISTS" as const }
    );
  }
  // Only a chat-bound `orchestrator` root claims the coordinator seat; a plain
  // (non-chat) dispatch is also `parentJobId: null` but claims ordinal >= 1 and
  // is no contention at all.
  const seatHolder = activeRoots.find(
    (job) =>
      job.vendor === laneKey &&
      job.capabilityMode === "orchestrator" &&
      Boolean(job.chatId)
  );
  if (seatHolder) {
    throw new Error(
      `The '${laneKey}' coordinator seat is busy: chat '${seatHolder.chatId}' holds it with root dispatch '${seatHolder.id}' (${seatHolder.status}). MUON seats exactly ONE coordinator per vendor, so this turn would queue behind that one instead of running. Wait for it to finish, interrupt it from the cockpit, or send this turn on a different vendor lane.`
    );
  }
  // A nudge turn (S4) is machine-synthesized reconciliation, not a human turn:
  // its dedupe milestone is written by the caller and it never titles the chat.
  const isEventTurn = Boolean(input.event);
  const dispatchMode = classifyCoordinatorDispatchMode(
    input.message,
    isEventTurn
  );
  const [fleet, readiness] =
    dispatchMode === "crew-required"
      ? await Promise.all([
          boundedObservation(() => client.getFleet()),
          boundedObservation(() => client.getFleetReadinessReport()),
        ])
      : [undefined, undefined];
  const crewPlan =
    dispatchMode === "crew-required"
      ? buildCoordinatorCrewPlan(
          input.message,
          laneKey,
          fleet,
          readiness
        )
      : undefined;
  const dispatchContract = coordinatorDispatchContract(
    dispatchMode,
    crewPlan
  );

  const admissionStatus =
    !isEventTurn && dispatchMode === "single-agent-allowed"
      ? "[contract.single] This bounded/trivial or explicitly single-agent turn may complete without creating a governed child DispatchJob."
      : undefined;

  // The chat's ledger anchor: approvals FK to Task, so the session, the
  // super-agent's default-task MCP tools (task_context/memory_recall), and
  // its gated tools all hang off the chat's shadow task, a real Task row.
  const sessionTaskId = chat.taskId ?? chat.id;

  // Resume ownership is explicit and server-attested by the exact root job.
  // Legacy unbound session ids and child/foreign/wrong-provider coordinates are
  // ignored fail-closed. Codex is intentionally fresh-only.
  const sessionRoot =
    chat.vendorSessionRootJobId && chat.vendorSessionVendor === laneKey
      ? await client
          .getDispatchJob(chat.vendorSessionRootJobId)
          .catch(() => null)
      : null;
  // G7: only a lane MUON actually persists a continuity handle for can resume
  // one, asked of the registry rather than of the lane's name (ADR-0022 C4).
  const resumeVendorSessionId =
    sessionCapability(laneKey).persistsSessionHandle &&
    chat.vendorSessionVendor === laneKey &&
    sessionRoot !== null &&
    sessionRoot.id === chat.vendorSessionRootJobId &&
    sessionRoot.chatId === chat.id &&
    !sessionRoot.parentJobId &&
    sessionRoot.capabilityMode === "orchestrator" &&
    sessionRoot.vendor === laneKey &&
    chat.vendorSessionId
      ? chat.vendorSessionId
      : undefined;
  const isFirstTurn = !resumeVendorSessionId;
  // Both payloads are typed JSON envelopes so worker output and human text alike
  // are data, never instructions the turn can be steered by.
  const payload = input.event
    ? buildJobTerminalEnvelope(input.event)
    : `<human_request encoding="json">${JSON.stringify(
        input.message
      )}</human_request>`;
  // The vendor session sleeps between turns; a resumed turn re-anchors turn
  // discipline with the compact preamble instead of the full prompt.
  // Full-Auto standing consent: fuse the safety block right after the base
  // prompt/preamble on BOTH the first and resumed turns. It remains absent when
  // the operator has not enabled Full-Auto.
  const fullAutoBlock = input.fullAuto ? FULL_AUTO_ORCHESTRATOR_BLOCK : "";
  const buildBrief = (options: {
    firstTurn: boolean;
    control?: string;
  }): string => {
    const contractSection = dispatchContract
      ? `${dispatchContract}\n\n`
      : "";
    const controlSection = options.control ? `${options.control}\n\n` : "";
    return options.firstTurn
      ? `${ORCHESTRATOR_SYSTEM_PROMPT}${fullAutoBlock}\n\n${contractSection}${controlSection}---\n\nThe chat's workspace folder is: ${chat.workspacePath}\n\n${payload}`
      : `${ORCHESTRATOR_TURN_PREAMBLE}${fullAutoBlock}\n\n${contractSection}${controlSection}${payload}`;
  };
  const brief = buildBrief({
    firstTurn: isFirstTurn,
    // A wake turn carries MUON's own reconciliation directive; a human turn
    // carries none, so its brief stays byte-identical to today's.
    ...(input.event
      ? { control: jobTerminalContinuation(input.event) }
      : {}),
  });

  const runner = await client
    .getRunner()
    .catch(() => ({ runner: null, live: false }));
  if (!runner.live) {
    throw new Error(
      "No persistent runner is online for orchestrator chat. Start or restart the runner, then retry."
    );
  }

  const baseline = await client
    .listStreamChunks({ taskId: chat.id, latest: true, limit: 1 })
    .catch(() => []);
  let afterSeq = baseline.at(-1)?.seq ?? 0;
  const effort = input.effort?.trim();
  const enqueueRoot = async (
    rootBrief: string,
    sessionId?: string,
    humanMessage?: string
  ): Promise<DispatchJobRecord> =>
    client.enqueueDispatch({
      kind: "session",
      vendor: laneKey,
      taskId: sessionTaskId,
      brief: rootBrief,
      chatId: chat.id,
      workspacePath: chat.workspacePath,
      ...(humanMessage !== undefined ? { humanMessage } : {}),
      // S4 wake: the ONE shape in which a non-operator caller (the always-alive
      // runner, which is agent-tier) may open a chat root. Named explicitly and
      // bound to the exact terminal child it reconciles, so the backend can
      // admit this continuation without admitting "an agent may start a chat".
      // Absent on every human turn, which therefore stays operator-only.
      ...(input.event
        ? {
            continuation: "job-terminal" as const,
            continuationJobId: input.event.jobId,
          }
        : {}),
      maxWallMs: input.maxWallMs ?? CHAT_TURN_TIMEOUT_MS,
      ...(input.maxDescendantWallMs !== undefined
        ? { maxDescendantWallMs: input.maxDescendantWallMs }
        : {}),
      // S10: apply the chat-level default model to the orchestrator's own turn.
      // Only sent when set, so an unset chat keeps today's behavior verbatim; the
      // route (S6) is the fail-closed authority that validates it.
      ...(input.model ? { model: input.model } : {}),
      // Effort rides the vendor-native `effort` action (profile patch / --effort).
      ...(effort
        ? {
            action: "effort",
            actionVendor: laneKey,
            actionArgs: [effort],
          }
        : {}),
      // Codex sessions are non-resumable (`canResume: false`). Passing a stale
      // thread id still launches a fresh process and confuses resume bookkeeping.
      ...(sessionId ? { resumeVendorSessionId: sessionId } : {}),
      ...(input.approvalTimeoutMs
        ? { approvalTimeoutMs: input.approvalTimeoutMs }
        : {}),
    });

  const waitForTerminal = async (
    dispatched: DispatchJobRecord
  ): Promise<DispatchJobRecord> => {
    const deadline = Date.now() + CHAT_TURN_TIMEOUT_MS;
    for (;;) {
      const terminal = await client.getDispatchJob(dispatched.id);
      const chunks = await client
        .listStreamChunks({
          taskId: chat.id,
          afterSeq,
          limit: 100,
        })
        .catch(() => []);
      for (const chunk of chunks) {
        if (chunk.kind === "output" || chunk.kind === "output.message") {
          input.onAssistantText?.(
            chunk.content,
            chunk.kind === "output.message" ? "message" : "delta"
          );
        } else {
          input.onStatus?.(chunk.content, chunk.detail ?? undefined);
        }
      }
      afterSeq = chunks.at(-1)?.seq ?? afterSeq;
      if (TERMINAL_STATUSES.has(terminal.status)) {
        return terminal;
      }
      if (input.signal?.aborted) {
        throw new Error(
          `Orchestrator chat dispatch '${dispatched.id}' was abandoned before completing (runner draining). It remains runner-owned and is reconciled by the next runner.`
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Orchestrator chat dispatch '${dispatched.id}' did not finish within ${CHAT_TURN_TIMEOUT_MS}ms. It remains runner-owned; interrupt it from the cockpit if needed.`
        );
      }
      await delay(CHAT_POLL_MS);
    }
  };

  const resultFor = async (
    terminal: DispatchJobRecord,
    overrideError?: string
  ): Promise<ChatTurnResult> => {
    const freshChat = await client.getChat(chat.id).catch(() => chat);
    const exitCode =
      overrideError === undefined
        ? terminal.exitCode ?? (terminal.status === "done" ? 0 : 1)
        : 1;
    const errorText =
      overrideError ??
      (terminal.status === "done" && exitCode === 0
        ? undefined
        : terminal.result?.slice(-500) || "the orchestrator turn failed");
    return {
      vendorSessionId:
        sessionCapability(laneKey).persistsSessionHandle &&
        freshChat.vendorSessionVendor === laneKey &&
        freshChat.vendorSessionRootJobId === terminal.id
          ? freshChat.vendorSessionId ?? undefined
          : undefined,
      exitCode,
      errorText,
    };
  };

  // The backend commits the trusted human stream row and the root job in one
  // serializable transaction. A concurrent sender that loses root admission
  // therefore cannot leave an orphan `[you]` row in Mission Chat.
  const job = await enqueueRoot(
    brief,
    resumeVendorSessionId,
    isEventTurn ? undefined : input.message
  );
  if (!isEventTurn && chat.title === "New chat") {
    await client
      .updateChat({ chatId: chat.id, title: input.message.slice(0, 60) })
      .catch(() => undefined);
  }
  if (admissionStatus) {
    await client.recordStreamChunks([
      {
        taskId: chat.id,
        laneId: "muon-chat",
        kind: "milestone",
        content: admissionStatus,
      },
    ]);
    input.onStatus?.(admissionStatus);
  }
  const terminal = await waitForTerminal(job);
  const initialResult = await resultFor(terminal);
  if (
    terminal.status !== "done" ||
    initialResult.exitCode !== 0 ||
    dispatchMode !== "crew-required"
  ) {
    return initialResult;
  }

  const jobsAfterInitial = await client.listDispatchJobs({
    chatId: chat.id,
    limit: CHAT_JOB_WINDOW,
  });
  if (jobsAfterInitial.length >= CHAT_JOB_WINDOW) {
    throw new Error(
      "Cannot verify the coordinator dispatch contract within the bounded 200-job chat window; no automatic correction was started."
    );
  }
  const initialProof = await confirmCrewProof(
    client,
    chat.id,
    sessionTaskId,
    jobsAfterInitial,
    [job.id],
    crewPlan!.requiredChildCount
  );
  if (initialProof.complete) {
    const successStatus =
      `[contract.crew] Verified ${initialProof.taskIds.length} governed child ` +
      `dispatch(es) on distinct filed tasks for root ${job.id}. ` +
      crewEvidence(initialProof, false);
    await client.recordStreamChunks([
      {
        taskId: chat.id,
        laneId: "muon-chat",
        kind: "milestone",
        content: successStatus,
      },
    ]);
    input.onStatus?.(successStatus);
    return initialResult;
  }

  // The retry is the same already-admitted human turn, but it is still fenced
  // by durable chat/root state. Never write or dispatch after archival, and
  // never race a second surface's newly admitted root.
  const correctionChat = await client.getChat(chat.id);
  if (correctionChat.status === "archived") {
    throw new Error(
      "The orchestrator chat was archived before its dispatch-contract correction; no continuation was started."
    );
  }
  const competingRoot = (
    await client.listDispatchJobs({
      chatId: chat.id,
      activeRootOnly: true,
      limit: 200,
    })
  ).find((candidate) => !candidate.parentJobId);
  if (competingRoot) {
    throw new Error(
      `A new active root dispatch '${competingRoot.id}' (${competingRoot.status}) appeared before the dispatch-contract correction; no competing continuation was started.`
    );
  }

  const retryStatus =
    `[contract.retry] Root ${job.id} did not prove the governed crew contract; ` +
    "starting the one bounded coordinator correction.";
  const correctionSessionId =
    sessionCapability(laneKey).persistsSessionHandle &&
    correctionChat.vendorSessionVendor === laneKey &&
    correctionChat.vendorSessionRootJobId === job.id
      ? correctionChat.vendorSessionId ?? undefined
      : undefined;
  const correctionBrief = buildBrief({
    firstTurn: !correctionSessionId,
    control: coordinatorCorrection([job.id], crewPlan!, initialProof),
  });
  const correctionJob = await enqueueRoot(
    correctionBrief,
    correctionSessionId
  );
  await client.recordStreamChunks([
    {
      taskId: chat.id,
      laneId: "muon-chat",
      kind: "milestone",
      content: `${retryStatus} Root ${correctionJob.id} was admitted.`,
    },
  ]);
  const correctionTerminal = await waitForTerminal(correctionJob);
  const correctionResult = await resultFor(correctionTerminal);
  if (
    correctionTerminal.status !== "done" ||
    correctionResult.exitCode !== 0
  ) {
    return correctionResult;
  }

  const jobsAfterCorrection = await client.listDispatchJobs({
    chatId: chat.id,
    limit: CHAT_JOB_WINDOW,
  });
  if (jobsAfterCorrection.length >= CHAT_JOB_WINDOW) {
    return resultFor(
      correctionTerminal,
      "Cannot verify whether the corrective coordinator created a governed child within the bounded 200-job chat window. No further automatic continuation was attempted."
    );
  }
  const correctionProof = await confirmCrewProof(
    client,
    chat.id,
    sessionTaskId,
    jobsAfterCorrection,
    [job.id, correctionJob.id],
    crewPlan!.requiredChildCount
  );
  if (correctionProof.complete) {
    const successStatus =
      `[contract.crew] Verified ${correctionProof.taskIds.length} governed child ` +
      `dispatch(es) on distinct filed tasks across roots ${job.id},${correctionJob.id}. ` +
      crewEvidence(correctionProof, false);
    await client.recordStreamChunks([
      {
        taskId: chat.id,
        laneId: "muon-chat",
        kind: "milestone",
        content: successStatus,
      },
    ]);
    input.onStatus?.(successStatus);
    return correctionResult;
  }

  // Evidence first, boilerplate last: the desktop clamps this to the first 400
  // characters of a red box, so the leading sentences have to say what was
  // found and what was required. Two full root UUIDs used to occupy that space
  // ahead of any fact a human could act on.
  const contractFailure =
    `Coordinator dispatch contract failed: ${correctionProof.summary}. ` +
    `${crewEvidence(correctionProof, true)} ` +
    `Unmet: ${correctionProof.deficiencies.join("; ")}. ` +
    `Roots '${job.id}' and '${correctionJob.id}'. ` +
    "Task records without admitted child jobs were not counted. No further automatic continuation was attempted. " +
    "Check capability preflight, fleet capacity, and dispatch/delegate tool errors, then retry. " +
    // The exact remedy, last: a brief that declares these headings passes.
    `A compliant child brief declares ${briefHeadingList()}`;
  const failureStatus = `[contract.failed] ${contractFailure}`;
  await client.recordStreamChunks([
    {
      taskId: chat.id,
      laneId: "muon-chat",
      kind: "milestone",
      content: failureStatus,
    },
  ]);
  input.onStatus?.(failureStatus);
  return resultFor(correctionTerminal, contractFailure);
}
