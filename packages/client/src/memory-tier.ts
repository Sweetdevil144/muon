// P0-3 (one tier vocabulary) made ONE rule out of three desktop spellings of
// "who vouches for this note" — and then the CLI restated that rule privately
// (`confirmFlag` / `awaitingHumanReview` in apps/cli memory.ts) and drifted:
// it never learned the crew-visible "auto" tier, so the same note read
// "Auto · crew memory" on the desktop and "[unconfirmed]" in the terminal.
// This module is the rule's single home; both surfaces now import it.
//
// TRUST DISCIPLINE: this is a PRESENTATION vocabulary only. Nothing here can
// confirm a note, and the only tier that unlocks anything durable ("human")
// is read straight off the ledger's human-only `confirmed` flag (ADR-0027).

/** The minimal note shape the tier rule reads — browser-safe, structural. */
export interface MemoryTierNote {
  confirmed: boolean;
  /** `"human" | "orchestrator" | null` on the wire; wider here so both the
   *  renderer's and the CLI's note types satisfy it structurally. */
  confirmedBy?: string | null;
  createdBy: string;
  /** Server-derived at read time; never re-derive from `expiresAt`. */
  expired?: boolean;
  status: string;
}

export type MemoryNoteTier =
  /** A PERSON confirmed it — the only tier that unlocks global-scope
   *  promotion, pack export and the KG-6 destructive-write protection. */
  | "human"
  /** The crew's coordinator vouched on the record: settled, durable. */
  | "muon"
  /** Crew-VISIBLE under the operator's auto posture, but nobody vouched.
   *  The visibility is to the note's OWN mission's crew (recall is
   *  chat-fenced); this presentation tier carries no mission dimension, so
   *  an operator surface labels a note of a finished mission the same way —
   *  which is still true of what its crew COULD read, not a wider claim. */
  | "auto"
  /** Nobody vouched and nothing is carrying it — the ONE tier that is a debt. */
  | "open";

/** Human iff the KG-5 convention: bare "" / "human" / a "human:" prefix.
 *  Everything else (agent ids, vendor names, "muon*") is agent-authored. */
export function isHumanMemoryPrincipal(createdBy: string): boolean {
  const value = createdBy.trim().toLowerCase();
  return value === "" || value === "human" || value.startsWith("human:");
}

/**
 * The one confirm-tier a surface may describe a note with.
 *
 * `autoConfirmAgentMemory` is the operator's crew-visible toggle (backend
 * operator-settings.ts). Callers that cannot read it pass `false` and get the
 * strict presentation — the fail-closed direction: a note is never described
 * as MORE settled than the rule allows.
 */
export function memoryNoteTier(
  note: MemoryTierNote,
  autoConfirmAgentMemory: boolean
): MemoryNoteTier {
  if (note.confirmed) return "human";
  // A lapsed note is pending again whatever once vouched for it: nothing is
  // vouching for it NOW, and a human confirm is the only way back.
  if (note.expired === true) return "open";
  if (note.confirmedBy === "orchestrator") return "muon";
  if (
    autoConfirmAgentMemory &&
    note.status === "active" &&
    !isHumanMemoryPrincipal(note.createdBy)
  ) {
    return "auto";
  }
  return "open";
}
