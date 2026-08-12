import { z } from "zod";

/**
 * D14 — COVERAGE, a first-class output of a gate read.
 *
 * `preEditContext` used to answer an empty gate with `memories: []` and nothing
 * else. That made two completely different facts indistinguishable at every
 * surface: "nothing is anchored here" and "things are anchored here, but this
 * caller is not allowed to see any of them." On the founder's own install the
 * second was true for weeks and read as the first.
 *
 * So a gate read now also reports HOW IT LOOKED: how many anchors it asked
 * about, how many of those resolved to anything at all, how many notes it
 * considered before the gate, how many it admitted, and WHICH TIER admitted
 * them (human-confirmed vs #133 crew-vouched vs a trust floor).
 *
 * THREE HARD RULES, all of them load-bearing:
 *
 *  1. **This block is DIAGNOSTIC, never AUTHORITY.** Nothing may read it to
 *     decide what an agent is allowed to see. D14 option C — widen the gate when
 *     coverage is zero — is REJECTED: a gate that relaxes when it finds nothing
 *     fails open exactly when the index is broken. Human gates fail closed.
 *  2. **Counts only, never enumerations.** A list of withheld note ids would be
 *     an existence oracle on an agent-facing surface, the same channel the gate
 *     already withholds proposal text over. Every field here is a number, a
 *     boolean, or a member of the closed enum below.
 *  3. **The reason is a CLOSED enum, never a formatted message.** A free-form
 *     string on a bounded agent surface is a channel. Surfaces switch on these
 *     members; a new reason cannot appear without widening this union, which is
 *     the point.
 *
 * It is not a `MemoryNote`, it can never enter `recallForGate`, and it carries
 * no note text, no note ids, and no coordinates.
 */

/**
 * Why a gate read surfaced nothing. Ordered from "the gate never looked" to
 * "the gate looked and refused", because the derivation below picks the FIRST
 * applicable member and the order is the precedence.
 */
export const PRE_EDIT_COVERAGE_EMPTY_REASONS = [
  /** The radius resolved to no anchors at all, so no candidate query ran. */
  "no_anchors",
  /** Anchors were queried; nothing in scope carries any of them (the §0 hole:
   *  an empty COORDINATE layer, not a retrieval-quality problem). */
  "no_notes_on_anchors",
  /** Candidates existed and the gate admitted none, with the #133 crew tier NOT
   *  engaged for this read — so only human confirmation could ever have admitted
   *  them. This is the operator/human pre-edit's answer: "0 because you are not
   *  in a crew chat", which is NOT the same fact as "nothing is anchored". */
  "withheld_no_crew_chat",
  /** Candidates existed, the crew tier WAS engaged, and the gate still admitted
   *  none (nothing confirmed, nothing same-chat, nothing over the trust floor). */
  "withheld_by_gate",
  /** The gate admitted notes, but THIS surface then withheld all of them. The
   *  agent-facing projection is confirmed-only and allowlists coordinates, so a
   *  read whose whole admitted set was crew-vouched reaches an agent as empty.
   *  Compare `notes.admitted` with `notes.surfaced` to see how many. */
  "withheld_agent_projection",
  /** A pre-gate candidate probe could not be read (see `anchors.unreadable`), so
   *  a zero here is UNKNOWN, not measured. Never report an unreadable index as
   *  "nothing to know". */
  "index_unavailable",
] as const;

export const preEditCoverageEmptyReasonSchema = z.enum(
  PRE_EDIT_COVERAGE_EMPTY_REASONS
);

export type PreEditCoverageEmptyReason = z.infer<
  typeof preEditCoverageEmptyReasonSchema
>;

