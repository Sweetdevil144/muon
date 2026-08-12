/**
 * Post-week1 Wave A — partition for coordination readers (substrate §3.1).
 *
 * Memory notes are already workspace-fenced; live activity, recent activity, and
 * duplicate-work were scanning every running job machine-wide. The same
 * workspace (+ optional chat) predicate must sit in the *candidate query*, never
 * as a post-filter, or cross-workspace relative-path collisions leak presence.
 *
 * Fail-closed: without an explicit workspace and without an operator
 * `allowGlobal` opt-in, readers return []. Note: agent-tier
 * `unscopedWorkspace: true` from memoryReadWorkspace means the *empty residue*
 * view (no capability workspace), NOT a global scan — do not treat that flag as
 * allowGlobal.
 */

export type CoordinationPartition = {
  workspacePath?: string | null;
  chatId?: string | null;
  /**
   * Operator-only escape hatch. Must be set explicitly at the route from
   * `request.tier === "operator" && readWorkspace.unscopedWorkspace` — never
   * copied from `unscopedWorkspace` alone.
   */
  allowGlobal?: boolean;
};

/** True when the reader may scan every workspace (operator unscoped). */
export function coordinationUnscoped(
  partition?: CoordinationPartition | null
): boolean {
  return Boolean(partition?.allowGlobal);
}

/**
 * Fail-closed gate — INCLUDING when the partition is omitted entirely.
 *
 * This used to return `true` for an absent partition, and the reason was
 * written down honestly: "legacy callers that omit `partition` keep prior
 * behaviour (tests)". That is production safety weakened for test convenience,
 * and it is the exact shape that has broken this codebase repeatedly
 * (ADR-0022 rule 2): a rule that a NEW caller opts out of by not knowing it
 * exists. Every route caller already passes a partition, so nothing in
 * production changes; what changes is what the next caller inherits.
 *
 * Omission is not permission.
 */
export function coordinationPartitionReady(
  partition?: CoordinationPartition | null
): boolean {
  if (!partition) return false;
  if (coordinationUnscoped(partition)) return true;
  return Boolean(partition.workspacePath);
}

/**
 * Prisma `where` fragment for DispatchJob rows inside the partition.
 *
 * DEFENCE IN DEPTH, not a duplicate of the gate above. `coordinationPartitionReady`
 * is what callers check; this is what they build a query from, and it used to
 * return `{}` — no predicate at all, a machine-wide scan — for an omitted
 * partition. A future caller that built a query without checking the gate first
 * would therefore have read every workspace. It now returns a predicate that
 * matches nothing, so the failure mode of forgetting the gate is an empty
 * result rather than a disclosure.
 */
export function dispatchJobPartitionWhere(
  partition?: CoordinationPartition | null
): Record<string, unknown> {
  if (!partition) return MATCHES_NOTHING;
  if (coordinationUnscoped(partition)) return {};
  const where: Record<string, unknown> = {};
  if (partition.workspacePath) {
    where.workspacePath = partition.workspacePath;
  }
  if (partition.chatId) {
    where.chatId = partition.chatId;
  }
  return where;
}

/**
 * A predicate no `DispatchJob` row can satisfy. `id` is a cuid, never empty, so
 * this is unsatisfiable by construction rather than by a sentinel someone could
 * accidentally insert.
 */
const MATCHES_NOTHING: Record<string, unknown> = { id: { in: [] } };
