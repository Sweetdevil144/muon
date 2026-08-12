import { createHash } from "node:crypto";

// ── P0.4 slice 2: content-bound approval receipts, shared helpers ────────────
//
// A receipt binds an operator decision to the EXACT action it approved: tool,
// payload digest, workspace, run (jobId), and the job's delegation manifest at
// mint time. These helpers compute the manifest fingerprint and render check
// command lines so the mint classifies the SAME bytes the enforcement seam
// classifies. `lib/gate.ts` (route-gate redemption, P0.1) is deliberately
// untouched: receipts get their own redemption path, mirroring — never
// mutating — the consume-before-allow semantics.

/** Recursively sort object keys so the fingerprint is key-order independent. */
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
 * Canonical hash of a job's delegation manifest (the `hashProposal` pattern:
 * deterministic JSON, sha256, truncated to 128 bits). Recomputed from the
 * CURRENT job row at redemption, so ANY manifest drift after mint re-gates —
 * a receipt can never authorize a widened tool surface.
 */
export function fingerprintManifest(manifest: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableJson(manifest)))
    .digest("hex")
    .slice(0, 32);
}

/**
 * The rendered command line of one configured check — MUST stay byte-identical
 * to the runner's rendering (`packages/runner/src/execute.ts`, the
 * `checkCommands` mapping at the `startManagedSession` call), because `test`
 * classification is a byte-equality check on exactly these strings. A drift
 * between the two renderings is safe in direction (mint refuses / seam gates),
 * but keep them in lockstep.
 */
export function renderCheckCommand(check: {
  command: string;
  args?: string[];
}): string {
  return check.args && check.args.length > 0
    ? `${check.command} ${check.args.join(" ")}`
    : check.command;
}
