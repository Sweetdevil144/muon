import {
  DELEGATION_MAX_CHILDREN,
  FLEET_MAX_AGENTS_PER_VENDOR,
  publicVendorIds,
  vendorRoleCeiling,
  type AgentRole,
} from "@muon/protocol";
import type {
  FleetReadinessReport,
  FleetSnapshot,
  VendorCredentialMethod,
  VendorReadiness,
} from "./types.js";
import { buildOnboardingState, vendorOnboardingStep } from "./onboarding.js";
import { sanitizeVendorErrorMessage } from "./vendor-error.js";

/**
 * P0.5 — the bounded capability-preflight contract.
 *
 * ONE pure, browser-safe projection (no node built-ins, same discipline as
 * `onboarding.ts`) that turns already-fetched control-plane evidence into the
 * report every surface (CLI `muon doctor --json`, the MCP tool, the desktop
 * DiagnosticsStrip) renders. Agents query this before planning work they
 * cannot execute.
 *
 * INVARIANTS (structural, not textual):
 *  - Never a credential value, token value, or ambient environment dump —
 *    fixed provenance labels and variable NAMES only.
 *  - Degraded/unknown states stay honest: every one carries a STABLE reason
 *    code and a concrete next action; a failed probe degrades to
 *    unknown+reason, never a crash or a lie.
 *  - A usable BYOK/custom-provider account can never read as logged out: the
 *    projection derives auth from readiness evidence alone and never inspects
 *    detail text for login phrases.
 *  - A role-scoped lane (cursor, opencode) is never reported as ready for work it
 *    cannot hold. Dispatch-readiness is answered PER ROLE; asked without one it
 *    answers for the role an un-planned dispatch actually resolves to.
 *  - CAPACITY IS MEASURED, NEVER ASSUMED: the seats a lane reports are the seats
 *    the fleet actually has. Unreadable capacity reads as unknown (`null` + a
 *    reason code), never as the configurable ceiling.
 */

export const CAPABILITY_PREFLIGHT_VERSION = 1 as const;

/** CLOSED enum. Adding a code is a deliberate contract change (update the drift test). */
export const PREFLIGHT_REASON_CODES = [
  "CONTROL_PLANE_UNREACHABLE",
  "RUNNER_OFFLINE",
  "RUNNER_STARTING",
  "RUNNER_STALE_HEARTBEAT",
  "RUNNER_UNKNOWN",
  "SANDBOX_UNAVAILABLE",
  "READINESS_UNAVAILABLE",
  "NO_VENDOR_DISPATCH_READY",
  "VENDOR_NOT_INSTALLED",
  "VENDOR_SETUP_NEEDED",
  "VENDOR_AUTH_UNKNOWN",
  "VENDOR_PROVIDER_UNCONFIGURED",
  // Was CURSOR_TAKEOVER_ONLY. Cursor is no longer takeover-only — it is a
  // managed READ-ONLY lane — and it is no longer the only partially-managed
  // vendor, so the code names the actual condition: connected, and dispatchable
  // for part of the role taxonomy.
  "VENDOR_ROLE_SCOPED",
  // Fewer worker seats exist for this lane than one parent may fan out to, so a
  // full-width same-vendor crew QUEUES instead of running in parallel. Reported
  // because a coordinator that cannot see this plans a parallel crew against
  // capacity that does not exist and never learns why its workers serialized.
  "VENDOR_FANOUT_SERIALIZES",
  // ZERO worker seats: this lane cannot take work at all. A DISTINCT state from
  // the one above, because "queues instead of running in parallel" is false at
  // zero — nothing queues. `POST /api/fleet/agents/claim` refuses outright
  // ("Fleet has zero '<vendor>' agents"), so a dispatch here never runs.
  "VENDOR_NO_SEATS",
  // The fleet could not be read, so seat counts are unknown for every lane.
  // A capacity question MUON cannot answer is answered "unknown", never "3".
  "FLEET_CAPACITY_UNKNOWN",
  "GRAPH_DEGRADED",
] as const;
export type PreflightReasonCode = (typeof PREFLIGHT_REASON_CODES)[number];

