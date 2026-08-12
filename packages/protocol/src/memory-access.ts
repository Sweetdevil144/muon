import { z } from "zod";

/** TODO 4.12 — why a note entered an agent's working context. */
export const MEMORY_ACCESS_TYPES = [
  "brief_injection",
  "explicit_recall",
  "preedit_gate",
  // Rolling upgrades can briefly pair a new backend with an older producer.
  // Preserve the signal without pretending the older client supplied a type.
  "legacy_used",
] as const;

export const memoryAccessTypeSchema = z.enum(MEMORY_ACCESS_TYPES);
export type MemoryAccessType = z.infer<typeof memoryAccessTypeSchema>;

/** Hard storage bound enforced in the append transaction, per note. */
export const MEMORY_ACCESS_HISTORY_PER_NOTE = 128;
/** Hard analytics scan bound; the newest rows win when the corpus is larger. */
export const MEMORY_ACCESS_ANALYTICS_MAX_ROWS = 50_000;

export const memoryAccessTypeMetricSchema = z
  .object({
    accessType: memoryAccessTypeSchema,
    accessedUnconfirmedNotes: z.number().int().nonnegative(),
    laterHumanConfirmedNotes: z.number().int().nonnegative(),
    confirmationRate: z.number().min(0).max(1).nullable(),
  })
  .strict();

export const memoryAccessAnalyticsSchema = z
  .object({
    rowsScanned: z.number().int().nonnegative(),
    distinctNotes: z.number().int().nonnegative(),
    retainedPerNote: z.literal(MEMORY_ACCESS_HISTORY_PER_NOTE),
    truncated: z.boolean(),
    firstAccessAt: z.string().nullable(),
    lastAccessAt: z.string().nullable(),
    byType: z.array(memoryAccessTypeMetricSchema),
    interpretation: z.literal("association_not_causation"),
  })
  .strict();

export type MemoryAccessTypeMetric = z.infer<
  typeof memoryAccessTypeMetricSchema
>;
export type MemoryAccessAnalytics = z.infer<typeof memoryAccessAnalyticsSchema>;
