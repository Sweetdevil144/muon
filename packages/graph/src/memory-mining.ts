/**
 * The vocabulary of MODEL-MINED memory: who authored it, and how a surface
 * names it. NOT a gate.
 *
 * F9 originally made this a gate — an unconfirmed model-mined note was withheld
 * from agent-facing surfaces outright, on the reasoning that the LLM extractor
 * reads UNTRUSTED sub-agent output so its note's TEXT is attacker-influenced
 * (its SHAPE was already bounded: allowlisted kind, 280-char clamp, server-owned
 * anchors/trust/createdBy). That hard exclusion is GONE, by founder decision:
 * mined notes are agent memory, so the ONE operator posture that already governs
 * "may unconfirmed agent memory reach the crew" — `autoConfirmAgentMemory`
 * (#133, default ON, backend/src/lib/operator-settings.ts) — governs them too.
 * Toggle ON: a mined note is crew-visible inside ITS OWN chat, exactly like any
 * other agent-authored note. Toggle OFF: the strict confirmed-only gate returns
 * for every agent note, mined included. There is no mined-specific rule left at
 * any read surface, and adding one back here would re-create the very asymmetry
 * that made the posture unreadable.
 *
 * What survives is the DISTINCTION, because a human reviewing a note later has
 * to know whether a machine wrote it. `confirmed` still means a human said so —
 * crew-visibility never sets it — so these predicates are what a review surface
 * uses to label a crew-visible-but-unconfirmed note as machine-extracted.
 *
 * WHY THIS IS MIRRORED RATHER THAN IMPORTED. `@muon/core` owns the vocabulary
 * (`memory-extract-lane.ts`), and this is a byte-faithful mirror of it — not a
 * second opinion. `@muon/graph` deliberately depends on NOTHING in the monorepo
 * (only `@ladybugdb/core`): it is the leaf that `backend` and `@muon/codegraph`
 * build on, and its evals run as a bare `node dist/graph-value-eval.js`. Pulling
 * `@muon/core` (→ `@muon/adapters` → the vendor CLI surface) into the leaf to
 * reuse three lines would invert that. This is the same trade the codebase
 * already makes in both directions — `@muon/core`'s `memory-capture.ts` PORTS
 * this package's capture logic, and the symbol-id provider mirrors `symbol-id.ts`
 * — and it is settled the same way: a drift canary test pins this copy to the
 * `@muon/core` source, so the two cannot diverge silently.
 */

/**
 * The principal EVERY model-mined note is authored by, and the one marker that
 * separates "an LLM wrote this prose" from "MUON captured this deterministically"
 * (`muon-capture`) or "an agent explicitly proposed it" (`agent:<vendor>`).
 */
export const MEMORY_EXTRACTOR_PRINCIPAL = "muon-extractor";

/** True iff `createdBy` names the LLM extractor. */
export function isModelMinedMemoryPrincipal(
  createdBy: string | null | undefined
): boolean {
  return (createdBy ?? "").trim().toLowerCase() === MEMORY_EXTRACTOR_PRINCIPAL;
}

/**
 * Model-mined AND not yet human-reviewed — the note a review surface must label
 * as machine-extracted, because it is readable (crew-visible) without a human
 * ever having vouched for it. Confirmation ends the label: a confirmed mined
 * note is ordinary human-governed memory.
 */
export function isUnreviewedModelMinedNote(note: {
  createdBy?: string | null;
  confirmed?: boolean | null;
}): boolean {
  return note.confirmed !== true && isModelMinedMemoryPrincipal(note.createdBy);
}
