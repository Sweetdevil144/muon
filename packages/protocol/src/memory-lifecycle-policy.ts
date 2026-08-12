import { z } from "zod";

/** TODO 4.11: every durable memory kind must have an explicit lifecycle row. */
export const MEMORY_LIFECYCLE_KINDS = [
  "decision",
  "constraint",
  "convention",
  "attempt",
  "question",
] as const;

export type MemoryLifecycleKind = (typeof MEMORY_LIFECYCLE_KINDS)[number];
export type MemoryLifecycleTrustCeiling = "low" | "medium";

const lifecycleDaysSchema = z.number().int().min(0).max(3_650);

/**
 * Days are evaluated at write time. `0` means this kind never auto-expires.
 * Human-authored, human-confirmed, and high-trust notes remain permanent
 * invariants regardless of the table.
 */
export const memoryLifecyclePolicySchema = z
  .object({
    version: z.literal(1),
    trustCeiling: z.enum(["low", "medium"]),
    daysByKind: z
      .object({
        decision: lifecycleDaysSchema,
        constraint: lifecycleDaysSchema,
        convention: lifecycleDaysSchema,
        attempt: lifecycleDaysSchema,
        question: lifecycleDaysSchema,
      })
      .strict(),
    // An invariant represented in the table, not an accidental consequence of
    // the legacy global TTL. Literals make it visible without making authority
    // revocation an operator dial.
    permanentWhenConfirmedByKind: z
      .object({
        decision: z.literal(true),
        constraint: z.literal(true),
        convention: z.literal(true),
        attempt: z.literal(true),
        question: z.literal(true),
      })
      .strict(),
  })
  .strict();

export type MemoryLifecyclePolicy = z.infer<
  typeof memoryLifecyclePolicySchema
>;

/**
 * The proposed kind table. It is never activated as a default: an existing
 * install stays on its legacy global TTL until an operator previews and applies
 * the migration. Questions turn over quickly; failed/working attempts keep the
 * old 30-day horizon; slower-moving knowledge gets a longer review window.
 */
export const RECOMMENDED_MEMORY_LIFECYCLE_POLICY: MemoryLifecyclePolicy = {
  version: 1,
  trustCeiling: "medium",
  daysByKind: {
    decision: 90,
    constraint: 90,
    convention: 90,
    attempt: 30,
    question: 7,
  },
  permanentWhenConfirmedByKind: {
    decision: true,
    constraint: true,
    convention: true,
    attempt: true,
    question: true,
  },
};

export type MemoryLifecyclePolicyParse =
  | { ok: true; policy: MemoryLifecyclePolicy }
  | { ok: false; reason: string };

export function parseMemoryLifecyclePolicy(
  value: unknown
): MemoryLifecyclePolicyParse {
  const parsed = memoryLifecyclePolicySchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      reason:
        parsed.error.issues[0]?.message ?? "invalid memory lifecycle policy",
    };
  }
  return { ok: true, policy: parsed.data };
}

export function lifecycleDaysForKind(
  policy: MemoryLifecyclePolicy,
  kind: MemoryLifecycleKind
): number {
  return policy.daysByKind[kind];
}
