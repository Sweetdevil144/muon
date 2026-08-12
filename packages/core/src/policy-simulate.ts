import type {
  PolicyAction,
  PolicyActionClass,
  PolicyDecision,
  PolicyProfile,
} from "@muon/protocol";

// ── P0.4 slice 1: pure dry-run policy simulator ─────────────────────────────
//
// `simulatePolicy` answers, for one action against one profile, what the
// profile WOULD decide (allow | gate | deny) and why. It is a pure function —
// no I/O, no approval filed, no receipt minted, the gate/approval enforcement
// path stays byte-identical. It exists only to power `muon policy explain` and
// to let us reason about a posture before any of it is wired into enforcement.

/**
 * The result of a DRY-RUN policy simulation: what a profile WOULD decide for an
 * action, and why. `decision` is one of allow | gate | deny; `reason` is a
 * bounded, deterministic, human-readable justification for `muon policy explain`.
 */
export type PolicySimulation = {
  decision: PolicyDecision;
  reason: string;
  actionClass: PolicyActionClass;
  /** For an edit: whether the target landed inside the task radius. */
  withinTaskRadius?: boolean;
};

/**
 * Is `path` inside one of the task-radius prefixes? A path matches a prefix when
 * it equals the prefix or sits under it (`prefix/...`). Trailing slashes are
 * normalized so `src` and `src/` behave identically. Pure and total: a missing
 * path, or an empty radius, is never inside.
 */
export function isWithinTaskRadius(
  path: string | undefined,
  taskRadius: readonly string[]
): boolean {
  if (!path) {
    return false;
  }
  const target = path.replace(/[\\/]+$/, "");
  return taskRadius.some((prefix) => {
    const root = prefix.replace(/[\\/]+$/, "");
    return target === root || target.startsWith(`${root}/`);
  });
}

// The subject phrase per class, so a reason reads as a full sentence regardless
// of the decision. Kept terse and free of any caller-controlled text.
const CLASS_SUBJECT: Record<PolicyActionClass, string> = {
  read: "reading/inspecting the workspace",
  test: "running the workspace's own tests",
  edit: "editing workspace files",
  network: "reaching outside the workspace",
  merge: "landing a change",
  ship: "deploying or publishing",
};

// The predicate phrase per decision.
const DECISION_CLAUSE: Record<PolicyDecision, string> = {
  allow: "is allowed without asking",
  gate: "requires human approval",
  deny: "is denied by this profile",
};

// Non-edit classes: subject + decision, fully determined by the profile posture.
function classReason(
  actionClass: PolicyActionClass,
  decision: PolicyDecision
): string {
  return `${actionClass}: ${CLASS_SUBJECT[actionClass]} ${DECISION_CLAUSE[decision]}.`;
}

// Edits carry a radius clause. The path is the only caller-controlled text; the
// action schema length-bounds it and we quote it so the reason stays greppable.
function editReason(
  decision: PolicyDecision,
  withinTaskRadius: boolean,
  path: string | undefined,
  radiusEmpty: boolean
): string {
  const target = path ? `"${path}"` : "an unspecified file";
  const radiusClause = withinTaskRadius
    ? "is inside the task radius"
    : radiusEmpty
      ? "is outside the task radius (none configured)"
      : "is outside the task radius";
  return `edit: editing ${target} ${radiusClause} — ${DECISION_CLAUSE[decision]}.`;
}

/**
 * Simulate one action against one profile. Total over every action class:
 *   • edit — inside the task radius uses `profile.editInRadius`, outside uses
 *     `profile.postures.edit`;
 *   • every other class — uses `profile.postures[class]` directly.
 * The always-ask classes (network/merge/ship) can never be `allow` because the
 * profile schema forbids it, so this function can only ever return gate/deny for
 * them regardless of input.
 */
export function simulatePolicy(
  action: PolicyAction,
  profile: PolicyProfile
): PolicySimulation {
  const actionClass = action.class;
  if (actionClass === "edit") {
    const withinTaskRadius = isWithinTaskRadius(action.path, profile.taskRadius);
    const decision = withinTaskRadius
      ? profile.editInRadius
      : profile.postures.edit;
    return {
      decision,
      actionClass,
      withinTaskRadius,
      reason: editReason(
        decision,
        withinTaskRadius,
        action.path,
        profile.taskRadius.length === 0
      ),
    };
  }
  const decision = profile.postures[actionClass];
  return {
    decision,
    actionClass,
    reason: classReason(actionClass, decision),
  };
}
