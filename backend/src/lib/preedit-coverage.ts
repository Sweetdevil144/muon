import { type MemoryNoteRecord, type MemoryTrust, memoryGateTier } from "@muon/graph";
import {
  type PreEditCoverage,
  preEditCoverageEmptyReason,
} from "@muon/protocol";

/**
 * D14's ADMISSION TALLY, deliberately its own module.
 *
 * It lives here and not in `preedit.ts` because both callers on the live path
 * need it and one of them is the route: `POST /api/memory/preedit` re-applies the
 * gate to the LEDGER's copies after the library already answered, and a test that
 * mocks the gate library (several do) must still get real arithmetic here rather
 * than an undefined function. It is pure — no graph, no ledger, no I/O — and it
 * makes no admission decision; it only counts one that already happened.
 */

/** The gate posture a coverage tally must be read against — the SAME two knobs
 *  `recallForGate` was given, never a re-derivation of them. */
export type PreEditGatePosture = {
  trustFloor?: MemoryTrust;
  crewChatId?: string;
};

/**
 * Re-tally a coverage block's ADMISSION half over an actual note set.
 *
 * Called twice on the live path, and it must be the same function both times:
 * once in `preEditContext` (over what the mirror's gate admitted) and once at the
 * route AFTER the ledger re-gate, which can only ever REMOVE notes. Skipping the
 * second call would leave the response claiming the gate admitted notes the route
 * then dropped — coverage lying about the very surface it exists to make honest.
 *
 * `anchors`, `notes.considered` and `crewChat` describe the LOOKUP and are carried
 * through untouched; only `admitted` / `surfaced` / `admittedBy` / `emptyReason`
 * are recomputed. The tier comes from `memoryGateTier`, the gate's OWN rule, so
 * the tally cannot disagree with the predicate that admitted the note (see
 * packages/graph/src/memory-gate.ts).
 */
export function tallyGateCoverage(
  coverage: PreEditCoverage,
  memories: Pick<MemoryNoteRecord, "confirmed" | "trust" | "chatId">[],
  posture: PreEditGatePosture
): PreEditCoverage {
  const admittedBy = {
    humanConfirmed: 0,
    crewVouched: 0,
    trustFloor: 0,
  };
  for (const note of memories) {
    const tier = memoryGateTier(note, {
      governedOnly: true,
      trustFloor: posture.trustFloor,
      crewChatId: posture.crewChatId,
    });
    if (tier === "human_confirmed") {
      admittedBy.humanConfirmed += 1;
    } else if (tier === "crew_vouched") {
      admittedBy.crewVouched += 1;
    } else if (tier === "trust_floor") {
      admittedBy.trustFloor += 1;
    }
    // A `null`/`"ungated"` tier is counted NOWHERE on purpose: it would mean the
    // gate's two evaluators disagree about a note one of them admitted, and a
    // bucket that silently absorbed it would hide exactly that. The
    // sum === admitted invariant is pinned by test instead.
  }
  const next: PreEditCoverage = {
    ...coverage,
    // `considered` is the pre-gate count and is never recomputed here; the
    // admitted set can only shrink through this function, never grow past it.
    notes: {
      considered: coverage.notes.considered,
      admitted: memories.length,
      surfaced: memories.length,
    },
    admittedBy,
  };
  const reason = preEditCoverageEmptyReason(next);
  if (reason) {
    next.emptyReason = reason;
  } else {
    delete next.emptyReason;
  }
  return next;
}

