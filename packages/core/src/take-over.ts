import { codexGuardHomePath } from "@muon/adapters";

/**
 * ADR-0030 / WIKI §8.1 — the exact argv a HUMAN types to continue a session
 * in the vendor CLI itself. ONE home for this vendor lore (core, beside the
 * codex guard-home it needs); the TUI and CLI both render from here so the
 * surfaces cannot drift.
 *
 * Total over the vendor ids that can appear on a LaneSession; `null` is the
 * statement "no native take-over exists", not an omission.
 */
const TAKE_OVER_COMMANDS: Record<string, ((id: string) => string) | null> = {
  "claude-code": (id) => `claude --resume ${id}`,
  // Governed codex children run under an isolated guard home; the prefix is
  // part of the argv a human actually types (bare `codex resume` fails with
  // "No saved session found").
  codex: (id) => `CODEX_HOME=${codexGuardHomePath()} codex resume ${id}`,
  cursor: (id) => `cursor-agent --resume ${id}`,
  // One-shot `run` only in v1 — there is no session to hand back.
  opencode: null,
  // The dev/test double has no binary to take over.
  fake: null,
};

/** The native resume command for a vendor session, or null when none exists. */
export function takeOverArgv(
  vendorId: string,
  vendorSessionId: string
): string | null {
  return TAKE_OVER_COMMANDS[vendorId]?.(vendorSessionId) ?? null;
}
