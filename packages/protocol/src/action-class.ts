import type { PolicyActionClass } from "./policy-profile.js";

// ── P0.4 slice 2: tool request → policy action class (shared canonicalization) ─
//
// One conservative, name-exact table maps a vendor tool request onto the coarse
// policy action classes. It lives in @muon/protocol for the same reason the
// gate-tag grammar does: the backend receipt mint and the core enforcement seam
// MUST compute byte-identical classes, or a receipt minted for one
// interpretation could be redeemed under another.
//
// Fail-closed by construction:
//   • anything not PROVABLY in-class returns `null`, and `null` means today's
//     gate path (ask a human) — never an auto-allow;
//   • `merge` and `ship` are deliberately underivable — `git push`,
//     `gh pr merge`, `npm publish` are unclassifiable Bash, so they gate every
//     time under every profile;
//   • Bash is `test` ONLY when the command byte-equals (after trimming) one of
//     the job's own configured checks — no substring, prefix, or shell-parse
//     heuristics that an adversarial command could satisfy.

/**
 * The action classes a receipt may ever carry: exactly the complement of
 * `ALWAYS_ASK_ACTION_CLASSES`. Network/merge/ship receipts are unrepresentable
 * — enforced at mint AND inside the redeem guard.
 */
export const RECEIPT_ALLOWED_CLASSES = ["read", "test", "edit"] as const;
export type ReceiptAllowedClass = (typeof RECEIPT_ALLOWED_CLASSES)[number];

/** A successful classification: the class, plus the target path for reads/edits. */
export type ClassifiedToolAction = {
  class: PolicyActionClass;
  path?: string;
};

// Name-exact vendor tool tables (Claude Code tool names). Codex JSON-RPC method
// names intentionally do NOT appear: codex sessions stay byte-identical to
// today until their tool surface gets its own audited table.
const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);

/**
 * Classify one tool request. `command`/`path` are the UNREDACTED fields of the
 * exact tool input; `checkCommands` is the job's `harness.checks ∪ job.checks`.
 * Returns `null` for everything not provably in-class (any other Bash, any
 * `mcp__*` tool, Task, unknown names, missing fields) — the caller MUST treat
 * `null` as "gate exactly as today".
 */
export function classifyToolAction(input: {
  toolName: string;
  command?: string;
  path?: string;
  checkCommands?: readonly string[];
}): ClassifiedToolAction | null {
  const { toolName, command, path, checkCommands } = input;

  // A read tool carrying a command field is not provably a read.
  if (READ_TOOLS.has(toolName) && command === undefined) {
    return path !== undefined ? { class: "read", path } : { class: "read" };
  }

  if (
    EDIT_TOOLS.has(toolName) &&
    typeof path === "string" &&
    path.trim().length > 0
  ) {
    return { class: "edit", path };
  }

  // Always-ask by type: reachable from here only as gate/deny (the profile
  // schema cannot express `allow` for network).
  if (NETWORK_TOOLS.has(toolName)) {
    return { class: "network" };
  }

  if (toolName === "Bash" && typeof command === "string") {
    const trimmed = command.trim();
    if (
      trimmed.length > 0 &&
      (checkCommands ?? []).some((check) => check.trim() === trimmed)
    ) {
      return { class: "test" };
    }
  }

  return null;
}