export type PreflightDegradation = {
  code: PreflightReasonCode;
  surface: "brain" | "runner" | "fleet" | "vendor" | "graph";
  /** Set when surface === "vendor". */
  vendor?: string;
  severity: "info" | "warning" | "blocking";
  /** Sanitized human sentence, never a credential. */
  reason: string;
  /** Concrete remediation (verbatim fixHint when available). */
  nextAction: string;
};

export type PreflightExecutionMode = "one-shot" | "interactive" | "background";

/** Static mirror of adapters vendor-capabilities (drift-locked in packages/mcp tests). */
export const VENDOR_EXECUTION_MODES: Record<string, PreflightExecutionMode[]> =
  {
    "claude-code": ["one-shot", "interactive", "background"],
    codex: ["one-shot", "interactive", "background"],
    // Managed read-only: MUON runs one `cursor-agent --print` per dispatch and
    // there is no session driver, so there is nothing interactive to offer.
    cursor: ["one-shot", "background"],
    // Managed read-only recon: one `opencode run` per dispatch, no session
    // driver (`--session`/`serve` exist but are not wired in v1).
    opencode: ["one-shot", "background"],
  };

/**
 * The crew roles MUON will dispatch each lane for — a projection of THE registry
 * (ADR-0022 §3.2), still drift-locked against the adapters' own declarations in
 * packages/mcp tests.
 *
 * A vendor absent from this map has NO declared scope, and absence now means it
 * holds nothing. It used to be read as `?? AGENT_ROLES` — unrestricted — on
 * three surfaces including this one, which made an unknown lane read as
 * dispatch-ready for every role (ADR-0022 §1.2(b)).
 */
export const VENDOR_DISPATCH_ROLES: Record<string, readonly AgentRole[]> =
  Object.fromEntries(
    publicVendorIds().map((vendor) => [vendor, vendorRoleCeiling(vendor)])
  );

/**
 * The role a dispatch that names none actually resolves to (the backend's
 * `resolveDispatchRole` fallback). So "is this lane dispatch-ready?" asked
 * WITHOUT a role is answered honestly as "can it take un-planned work?" — which
 * is what keeps a cursor-only fleet reported as not dispatch-ready.
 */
const UNPLANNED_DISPATCH_ROLE: AgentRole = "implementer";

/** Active limits, fixed product constants (drift-locked against backend/adapters in tests). */
export const PREFLIGHT_LIMITS = {
  /**
   * FLEET_MAX_PER_VENDOR (backend/src/routes/fleet.ts) — the ceiling an operator
   * may RESIZE to. A policy bound, NOT a statement about seats that exist: read
   * `PreflightVendor.activeLimits.seatedAgents` for what a lane can actually run
   * at once.
   */
  maxAgentsPerVendor: FLEET_MAX_AGENTS_PER_VENDOR,
  /**
   * DELEGATION_MAX_CHILDREN (@muon/protocol) — how wide ONE parent may fan a
   * mission out. Published beside the seat counts because the comparison
   * "seats < this" is exactly the difference between a crew that runs in
   * parallel and one that queues.
   */
  maxParallelChildrenPerDispatch: DELEGATION_MAX_CHILDREN,
  /** DEFAULT_PROBE_TIMEOUT_MS (adapters/vendor-readiness.ts). */
  readinessProbeTimeoutMs: 6000,
  /** DEFAULT_READINESS_TTL_MS (adapters/vendor-readiness.ts). */
  readinessCacheTtlMs: 8000,
  /** RUNNER_LIVE_WINDOW_MS (backend/src/routes/dispatch.ts). */
  runnerLiveWindowMs: 15000,
  dispatchKinds: ["auto", "oneshot", "session", "loop"],
} as const;
export type PreflightLimits = typeof PREFLIGHT_LIMITS;

