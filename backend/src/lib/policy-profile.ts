import { createHash } from "node:crypto";
import { prisma } from "./db.js";

// ── The one definition of "the effective workspace policy" ────────────────────
//
// Precedence: task-scoped row > workspace-scoped row > no row. It was inlined in
// `routes/policy-profiles.ts` alone while only a reader needed it; ADR-0056 gave
// it a SECOND consumer — a durable approval grant is fingerprinted against the
// posture it was minted under, and re-fingerprinted from the CURRENT rows at
// redemption. Two hand-copies of a precedence rule is how a grant survives a
// policy change it should have died to, so there is exactly one.

/** Recursively sort object keys so a fingerprint is key-order independent. */
function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableJson(child)])
    );
  }
  return value;
}

/**
 * Canonical hash of a workspace policy profile — the `fingerprintManifest`
 * pattern (deterministic JSON, sha256, truncated to 128 bits), and it lives
 * HERE for the same reason `fingerprintManifest` lives in `lib/receipt.ts`
 * rather than in `@muon/protocol`: the protocol root is browser-safe and a
 * renderer displays a fingerprint, it never computes one. Only the server
 * computes this, and only the server enforces it.
 *
 * `null` (no profile row at all) has its own stable fingerprint rather than
 * being skipped: "no policy" is a posture, and moving from it to any profile
 * must invalidate exactly as loudly as moving between two profiles.
 */
export function fingerprintPolicyProfile(profile: unknown): string {
  return createHash("sha256")
    .update(
      profile == null
        ? "muon-policy-none-v1"
        : `muon-policy-v1\0${JSON.stringify(stableJson(profile))}`
    )
    .digest("hex")
    .slice(0, 32);
}

/** The effective profile row for a scope, or null when no row applies. */
export async function resolveEffectivePolicyProfile(scope: {
  workspacePath: string;
  taskId?: string | null;
}): Promise<{ profile: unknown; scope: "task" | "workspace"; version: number } | null> {
  const taskRecord = scope.taskId
    ? await prisma.workspacePolicyProfile.findUnique({
        where: {
          workspacePath_taskScope: {
            workspacePath: scope.workspacePath,
            taskScope: scope.taskId,
          },
        },
      })
    : null;
  const record =
    taskRecord ??
    (await prisma.workspacePolicyProfile.findUnique({
      where: {
        workspacePath_taskScope: {
          workspacePath: scope.workspacePath,
          taskScope: "",
        },
      },
    }));
  if (!record) {
    return null;
  }
  return {
    profile: record.profile,
    scope: record.taskScope ? "task" : "workspace",
    version: record.version,
  };
}

/**
 * Canonical fingerprint of the posture in force for a scope RIGHT NOW.
 *
 * "No profile row" is itself a posture and gets its own stable fingerprint
 * (`fingerprintPolicyProfile(null)`), so adding a first profile invalidates
 * grants exactly as loudly as editing an existing one. The scope label is folded
 * in too: a task-scoped override that shadows a workspace row is a different
 * posture from the workspace row alone, even when the two profiles happen to be
 * byte-identical today.
 */
export async function fingerprintEffectivePolicy(scope: {
  workspacePath: string;
  taskId?: string | null;
}): Promise<string> {
  const effective = await resolveEffectivePolicyProfile(scope);
  return fingerprintPolicyProfile(
    effective ? { scope: effective.scope, profile: effective.profile } : null
  );
}
