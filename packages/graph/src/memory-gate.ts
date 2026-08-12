import { trustRank } from "./memory-ranking.js";
import type { MemoryNoteRecord, MemoryTrust } from "./types.js";

/**
 * The GATE predicate (KG-6), as ONE pure function.
 *
 * A non-paused note is "governed" iff it is human-CONFIRMED, or it is a same-chat note
 * admitted by the #133 crew-visible posture, or (when a `trustFloor` is
 * supplied) its trust is at/above that floor. This guarantees a hostile
 * low-trust UNCONFIRMED write can NEVER appear in a gate view.
 *
 * It lives here, outside MuonGraph, because the gate now has TWO evaluators and
 * they must not be two RULES. The store applies it to the mirror's copies while
 * building candidates (`MuonGraph.passesGate` delegates here); the backend
 * re-applies it at the route to the LEDGER's copies, because `confirmed` is
 * derived from the Confirmation ledger and the mirror is a best-effort
 * projection that a single dropped write leaves saying `confirmed: true` about a
 * note a human un-blessed. The second pass is a NARROWER over a set the first
 * already admitted, so it can only ever remove a note.
 *
 * (The cypher in `governedConditions` is a third expression of the same rule and
 * cannot call this — it runs inside the query so LIMIT applies to the gated set.
 * It stays pinned to this function by test, as its comments say.)
 */
export function memoryPassesGate(
  note: Pick<MemoryNoteRecord, "confirmed" | "trust"> & {
    chatId?: string | null;
    status?: MemoryNoteRecord["status"];
  },
  opts?: {
    governedOnly?: boolean;
    trustFloor?: MemoryTrust;
    crewChatId?: string;
  }
): boolean {
  return memoryGateTier(note, opts) !== null;
}

/**
 * WHICH tier admitted a note, or `null` when the gate refused it.
 *
 * D14 needs to report "the gate returned 32 notes and all 32 were crew-vouched,
 * none human-confirmed" — the distinction §2.1 turns on. Deriving that beside
 * `memoryPassesGate` instead of inside it would be a FOURTH statement of the
 * gate rule (the cypher, `passesGate`, the route's ledger pass, and a tally),
 * and a tally that disagreed with the predicate is precisely the drift the
 * comments above keep warning about. So the tier IS the rule: this function
 * decides, `memoryPassesGate` is its boolean projection, and the branch order
 * below is the SAME order the boolean used to have.
 *
 * `"ungated"` is not an admission — it means the caller never asked for the gate
 * (`governedOnly` absent), so no tier was consulted. Coverage counts it nowhere.
 */
export type MemoryGateTier =
  | "ungated"
  | "human_confirmed"
  | "crew_vouched"
  | "trust_floor";

export function memoryGateTier(
  note: Pick<MemoryNoteRecord, "confirmed" | "trust"> & {
    chatId?: string | null;
    status?: MemoryNoteRecord["status"];
  },
  opts?: {
    governedOnly?: boolean;
    trustFloor?: MemoryTrust;
    crewChatId?: string;
  }
): MemoryGateTier | null {
  // TODO 4.10: pausing is an operator-owned "not now", not a verdict. It must
  // still dominate every admission tier (including an otherwise ungated read),
  // while an omitted status keeps legacy pure-function callers active.
  // Rejection is intentionally not decided here: current versus historical
  // visibility belongs to the ledger/graph validity predicates.
  if (note.status === "paused") {
    return null;
  }
  if (!opts?.governedOnly) {
    return "ungated";
  }
  if (note.confirmed) {
    return "human_confirmed";
  }
  // #133 CREW-VISIBLE admission (DISTINCT from human confirmation; `confirmed`
  // is untouched). A same-chat UNCONFIRMED note is admitted into THIS chat's gate
  // view. LOCKSTEP with governedConditions' cypher `(n.chatId = $crewChatId AND
  // n.chatId <> '')`: a non-empty crewChatId that equals the note's chat (a legacy
  // NULL-chat note normalizes to '' → never equals a real chat id → still gated).
  // Trust is NOT consulted here, so the note keeps its 'medium' trust and a
  // `trustFloor:'high'` gate still excludes it (the kill switch).
  // AUTHORSHIP is not consulted either. Crew visibility admits every agent
  // author the chat has — an explicit `memory_add` proposal, a deterministic
  // `muon-capture`, and the LLM extractor's `muon-extractor` prose alike —
  // because ONE operator posture decides whether unconfirmed agent memory
  // reaches the crew, and a per-author exception would make that posture
  // unreadable. `confirmed` is untouched by all of it: crew-visible is not
  // confirmed, and only a human sets confirmed.
  if (opts.crewChatId && (note.chatId ?? "") === opts.crewChatId) {
    return "crew_vouched";
  }
  return opts.trustFloor != null &&
    trustRank(note.trust) >= trustRank(opts.trustFloor)
    ? "trust_floor"
    : null;
}