export type PreflightVendor = {
  vendor: string;
  label: string;
  installed: boolean;
  auth: "authenticated" | "unauthenticated" | "unknown";
  /** installed && authenticated (connected). */
  ready: boolean;
  /** ready && this lane may hold the role in question (see `role` on the input). */
  dispatchReady: boolean;
  /** Crew roles this lane may be dispatched for (all of them when unscoped). */
  dispatchRoles: AgentRole[];
  boundary:
    | "dispatch-ready"
    | "role-scoped"
    | "setup-required"
    | "unknown";
  /** Fixed provenance labels ONLY, never derived from login-phrase text. */
  authMethod: VendorCredentialMethod | "none" | "unknown";
  /** [] until the lane is connected; a property of the lane, not of the role. */
  executionModes: PreflightExecutionMode[];
  /**
   * What this lane can actually run, measured from the fleet — never a product
   * constant dressed up as capacity.
   *
   * The field used to be `{ maxAgents: FLEET_MAX_PER_VENDOR }`, a fixed 3. A
   * coordinator read that as "three of these can run at once", planned a 3-way
   * parallel crew, and got a queue: exactly ONE dispatchable seat existed. The
   * ceiling is still published (`maxConfigurableAgents`) but it is now named for
   * what it is, and the capacity answer comes from seats that exist.
   */
  activeLimits: {
    /** Worker seats (ordinal ≥ 1) that exist for this lane; null = unread. */
    seatedAgents: number | null;
    /** Seats idle right now — immediate parallel capacity; null = unread. */
    idleAgents: number | null;
    /** The ceiling an operator may resize to. A policy bound, not capacity. */
    maxConfigurableAgents: number;
  };
  /** Probe detail; parsed fields only, never a token. */
  detail: string;
  fixHint?: string;
  /**
   * Provider/version fingerprint copied verbatim from readiness (P0.1
   * checkpoint+resume evidence); `null` when never probed. Additive optional
   * carry — CAPABILITY_PREFLIGHT_VERSION stays 1; the run-bundle v2 bump is
   * the contract marker.
   */
  cliVersion: string | null;
};

export type CapabilityPreflight = {
  version: typeof CAPABILITY_PREFLIGHT_VERSION;
  generatedAt: string;
  status: "ready" | "degraded" | "blocked";
  headline: string;
  brainHealth: { state: "ok" | "unreachable"; detail: string };
  runnerHealth: {
    state: "live" | "starting" | "stale" | "offline" | "unknown";
    live: boolean;
    lastSeenAt?: string;
    /** Only when supervisor evidence supplied (desktop). */
    sandboxed?: boolean;
    /** NEVER lease/host/pid material. */
    detail: string;
  };
  /** [] when readiness unavailable. */
  vendors: PreflightVendor[];
  readiness: {
    source: "backend" | "unavailable";
    /** == buildOnboardingState(...).anyReady (cursor-excluded). */
    anyDispatchReady: boolean;
    readyVendors: string[];
    /** Backend probe freshness, honest staleness signal. */
    generatedAt?: string;
  };
  limits: PreflightLimits;
  degradations: PreflightDegradation[];
  invariants: {
    credentialValuesNeverIncluded: true;
    environmentVariableNamesOnly: true;
    byokNeverLoggedOut: true;
    /** A role-scoped lane is never reported ready for work it cannot hold. */
    roleScopedLanesNeverOverreported: true;
    degradedStatesCarryReasonCodes: true;
  };
};

export type PreflightSupervisorEvidence = {
  phase: "stopped" | "starting" | "live" | "backoff" | "degraded";
  sandboxed?: boolean;
  /**
   * WHY confinement is off (round-3 #9). Absent = the supplier could not say,
   * which keeps today's generic wording rather than inventing a cause.
   * Mirrors `SandboxAvailability` in `@muon/adapters`; restated as a union
   * here only because this module is browser-safe and must not import the
   * node-side sandbox package.
   */
  sandboxAvailability?:
    | "available"
    | "platform-unsupported"
    | "disabled-by-env"
    | "sandbox-exec-missing";
  note?: string;
};

/**
 * The honest reason + next action for an unconfined runner.
 *
 * The single generic sentence ("restart MUON to restore sandbox isolation")
 * was FALSE on every non-macOS host — there is no implementation to restore,
 * so restarting can never help — and it was the only thing MUON said about
 * the control that blinds a dispatched agent to the operator token.
 */