export const preEditCoverageSchema = z.object({
  anchors: z.object({
    /** Module anchors the gate asked about (post-cap: this is the count it
     *  actually fanned out over, which equals `blastRadius.modules.length`). */
    modules: z.object({
      requested: z.number(),
      /** …of which this many matched at least one note in scope BEFORE the
       *  gate. `requested > 0, resolved = 0` is the empty coordinate layer. */
      resolved: z.number(),
    }),
    /** Exact-target symbol anchors (ADR-0012 Tier 0), same two counts. On the
     *  live brain `resolved` is 0 for every symbol ever asked about. */
    symbols: z.object({
      requested: z.number(),
      resolved: z.number(),
    }),
    /** Anchors whose pre-gate probe threw, so their candidate count is unknown.
     *  Drives `index_unavailable`; it never changes an admission. */
    unreadable: z.number(),
  }),
  notes: z.object({
    /** Distinct notes the gate's own candidate queries surfaced on those anchors
     *  before admission (the ungated recall UNION the admitted set), bounded by
     *  the per-anchor recall limit. Not a corpus total. */
    considered: z.number(),
    /** Distinct notes the GATE admitted. `admitted <= considered` always. */
    admitted: z.number(),
    /** How many of the admitted notes reached THIS consumer. Equals
     *  `memories.length` at every surface; a redacting or truncating hop lowers
     *  it. `surfaced <= admitted` always. */
    surfaced: z.number(),
  }),
  /** Which tier admitted each admitted note. Sums to `notes.admitted`; a note
   *  the tally cannot place would be a lockstep break between the gate's two
   *  evaluators, so the sum is pinned by test. */
  admittedBy: z.object({
    /** A human confirmed it (the strict KG-6 gate). */
    humanConfirmed: z.number(),
    /** #133 crew-vouched: same-chat, unconfirmed, admitted by the operator's
     *  crew-visible posture. Vouched is NOT confirmed. */
    crewVouched: z.number(),
    /** Admitted only because an operator-tier `trustFloor` lowered the gate. */
    trustFloor: z.number(),
  }),
  /** True when the #133 crew tier was engaged for this read (a chat-scoped agent
   *  read with the operator posture ON). False for every operator/human read,
   *  which is exactly why a human sees 0 where an agent in the same chat sees N. */
  crewChat: z.boolean(),
  /** Present iff `notes.surfaced === 0`. Closed enum, switchable, never prose. */
  emptyReason: preEditCoverageEmptyReasonSchema.optional(),
});

export type PreEditCoverage = z.infer<typeof preEditCoverageSchema>;

/**
 * Pick the empty reason for a coverage block, or `undefined` when the read was
 * not empty. TOTAL and deterministic: exactly one member applies, chosen by the
 * declaration order of `PRE_EDIT_COVERAGE_EMPTY_REASONS`.
 *
 * Pure. It reads counts only, and no caller may branch on its result to widen
 * anything (rule 1 above).
 */
export function preEditCoverageEmptyReason(
  coverage: PreEditCoverage
): PreEditCoverageEmptyReason | undefined {
  if (coverage.notes.surfaced > 0) {
    return undefined;
  }
  // The gate said yes and this surface said no — report the surface, not the
  // gate, or a redaction would masquerade as an empty brain.
  if (coverage.notes.admitted > 0) {
    return "withheld_agent_projection";
  }
  const anchorCount =
    coverage.anchors.modules.requested + coverage.anchors.symbols.requested;
  if (anchorCount === 0) {
    return "no_anchors";
  }
  if (coverage.notes.considered === 0) {
    // An unreadable probe outranks "nothing is anchored": zero is unknown here.
    return coverage.anchors.unreadable > 0
      ? "index_unavailable"
      : "no_notes_on_anchors";
  }
  return coverage.crewChat ? "withheld_by_gate" : "withheld_no_crew_chat";
}

/**
 * Re-stamp a coverage block for a consumer that WITHHELD or TRUNCATED some of
 * the notes the gate admitted (the agent projection, the MCP row bound). It only
 * lowers `notes.surfaced` and re-derives `emptyReason`; the gate's own answer
 * (`anchors`, `considered`, `admitted`, `admittedBy`, `crewChat`) is carried
 * through untouched, so "the gate admitted 32 crew-vouched notes and this
 * surface showed you none of them" stays a readable fact instead of collapsing
 * into "nothing is anchored here".
 *
 * `surfaced` is clamped into `[0, admitted]`: a consumer cannot claim to have
 * shown more notes than the gate admitted.
 */
export function preEditCoverageForSurface(
  coverage: PreEditCoverage,
  surfaced: number
): PreEditCoverage {
  const clamped = Math.max(0, Math.min(surfaced, coverage.notes.admitted));
  const next: PreEditCoverage = {
    ...coverage,
    anchors: {
      modules: { ...coverage.anchors.modules },
      symbols: { ...coverage.anchors.symbols },
      unreadable: coverage.anchors.unreadable,
    },
    notes: { ...coverage.notes, surfaced: clamped },
    admittedBy: { ...coverage.admittedBy },
  };
  const reason = preEditCoverageEmptyReason(next);
  if (reason) {
    next.emptyReason = reason;
  } else {
    delete next.emptyReason;
  }
  return next;
}
