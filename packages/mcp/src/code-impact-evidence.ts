import { z } from "zod";

/**
 * ADR-0089 — impact evidence is TYPED at the boundary.
 *
 * `code_impact`'s output crosses a process boundary (the GitNexus CLI)
 * before any consumer sees it, and until this module three consumers —
 * `impact_memory`, `preflight_edit`, and the ADR-0063 ground check — each
 * re-decided what a verdict, a blast radius, and an index-freshness block
 * look like with their own defensive casts (D13's named drift shape). This
 * is the ONE spelling: the schema every consumer parses with, placed HERE
 * in packages/mcp because the producer and all three consumers live here —
 * deliberately NOT in @muon/protocol (an external CLI's adapter shape is
 * not a cross-package wire contract; promotion happens the day a second
 * package consumes it, as its own reviewed change).
 *
 * The hardest-won rule of the family is encoded as types, not comments:
 * `repo.stale` is a TRI-STATE — `false` is current, `true` is stale, and
 * `null`/absent is UNKNOWN, which is never clear. Every consumer's gate
 * reads `stale !== false`, and this schema keeps that expressible.
 *
 * `.passthrough()` everywhere: GitNexus may add fields; unknown keys ride
 * along untyped rather than being stripped (stripping is how a future
 * field silently vanishes between producer and consumer).
 *
 * PLACEMENT, deliberate (a review asked why the seam is not inside the
 * `code_impact` producer itself): the tool's `structuredContent` is
 * AGENT-FACING verbatim evidence — vendors read it — and normalizing the
 * wire payload (uppercased risk, coerced counts) would silently change
 * what every agent sees. The wire stays verbatim CLI truth; this seam
 * types MUON's OWN reads of it, which is where the drift lived.
 */
function coerceCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const impactNodeSchema = z
  .object({
    id: z.string().optional(),
    filePath: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

export const codeImpactEvidenceSchema = z
  .object({
    result: z
      .object({
        /** Normalized AT the seam (review finding: an arbitrary string
         *  left every consumer re-validating): the four-value vocabulary,
         *  or null for anything else — and null is unusable, never LOW. */
        risk: z
          .string()
          .optional()
          .transform((value) => {
            const upper = value?.toUpperCase();
            return upper === "LOW" ||
              upper === "MEDIUM" ||
              upper === "HIGH" ||
              upper === "CRITICAL"
              ? upper
              : null;
          }),
        /** Aggregate counts, coerced ONCE here: a finite number, or a
         *  NON-EMPTY numeric string, and nothing else — `Number("")`,
         *  `Number(false)`, and `Number([])` are all 0, and a fabricated
         *  zero is exactly the trusted-wrong-value this boundary exists to
         *  prevent (review finding). Anything else is null: absent
         *  evidence, never zero. */
        summary: z
          .object({
            direct: z.unknown().optional().transform(coerceCount),
            processes_affected: z.unknown().optional().transform(coerceCount),
          })
          .passthrough()
          .optional(),
        target: impactNodeSchema.optional(),
        /** Depth key ("1", "2", …) → the rows discovered at that depth. */
        byDepth: z
          .record(z.string(), z.array(impactNodeSchema))
          .optional(),
      })
      .passthrough(),
    repo: z
      .object({
        graphCommit: z.string().optional(),
        headCommit: z.string().optional(),
        /** The load-bearing tri-state: false=current, true=stale,
         *  null/absent=UNKNOWN — and UNKNOWN is never clear. */
        stale: z.boolean().nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type CodeImpactEvidence = z.infer<typeof codeImpactEvidenceSchema>;
export type CodeImpactResultEvidence = CodeImpactEvidence["result"];
export type CodeImpactRepoEvidence = CodeImpactEvidence["repo"];

/**
 * THE producing seam: turn a `code_impact` tool result into typed evidence,
 * exactly once per flow. An errored tool result or a payload the schema
 * cannot read yields a typed refusal with the reason — a parse failure is
 * "evidence unreadable", never a partially-cast object a consumer limps
 * along with.
 */
export function codeImpactEvidenceFromTool(
  impact:
    | { isError?: boolean; structuredContent?: Record<string, unknown> }
    | undefined
):
  | {
      ok: true;
      /** The NORMALIZED view — gate and compose with this. */
      evidence: CodeImpactEvidence;
      /** The VERBATIM halves, exactly as the tool published them — embed
       *  THESE in any payload an agent reads back (review finding: the
       *  handlers were re-opening structuredContent with their own casts
       *  to recover what this seam had already validated present). */
      raw: { result: Record<string, unknown>; repo: Record<string, unknown> };
    }
  | { ok: false; reason: string } {
  if (!impact || impact.isError) {
    const stated =
      impact?.structuredContent && "error" in impact.structuredContent
        ? String(impact.structuredContent.error)
        : "GitNexus impact evidence is unavailable";
    return { ok: false, reason: stated };
  }
  const parsed = codeImpactEvidenceSchema.safeParse(impact.structuredContent);
  if (!parsed.success) {
    return {
      ok: false,
      reason:
        "GitNexus returned impact evidence this build cannot read (schema mismatch) — treat the impact as UNKNOWN, never as clear",
    };
  }
  const content = impact.structuredContent ?? {};
  return {
    ok: true,
    evidence: parsed.data,
    raw: {
      result: content.result as Record<string, unknown>,
      repo: content.repo as Record<string, unknown>,
    },
  };
}