export function describeSandboxDegradation(
  availability: PreflightSupervisorEvidence["sandboxAvailability"]
): { reason: string; nextAction: string; permanent: boolean } {
  switch (availability) {
    case "platform-unsupported":
      return {
        reason:
          "Runner is live WITHOUT sandbox isolation: MUON confines dispatched agents on macOS only, so this host has none. A dispatched agent can read the MUON data dir, including the operator token.",
        nextAction:
          "Restarting does not help on this platform. Set MUON_REQUIRE_SANDBOX=1 to refuse unconfined dispatch instead of running without it.",
        permanent: true,
      };
    case "disabled-by-env":
      return {
        reason:
          "Runner is live without sandbox isolation because MUON_SANDBOX=0 disabled it.",
        nextAction: "Unset MUON_SANDBOX and restart MUON to restore isolation.",
        permanent: false,
      };
    case "sandbox-exec-missing":
      return {
        reason:
          "Runner is live without sandbox isolation: /usr/bin/sandbox-exec is missing, so Seatbelt cannot be applied.",
        nextAction:
          "Restore /usr/bin/sandbox-exec, or set MUON_REQUIRE_SANDBOX=1 to refuse unconfined dispatch.",
        permanent: true,
      };
    default:
      // The supplier did not say why. Keep the original wording rather than
      // guess a cause — an invented reason is worse than a vague one.
      return {
        reason:
          "Runner is live without sandbox isolation; local file isolation is limited.",
        nextAction:
          "Task permissions still apply; restart MUON to restore sandbox isolation.",
        permanent: false,
      };
  }
}

export type CapabilityPreflightInput = {
  brain: { reachable: boolean; detail?: string };
  /** null = route/probe unavailable (HONEST). */
  readiness: FleetReadinessReport | null;
  /**
   * The fleet as it actually is (worker seats only — `/api/fleet` and
   * `/api/fleet/agents` both already exclude reserved ordinal 0). null/undefined
   * = unreadable, which reports seat counts as unknown plus a
   * FLEET_CAPACITY_UNKNOWN degradation rather than inventing a number.
   *
   * Only `agents` is read: the rows are the single source that can answer both
   * "how many seats exist" and "how many are free right now", and they are the
   * SAME rows the claim route's semaphore selects from. Narrowed to that field
   * so a surface holding only the agent list (the TUI) can supply it.
   */
  fleet?: Pick<FleetSnapshot, "agents"> | null;
  /** null = unreadable. */
  runner: {
    runner: { status: string; lastSeenAt: string } | null;
    live: boolean;
  } | null;
  /** Desktop-only refinement. */
  supervisor?: PreflightSupervisorEvidence;
  graph?: { degraded: boolean; reason?: string };
  /**
   * The crew role the caller is planning for. Dispatch-readiness is answered
   * against it, so "can cursor take this?" is a question with an actual answer.
   * Omitted = the un-planned dispatch role (see UNPLANNED_DISPATCH_ROLE).
   */
  role?: AgentRole;
  /** Injectable for tests. */
  now?: Date;
};

/**
 * The seats one lane actually holds, derived from the fleet snapshot.
 *
 * Counted from `agents` rather than trusted from `counts`: the two agree in the
 * backend's own projection, and the row list is the one that can also answer
 * "how many are free right now". A snapshot MUON could not read yields
 * `{ null, null }` — an unknown capacity stays unknown.
 */
function seatsFor(
  vendor: string,
  fleet: Pick<FleetSnapshot, "agents"> | null | undefined
): { seatedAgents: number | null; idleAgents: number | null } {
  if (!fleet || !Array.isArray(fleet.agents)) {
    return { seatedAgents: null, idleAgents: null };
  }
  const seats = fleet.agents.filter((agent) => agent.vendor === vendor);
  return {
    seatedAgents: seats.length,
    idleAgents: seats.filter((agent) => agent.status === "idle").length,
  };
}

