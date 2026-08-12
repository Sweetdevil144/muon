import {
  AGENT_ROLES,
  ROLE_SPECS,
  crewRolePlanSchema,
  type AgentRole,
  type CrewRolePlan,
  type LaneCapabilities,
  type LaneHealthStatus,
  type RoleBinding,
} from "@muon/protocol";

/**
 * ROLE ASSIGNMENT ENGINE (VISION §2): MUON's answer to "who does what".
 *
 * Deterministic and pure by construction — the same inputs always produce the
 * same plan. That matters for three reasons: the human can predict what MUON
 * will do, the plan is diffable in review, and no model call sits between the
 * human's intent and the crew's shape. A lane model may *propose* a mission
 * plan elsewhere; role binding itself is arithmetic.
 *
 * The engine can only pick WHO. It never decides what an agent is allowed to
 * do — that is `narrowProfileForRole` + `assertProfileMatchesRole` in the
 * protocol, applied at launch.
 */

export type LaneCandidate = {
  /** Lane id as dispatched: "claude-code" | "codex" | "cursor" | "opencode" | … */
  vendor: string;
  displayName: string;
  capabilities: LaneCapabilities;
  health: LaneHealthStatus;
  /**
   * Declared ceiling. REQUIRED: `[]` means the lane holds no role at all, and
   * there is no third state. It used to be optional, and `undefined` read as
   * "unconstrained" — so a lane assembled without the field was ranked for every
   * role, `orchestrator` included (ADR-0022 §1.2(b)).
   */
  supportedRoles: readonly AgentRole[];
  /** Adapter's own 0..1 opinion per role. */
  roleAffinity?: Partial<Record<AgentRole, number>>;
  /**
   * Relative running cost, 0 = free/local, 1 = premium frontier. Used only to
   * break ties and to prefer a local lane for cheap reconnaissance.
   */
  cost?: number;
};

export type RoleFit = {
  fit: number;
  reason: string;
  blocked: boolean;
  blockedReason?: string;
};

/**
 * Assignment order. Roles that constrain the mission most are bound first, so
 * a scarce healthy lane goes to the job that cannot proceed without it. The
 * order is fixed (not derived from input order) to keep the plan deterministic.
 */
const ROLE_PRIORITY: readonly AgentRole[] = [
  "orchestrator",
  "implementer",
  "reviewer",
  "architect",
  "qa",
  "docs",
  "scout",
];

/**
 * Capability-derived default affinity, used when an adapter has no opinion.
 * Deliberately coarse: it exists so an unknown future vendor gets a sane
 * ranking without core needing to know its name.
 */
