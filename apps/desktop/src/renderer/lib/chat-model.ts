import {
  isDefaultModel,
  validateModelForVendor,
  type VendorKey,
} from "@muon/adapters/vendor-capabilities";

/**
 * S10 chat-level model helpers (renderer-pure, no IPC).
 *
 * The orchestrator chat runs on the operator-chosen seat (claude-code or
 * codex). These helpers are the client-side, advisory half of the model lever:
 * they refuse fast and surface degrade warnings so nothing is silent, while
 * the dispatch route stays the FAIL-CLOSED authority.
 */
export type ModelCommand = { model: string };

/**
 * Detect a literal leading `/model <id>` a HUMAN typed into the composer. It is
 * intercepted client-side and NEVER forwarded to the orchestrator: the
 * super-agent sets WORKER models through `dispatch(model=…)` (S6) but must never
 * be able to rewrite its own chat's root model by emitting chat prose
 * (payload-is-data). Returns the trimmed id, `""` for a bare `/model` (reset to
 * the vendor default), or `null` when the message is not a model command.
 */
export function parseModelCommand(message: string): ModelCommand | null {
  const match = /^\/model(?:\s+([\s\S]*))?$/.exec(message.trim());
  if (!match) {
    return null;
  }
  return { model: (match[1] ?? "").trim() };
}

export type ModelChangeOutcome =
  | { kind: "clear"; note: string }
  | { kind: "set"; model: string; note: string }
  | { kind: "reject"; note: string };

/**
 * Resolve a requested chat-level model change through the S5 validation
 * authority. Pure — the caller applies the outcome to state and surfaces
 * `note`. A rejected id never enters the per-chat store (fail-closed at the UI
 * too); an unknown-but-allowed id is accepted WITH its degrade warning relayed.
 */
export function resolveModelChange(
  model: string | null,
  // WAVE D: REQUIRED. This carried a `= CHAT_MODEL_VENDOR` default that named
  // one vendor, and the single live caller already passed the real seat — so the
  // default was a latent trap: a future caller that forgot the argument would
  // have silently validated against the wrong vendor's catalogue.
  vendor: string
): ModelChangeOutcome {
  const trimmed = (model ?? "").trim();
  // TODO 3.6: bare `/model`, empty string, and the Default sentinel all mean
  // "let the vendor decide" — clear the chat override rather than storing
  // `muon/default` as if it were a model id.
  if (trimmed === "" || isDefaultModel(trimmed)) {
    return {
      kind: "clear",
      note: `Model reset to the ${vendor} default for this chat.`,
    };
  }
  // TODO 3.3: `VendorKey` IS `VendorId` now, so this cast no longer crosses a
  // divergence — it only widens `string` to the registry union, and an id the
  // registry does not name still lands on the honest "no declared policy"
  // degrade rather than on another vendor's catalogue.
  const check = validateModelForVendor(vendor as VendorKey, trimmed);
  if (!check.ok) {
    return { kind: "reject", note: `✗ ${check.reason ?? "invalid model"}` };
  }
  return {
    kind: "set",
    model: trimmed,
    note: check.warning
      ? `Model set to ${trimmed} for this chat — ${check.warning}.`
      : `Model set to ${trimmed} for this chat.`,
  };
}