/** Project one readiness row into the preflight vendor shape. */
function projectVendor(
  entry: VendorReadiness,
  role: AgentRole | undefined,
  fleet: Pick<FleetSnapshot, "agents"> | null | undefined
): PreflightVendor {
  const step = vendorOnboardingStep(entry);
  const auth: PreflightVendor["auth"] =
    entry.authState === "unknown"
      ? "unknown"
      : entry.authenticated
        ? "authenticated"
        : "unauthenticated";
  // Fixed provenance labels ONLY — never derived from login-phrase text.
  // This plus the adapters' probe order IS the BYOK invariant.
  const authMethod: PreflightVendor["authMethod"] =
    auth === "authenticated"
      ? (entry.credentialMethod ?? "vendor-login")
      : auth === "unknown"
        ? "unknown"
        : "none";
  const ready = step.step === "ready";
  // ROLE-AWARE DISPATCH READINESS. A lane is dispatchable for the roles it
  // declares and no others, so the answer depends on the role being planned.
  // With no role named, the question is "can it take un-planned work?".
  // FAIL-CLOSED: a lane MUON does not name holds no role, so it is reported
  // role-scoped and never dispatch-ready. (Was `?? AGENT_ROLES`.)
  const dispatchRoles = VENDOR_DISPATCH_ROLES[entry.vendor] ?? [];
  const holdsRole = dispatchRoles.includes(role ?? UNPLANNED_DISPATCH_ROLE);
  const dispatchReady = ready && holdsRole;
  const boundary: PreflightVendor["boundary"] =
    dispatchReady
      ? "dispatch-ready"
      : ready
        ? "role-scoped"
        : auth === "unknown"
          ? "unknown"
          : "setup-required";
  return {
    vendor: entry.vendor,
    label: step.label,
    installed: entry.installed,
    auth,
    ready,
    dispatchReady,
    dispatchRoles: [...dispatchRoles],
    boundary,
    authMethod,
    executionModes: ready
      ? (VENDOR_EXECUTION_MODES[entry.vendor] ?? ["one-shot"])
      : [],
    activeLimits: {
      ...seatsFor(entry.vendor, fleet),
      maxConfigurableAgents: PREFLIGHT_LIMITS.maxAgentsPerVendor,
    },
    // Defensive re-redaction: the probe already builds detail from parsed
    // fields, this makes token leakage structurally impossible here too.
    detail: sanitizeVendorErrorMessage(entry.detail),
    fixHint: entry.fixHint,
    // Copied verbatim (a version ref, not a secret); NEVER invented.
    cliVersion: entry.cliVersion ?? null,
  };
}

/** The vendor-level degradation for one row, or null when the row is clean. */
function vendorDegradation(
  entry: VendorReadiness,
  row: PreflightVendor,
  guidance: string
): PreflightDegradation | null {
  const base = { surface: "vendor" as const, vendor: entry.vendor };
  if (!entry.installed) {
    return {
      ...base,
      code: "VENDOR_NOT_INSTALLED",
      severity: "warning",
      reason: row.detail,
      nextAction:
        entry.fixHint ?? `Install the ${row.label} CLI, then re-check.`,
    };
  }
  if (row.auth === "unknown") {
    return {
      ...base,
      code: "VENDOR_AUTH_UNKNOWN",
      severity: "warning",
      reason: row.detail,
      // NEVER sign-in language: unknown is a probe outage, not a logout.
      nextAction:
        "Re-check readiness with refresh; if it persists, run the vendor CLI's own status command.",
    };
  }
  if (entry.authState === "provider-unconfigured") {
    return {
      ...base,
      code: "VENDOR_PROVIDER_UNCONFIGURED",
      severity: "warning",
      reason: row.detail,
      nextAction: entry.fixHint ?? guidance,
    };
  }
  if (!entry.authenticated) {
    return {
      ...base,
      code: "VENDOR_SETUP_NEEDED",
      severity: "warning",
      reason: row.detail,
      nextAction: entry.fixHint ?? guidance,
    };
  }
  if (!row.dispatchReady) {
    // Connected, but managed for only part of the role taxonomy: informational,
    // never a warning — the lane is doing exactly what it is for.
    return {
      ...base,
      code: "VENDOR_ROLE_SCOPED",
      severity: "info",
      reason: `${row.label} is connected and managed for these crew roles only: ${row.dispatchRoles.join(", ")}.`,
      nextAction: `Dispatch ${row.label} under one of those roles; send other work to a lane that can hold it.`,
    };
  }
  const seats = row.activeLimits.seatedAgents;
  // ZERO seats is not a slow lane, it is a CLOSED one: the fleet claim refuses
  // (`Fleet has zero '<vendor>' agents`), so work sent here never runs and
  // nothing queues. Saying "at most 0 of its agents run at once; a wider
  // fan-out queues instead of running in parallel" — as the serialization
  // sentence below literally did at 0 — describes behaviour that does not
  // exist. A warning, not info: the lane reads connected and role-holding while
  // refusing every dispatch, and only the human can reopen it.
  if (seats === 0) {
    return {
      ...base,
      code: "VENDOR_NO_SEATS",
      severity: "warning",
      reason: `${row.label} is connected but has NO worker seats, so MUON cannot run anything on it — a dispatch to this lane is refused when its agent is claimed, not queued.`,
      nextAction: `Give ${row.label} at least one seat (\`muon fleet set --${entry.vendor} 1..${PREFLIGHT_LIMITS.maxAgentsPerVendor}\`), or plan this crew on another dispatch-ready lane.`,
    };
  }
  // Dispatch-ready, but narrower than one parent's fan-out: a crew planned at
  // full width on THIS lane will queue, and the coordinator has no other way to
  // find that out — the children are accepted, they simply run one after
  // another. Informational, because queueing is correct behaviour; what was
  // wrong was that it happened invisibly.
  if (
    seats !== null &&
    seats >= 1 &&
    seats < PREFLIGHT_LIMITS.maxParallelChildrenPerDispatch
  ) {
    return {
      ...base,
      code: "VENDOR_FANOUT_SERIALIZES",
      severity: "info",
      reason: `${row.label} has ${seats} worker seat${
        seats === 1 ? "" : "s"
      }, so at most ${seats} of its agents run at once; a fan-out wider than that queues instead of running in parallel.`,
      nextAction: `Plan at most ${seats} concurrent ${row.label} child${
        seats === 1 ? "" : "ren"
      }, spread the crew across other dispatch-ready lanes, or resize the fleet (up to ${PREFLIGHT_LIMITS.maxAgentsPerVendor} per vendor).`,
    };
  }
  return null;
}

