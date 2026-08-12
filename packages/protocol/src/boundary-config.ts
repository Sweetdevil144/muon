import { z } from "zod";

// ── Governed boundary configs (TODO 5.8) ─────────────────────────────────────
//
// Vendor hook surfaces (Cursor's `.cursor/hooks.json` among them) treat
// `failClosed` as OPTIONAL and default it to false — hook failures then ALLOW
// the action through. MUON names the fail direction IN DATA: every boundary
// hook entry this package serializes carries an explicit required `failClosed`.
//
// QM-inspired Strict / Auto org-floor naming lives in
// docs/research/quartermaster-yc-qm.md — MUON does not copy Dangerous as a
// product posture.

/** One command hook on a governed boundary. `failClosed` is REQUIRED here. */
export const boundaryHookEntrySchema = z
  .object({
    type: z.literal("command"),
    command: z.string().min(1),
    matcher: z.string().min(1),
    failClosed: z.boolean(),
  })
  .strict();
export type BoundaryHookEntry = z.infer<typeof boundaryHookEntrySchema>;

/** The run-scoped Cursor hooks document MUON writes for native fan-out denial. */
export const cursorHooksBoundarySchema = z
  .object({
    version: z.literal(1),
    hooks: z
      .object({
        preToolUse: z.array(boundaryHookEntrySchema).min(1),
      })
      .strict(),
  })
  .strict();
export type CursorHooksBoundary = z.infer<typeof cursorHooksBoundarySchema>;

/**
 * Validate and serialize a Cursor hooks boundary. Parsing is the enforcement
 * point: a document missing `failClosed` on any entry is refused, not patched.
 */
export function serializeCursorHooksBoundary(
  boundary: CursorHooksBoundary
): string {
  return `${JSON.stringify(cursorHooksBoundarySchema.parse(boundary), null, 2)}\n`;
}
