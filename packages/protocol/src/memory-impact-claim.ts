import { z } from "zod";

/**
 * ADR-0063 — a note's machine-readable impact claim: a blast-radius
 * assertion the grounding verb can re-run `impact` against and diff
 * (ADR-0058 D2 check 3, made runnable).
 *
 * The fields mirror what `impact` itself reports, because the check is a
 * diff of like against like, not an interpretation. `direction` is pinned
 * to "upstream" in v1 — MUON's `code_impact` read is upstream-fixed, and a
 * claim the verb cannot re-run would be decorative. `atCommit` rides along
 * so drift reads as a timeline ("claimed 2 callers at <commit>, 5 now"),
 * never an accusation.
 *
 * Writers are EXPLICIT (ADR-0063 D2): `memory_add` and the packet capture
 * path accept it as an argument; no route ever extracts a claim from note
 * prose. Malformed is REJECTED at ingest, never stored.
 */
export const memoryImpactClaimSchema = z
  .object({
    v: z.literal(1),
    /** Exact symbol name the claim is about. */
    target: z.string().min(1).max(200),
    /** Optional file qualifier, so a same-named symbol in another module
     *  cannot validate (or contradict) the wrong claim. */
    module: z.string().min(1).max(512).optional(),
    direction: z.literal("upstream"),
    /** The commit the claim was measured at. */
    atCommit: z.string().min(4).max(64),
    summary: z
      .object({
        directCallers: z.number().int().nonnegative(),
        processes: z.number().int().nonnegative(),
        risk: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
      })
      .strict(),
  })
  .strict();

export type MemoryImpactClaim = z.infer<typeof memoryImpactClaimSchema>;

/** Parse a STORED claim (a ledger JSON string) defensively: rows passed the
 *  schema at ingest, but evidence must survive a corrupt or future row —
 *  unreadable resolves to null (not-checkable), never a throw. */
export function parseStoredImpactClaim(
  raw: string | null | undefined
): MemoryImpactClaim | null {
  if (!raw) return null;
  try {
    const parsed = memoryImpactClaimSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