type RunnerHealth = CapabilityPreflight["runnerHealth"];

function deriveRunnerHealth(
  runner: CapabilityPreflightInput["runner"],
  supervisor: PreflightSupervisorEvidence | undefined
): { health: RunnerHealth; degradation: PreflightDegradation | null } {
  const sandboxed = supervisor ? supervisor.sandboxed : undefined;
  const withSandbox = (health: RunnerHealth): RunnerHealth =>
    sandboxed === undefined ? health : { ...health, sandboxed };

  if (runner === null) {
    return {
      health: withSandbox({
        state: "unknown",
        live: false,
        detail: "Runner status could not be read.",
      }),
      degradation: {
        code: "RUNNER_UNKNOWN",
        surface: "runner",
        severity: "warning",
        reason: "Runner status could not be read.",
        nextAction: "Re-check after confirming the control plane is up.",
      },
    };
  }

  const row = runner.runner;
  if (runner.live) {
    return {
      health: withSandbox({
        state: "live",
        live: true,
        lastSeenAt: row?.lastSeenAt,
        detail: "Runner heartbeat is live.",
      }),
      degradation:
        supervisor && supervisor.sandboxed === false
          ? (() => {
              const described = describeSandboxDegradation(
                supervisor.sandboxAvailability
              );
              return {
                code: "SANDBOX_UNAVAILABLE",
                surface: "runner",
                // A cause that cannot be fixed from here is a standing
                // property of the host, not a passing note.
                severity: described.permanent
                  ? ("warning" as const)
                  : ("info" as const),
                reason: described.reason,
                nextAction: described.nextAction,
              };
            })()
          : null,
    };
  }

  if (row && row.status === "starting") {
    return {
      health: withSandbox({
        state: "starting",
        live: false,
        lastSeenAt: row.lastSeenAt,
        detail:
          "Runner is starting; dispatched work stays queued until its heartbeat arrives.",
      }),
      degradation: {
        code: "RUNNER_STARTING",
        surface: "runner",
        severity: "warning",
        reason:
          "Runner is starting; dispatched work stays queued until its heartbeat arrives.",
        nextAction: "Wait for the runner heartbeat, then re-check.",
      },
    };
  }

  if (row && (supervisor?.phase === "live" || row.status === "online")) {
    return {
      health: withSandbox({
        state: "stale",
        live: false,
        lastSeenAt: row.lastSeenAt,
        detail: "Runner process evidence exists, but its heartbeat is stale.",
      }),
      degradation: {
        code: "RUNNER_STALE_HEARTBEAT",
        surface: "runner",
        severity: "warning",
        reason: "Runner process evidence exists, but its heartbeat is stale.",
        nextAction:
          "Restart the runner; queued work resumes when the heartbeat returns.",
      },
    };
  }

  return {
    health: withSandbox({
      state: "offline",
      live: false,
      lastSeenAt: row?.lastSeenAt,
      detail: "No live runner is claiming dispatched work.",
    }),
    degradation: {
      code: "RUNNER_OFFLINE",
      surface: "runner",
      severity: "warning",
      reason: "No live runner is claiming dispatched work.",
      nextAction: "Start `muon runner` or open the MUON desktop app.",
    },
  };
}