function capabilityAffinity(
  capabilities: LaneCapabilities,
  role: AgentRole
): number {
  const spec = ROLE_SPECS[role];
  let score = 0.5;
  if (spec.authority === "write") {
    score += capabilities.supportsWorktrees ? 0.2 : -0.3;
    score += capabilities.supportsApprovals ? 0.1 : 0;
  }
  if (spec.authority === "coordinate") {
    score += capabilities.canBackground ? 0.15 : -0.25;
    score += capabilities.canInterrupt ? 0.15 : -0.2;
  }
  if (spec.authority === "read-only") {
    // Read-only roles need very little; streaming is the only real ergonomic.
    score += capabilities.canStreamEvents ? 0.1 : 0;
  }
  return clamp01(score);
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

const HEALTH_MULTIPLIER: Record<LaneHealthStatus, number> = {
  healthy: 1,
  degraded: 0.6,
  unavailable: 0,
};

function missingCapabilities(
  lane: LaneCandidate,
  role: AgentRole
): string[] {
  return ROLE_SPECS[role].requiredCapabilities.filter(
    (capability) => !lane.capabilities[capability]
  );
}

/**
 * Score one lane for one role. A blocked fit is not "low" — it is refused, so a
 * caller cannot accidentally rank around a hard constraint.
 */
export function roleFit(lane: LaneCandidate, role: AgentRole): RoleFit {
  // The ceiling is checked FIRST and unconditionally: a lane is considered for
  // exactly the roles it declares, never for a role it merely has the
  // capabilities to perform. OpenCode is the case that makes the difference
  // visible — it streams, backgrounds and interrupts, so every capability check
  // below would pass for `reviewer`, `qa`, `architect` and `docs`.
  if (!lane.supportedRoles.includes(role)) {
    return {
      fit: 0,
      reason: `${lane.displayName} does not offer the ${role} role`,
      blocked: true,
      blockedReason: `${lane.displayName} is not integrated for ${role} work in MUON`,
    };
  }

  const missing = missingCapabilities(lane, role);
  if (missing.length > 0) {
    return {
      fit: 0,
      reason: `${lane.displayName} lacks ${missing.join(", ")}`,
      blocked: true,
      blockedReason: `${role} requires ${missing.join(", ")}`,
    };
  }

  if (lane.health === "unavailable") {
    return {
      fit: 0,
      reason: `${lane.displayName} is unavailable`,
      blocked: true,
      blockedReason: `${lane.displayName} is not installed or not reachable`,
    };
  }

  const declared = lane.roleAffinity?.[role];
  const base =
    typeof declared === "number"
      ? clamp01(declared)
      : capabilityAffinity(lane.capabilities, role);

  // Cheap lanes are preferred for cheap work and penalized for the roles where
  // a weak model is actively harmful (anything that writes or adjudicates).
  const cost = clamp01(lane.cost ?? 0.5);
  const costAdjustment =
    role === "scout"
      ? (1 - cost) * 0.1
      : ROLE_SPECS[role].authority === "read-only"
        ? 0
        : cost * 0.05;

  const fit = clamp01((base + costAdjustment) * HEALTH_MULTIPLIER[lane.health]);
  const healthNote = lane.health === "degraded" ? ", degraded" : "";
  return {
    fit,
    reason: `${lane.displayName} fits ${role} (${fit.toFixed(2)}${healthNote})`,
    blocked: false,
  };
}

export type AssignRolesInput = {
  chatId: string;
  lanes: readonly LaneCandidate[];
  /**
   * Roles the mission needs. Defaults to the full `ROLE_PRIORITY` list, which
   * INCLUDES `orchestrator` — the coordinator seat is a role like any other and
   * a complete crew plan should name who holds it.
   */
  roles?: readonly AgentRole[];
  /**
   * Human overrides, role → vendor. A pin is honored even at a lower fit — the
   * human outranks the engine — but a pin to a BLOCKED lane is recorded as
   * blocked rather than silently granted.
   */
  pinned?: Readonly<Partial<Record<AgentRole, string>>>;
  /**
   * Penalty applied when a lane already holds another role in this plan. Small
   * by default: crews are usually smaller than the role list, so reuse must be
   * possible, just not preferred.
   */
  reusePenalty?: number;
  /**
   * WAVE E (ADR-0022 §4) — the operator's ordered quality preference among
   * lanes, applied as the tie-break BEFORE `input.lanes.indexOf`.
   *
   * IT CAN NEVER GRANT. By the time this is consulted the lane has already
   * passed `roleFit` unblocked, so a preference only reorders lanes that were
   * ALL going to be legal choices. Naming a lane here does not make it eligible
   * for a role its ceiling refuses, and naming a lane MUON does not run does
   * nothing at all.
   *
   * When absent, behaviour is byte-identical to before: every lane ranks
   * `Infinity`, every comparison ties, and the decision falls through to the
   * construction-order tie-break exactly as it did.
   */
  preference?: readonly string[];
};

/**
 * Bind roles to lanes. Every binding carries its own reason string so the crew
 * view can explain itself without a second round-trip.
 */
export function assignRoles(input: AssignRolesInput): CrewRolePlan {
  const roles = dedupeRoles(input.roles ?? ROLE_PRIORITY);
  const ordered = ROLE_PRIORITY.filter((role) => roles.includes(role)).concat(
    roles.filter((role) => !ROLE_PRIORITY.includes(role))
  );
  const reusePenalty = input.reusePenalty ?? 0.15;

  // Rank by FIRST occurrence, so a duplicated id in the operator's list keeps
  // its strongest position rather than its weakest.
  const preferenceRank = new Map<string, number>();
  (input.preference ?? []).forEach((vendor, index) => {
    if (!preferenceRank.has(vendor)) {
      preferenceRank.set(vendor, index);
    }
  });
  const rankOf = (lane: LaneCandidate): number =>
    preferenceRank.get(lane.vendor) ?? Number.POSITIVE_INFINITY;

  const bindings: RoleBinding[] = [];
  const unfilled: AgentRole[] = [];
  const held = new Map<string, number>();

  for (const role of ordered) {
    const pinnedVendor = input.pinned?.[role];
    if (pinnedVendor) {
      const lane = input.lanes.find((entry) => entry.vendor === pinnedVendor);
      if (!lane) {
        unfilled.push(role);
        continue;
      }
      const fit = roleFit(lane, role);
      bindings.push({
        vendor: lane.vendor,
        role,
        fit: fit.fit,
        reason: `Pinned by you: ${lane.displayName} holds ${role}`,
        assignedBy: "human",
        blocked: fit.blocked,
        ...(fit.blockedReason ? { blockedReason: fit.blockedReason } : {}),
      });
      held.set(lane.vendor, (held.get(lane.vendor) ?? 0) + 1);
      continue;
    }

    let best: { lane: LaneCandidate; fit: RoleFit; adjusted: number } | undefined;
    for (const lane of input.lanes) {
      const fit = roleFit(lane, role);
      if (fit.blocked) {
        continue;
      }
      const adjusted = clamp01(
        fit.fit - reusePenalty * (held.get(lane.vendor) ?? 0)
      );
      if (
        !best ||
        adjusted > best.adjusted ||
        // Tie-breaks, in order:
        //  1. the OPERATOR's preference (empty by default, so this is inert
        //     unless a caller supplied one), then
        //  2. construction order — the stable fallback that makes an identical
        //     crew always produce an identical plan.
        (adjusted === best.adjusted &&
          (rankOf(lane) < rankOf(best.lane) ||
            (rankOf(lane) === rankOf(best.lane) &&
              input.lanes.indexOf(lane) < input.lanes.indexOf(best.lane))))
      ) {
        best = { lane, fit, adjusted };
      }
    }

    if (!best) {
      unfilled.push(role);
      continue;
    }

    bindings.push({
      vendor: best.lane.vendor,
      role,
      fit: best.fit.fit,
      reason: best.fit.reason,
      assignedBy: "muon",
      blocked: false,
    });
    held.set(best.lane.vendor, (held.get(best.lane.vendor) ?? 0) + 1);
  }

  return crewRolePlanSchema.parse({
    version: 1,
    chatId: input.chatId,
    bindings,
    unfilled,
  });
}

function dedupeRoles(roles: readonly AgentRole[]): AgentRole[] {
  const seen = new Set<AgentRole>();
  const out: AgentRole[] = [];
  for (const role of roles) {
    if (!AGENT_ROLES.includes(role) || seen.has(role)) {
      continue;
    }
    seen.add(role);
    out.push(role);
  }
  return out;
}

/** Convenience lookup used by dispatch: which lane holds this role? */
export function vendorForRole(
  plan: CrewRolePlan,
  role: AgentRole
): string | undefined {
  return plan.bindings.find(
    (binding) => binding.role === role && !binding.blocked
  )?.vendor;
}

/** Convenience lookup used by the crew UI: what roles does this lane hold? */
export function rolesForVendor(
  plan: CrewRolePlan,
  vendor: string
): AgentRole[] {
  return plan.bindings
    .filter((binding) => binding.vendor === vendor && !binding.blocked)
    .map((binding) => binding.role);
}
