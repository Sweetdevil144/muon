import { isAuthorizationFailure } from "@muon/client";
import { printError } from "./output.js";

/**
 * TODO 7.6 — turn a raw 401/403 into an actionable refusal.
 * Never leave the operator staring at "403 Forbidden" alone.
 */
export function formatRefusal(error: unknown, surface: string): string {
  if (isAuthorizationFailure(error)) {
    const detail =
      error instanceof Error && error.message.trim().length > 0
        ? error.message.replace(/^\d{3}\s+\w+\s*,?\s*/i, "").trim()
        : "";
    const why = detail.length > 0 ? ` (${detail})` : "";
    return (
      `you can only reach what this token authorizes for '${surface}'${why} — ` +
      `run \`muon agents\` to see the fleet, or use an operator token`
    );
  }
  return error instanceof Error ? error.message : String(error);
}

/** Exit 2 = authz refusal; 1 = other failure; 0 left unset on success. */
export function exitCodeForError(error: unknown): number {
  return isAuthorizationFailure(error) ? 2 : 1;
}

/**
 * The ONE catch-block ending for a failed CLI command.
 *
 * Before this, only 6 of 34 command files routed errors through
 * `formatRefusal`, so a 401/403 on any other verb printed a raw
 * "403 Forbidden" and exited 1 — and a script honoring the documented
 * contract (2 = the brain refused your authority) read it as an ordinary
 * failure. For non-authz errors the output is byte-identical to the
 * `printError(error instanceof Error ? error.message : fallback)` +
 * `process.exitCode = 1` idiom this replaces.
 *
 * `fallback` is the command's own human sentence ("Memory add failed."); its
 * leading clause doubles as the refusal's surface name.
 */
export function failCommand(error: unknown, fallback: string): void {
  if (isAuthorizationFailure(error)) {
    const surface = fallback.replace(/\s*failed\.?\s*$/i, "").trim() || "this command";
    printError(formatRefusal(error, surface));
    process.exitCode = 2;
    return;
  }
  printError(error instanceof Error ? error.message : fallback);
  process.exitCode = 1;
}