/** Build the versioned capability preflight from already-fetched evidence. */
export function buildCapabilityPreflight(
  input: CapabilityPreflightInput
): CapabilityPreflight {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const brainReachable = input.brain.reachable;
  const brainHealth: CapabilityPreflight["brainHealth"] = brainReachable
    ? { state: "ok", detail: "The local control plane is reachable." }
    : {
        state: "unreachable",
        detail: input.brain.detail
          ? sanitizeVendorErrorMessage(input.brain.detail)
          : "The local control plane could not be reached.",
      };

  // Per-vendor rows reuse the onboarding machine — no duplicate probe logic.
  const readinessVendors = input.readiness?.vendors ?? null;
  const onboarding = buildOnboardingState(readinessVendors);
  const fleet = input.fleet ?? null;
  const vendors = (readinessVendors ?? []).map((entry) =>
    projectVendor(entry, input.role, fleet)
  );
  // Derived from the ROWS, not from the onboarding "connected" set: a lane that
  // is connected but cannot hold the role in question is not dispatch capacity.
  const anyDispatchReady = vendors.some((row) => row.dispatchReady);

  const { health: runnerHealth, degradation: runnerDegradation } =
    deriveRunnerHealth(input.runner, input.supervisor);

  // Degradations, deterministic order: brain → runner → fleet → vendors
  // (readiness order) → graph.
  const degradations: PreflightDegradation[] = [];
  if (!brainReachable) {
    // Root-cause suppression: one actionable degradation; the runner/fleet
    // sections above still report their own honest states.
    degradations.push({
      code: "CONTROL_PLANE_UNREACHABLE",
      surface: "brain",
      severity: "blocking",
      reason: "The local control plane could not be reached.",
      nextAction: "Restart MUON; if it remains offline, run muon doctor.",
    });
  } else {
    if (runnerDegradation) degradations.push(runnerDegradation);

    if (input.readiness === null) {
      degradations.push({
        code: "READINESS_UNAVAILABLE",
        surface: "fleet",
        severity: "warning",
        reason: "Crew readiness could not be checked.",
        nextAction:
          "Open Setup and check providers again, or run `muon onboard`.",
      });
    } else if (!anyDispatchReady) {
      degradations.push({
        code: "NO_VENDOR_DISPATCH_READY",
        surface: "fleet",
        severity: "warning",
        reason:
          input.readiness.warning ??
          "No crew member is ready to take a mission yet.",
        nextAction:
          "Connect or configure at least one coding agent, then re-check.",
      });
    }

    // Seat counts are unknown for EVERY lane, so say so once at the fleet
    // surface rather than leaving each row's `null` to be read as "none".
    if (fleet === null) {
      degradations.push({
        code: "FLEET_CAPACITY_UNKNOWN",
        surface: "fleet",
        // INFO, not warning: unknown parallel capacity is a gap in what MUON can
        // claim, not a broken system — every lane may still be perfectly
        // dispatchable. Warning would flip the whole doctor headline to "needs
        // attention" for a single unread route, which is the same overclaiming
        // in the other direction.
        severity: "info",
        reason:
          "The fleet could not be read, so how many agents each lane can run at once is unknown.",
        nextAction:
          "Re-check once the control plane responds; until then plan one child per lane rather than assuming parallel capacity.",
      });
    }

    (readinessVendors ?? []).forEach((entry, index) => {
      const row = vendors[index];
      if (!row) return;
      const guidance =
        onboarding.vendors[index]?.guidance ??
        `Connect ${row.label}, then re-check.`;
      const degradation = vendorDegradation(entry, row, guidance);
      if (degradation) degradations.push(degradation);
    });

    if (input.graph?.degraded) {
      degradations.push({
        code: "GRAPH_DEGRADED",
        surface: "graph",
        severity: "info",
        reason: input.graph.reason ?? "Code-graph evidence is degraded.",
        nextAction: "Re-index the workspace, then re-check.",
      });
    }
  }

  const blocking = degradations.some((d) => d.severity === "blocking");
  const warnCount = degradations.filter((d) => d.severity === "warning").length;
  const status: CapabilityPreflight["status"] = blocking
    ? "blocked"
    : warnCount > 0
      ? "degraded"
      : "ready";
  const readyCount = onboarding.readyVendors.length;
  const headline =
    status === "ready"
      ? `Ready · ${readyCount} crew ${readyCount === 1 ? "member" : "members"} ready`
      : status === "degraded"
        ? `Needs attention · ${warnCount} ${warnCount === 1 ? "item" : "items"}`
        : "Control offline";

  return {
    version: CAPABILITY_PREFLIGHT_VERSION,
    generatedAt,
    status,
    headline,
    brainHealth,
    runnerHealth,
    vendors,
    readiness: {
      source: input.readiness ? "backend" : "unavailable",
      anyDispatchReady,
      readyVendors: onboarding.readyVendors,
      generatedAt: input.readiness?.generatedAt,
    },
    limits: PREFLIGHT_LIMITS,
    degradations,
    invariants: {
      credentialValuesNeverIncluded: true,
      environmentVariableNamesOnly: true,
      byokNeverLoggedOut: true,
      roleScopedLanesNeverOverreported: true,
      degradedStatesCarryReasonCodes: true,
    },
  };
}

// ---- The fail-safe collector -------------------------------------------------

/**
 * Structural client seam: any object with these methods works (the real
 * MuonApiClient, an MCP-injected client, a test stub). Optional methods mirror
 * older client builds; a missing method degrades to that source's unknown
 * state.
 */
export type CapabilityPreflightClient = {
  health(): Promise<{ status: string }>;
  getFleetReadinessReport?(opts?: {
    refresh?: boolean;
  }): Promise<FleetReadinessReport>;
  getVendorReadiness?(opts?: { refresh?: boolean }): Promise<VendorReadiness[]>;
  getRunner?(): Promise<{
    runner: { status: string; lastSeenAt: string } | null;
    live: boolean;
  }>;
  /** Absent or throwing ⇒ seat counts degrade to unknown, never to a guess. */
  getFleet?(): Promise<FleetSnapshot>;
};

/** Fail-safe collector: NEVER rejects; every unreadable source degrades to its unknown state. */
export async function collectCapabilityPreflight(
  client: CapabilityPreflightClient,
  opts?: {
    refresh?: boolean;
    supervisor?: PreflightSupervisorEvidence;
    graph?: { degraded: boolean; reason?: string };
    now?: Date;
  }
): Promise<CapabilityPreflight> {
  const refresh = opts?.refresh === true;
  const [brain, readiness, runner, fleet] = await Promise.all([
    client
      .health()
      .then(() => ({ reachable: true }) as { reachable: boolean; detail?: string })
      .catch((error: unknown) => ({
        reachable: false,
        detail: sanitizeVendorErrorMessage(error),
      })),
    (async (): Promise<FleetReadinessReport | null> => {
      try {
        if (typeof client.getFleetReadinessReport === "function") {
          return await client.getFleetReadinessReport({ refresh });
        }
        if (typeof client.getVendorReadiness === "function") {
          return { vendors: await client.getVendorReadiness({ refresh }) };
        }
        return null;
      } catch {
        return null;
      }
    })(),
    (async () => {
      try {
        if (typeof client.getRunner === "function") {
          return await client.getRunner();
        }
        return null;
      } catch {
        return null;
      }
    })(),
    (async (): Promise<FleetSnapshot | null> => {
      try {
        if (typeof client.getFleet === "function") {
          return await client.getFleet();
        }
        return null;
      } catch {
        return null;
      }
    })(),
  ]);
  return buildCapabilityPreflight({
    brain,
    readiness,
    runner,
    fleet,
    supervisor: opts?.supervisor,
    graph: opts?.graph,
    now: opts?.now,
  });
}
