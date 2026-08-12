import type { Prisma } from "@prisma/client";
import type { PreEditCoverage } from "@muon/protocol";
import { AGENT_PRINCIPAL, OPERATOR_PRINCIPAL } from "./auth.js";
import { prisma } from "./db.js";
import {
  buildEventAuditStamp,
  eventAuditData,
} from "./event-audit.js";

/**
 * The `Event.kind` this producer writes. EXPORTED so the two consumers that must
 * name it — the bounded activity replay and the events route's `kind` filter —
 * import the literal rather than restating it. A restated string that drifts is
 * how a filter silently stops filtering, and this one is load-bearing twice over.
 */
export const GATE_READ_EVENT_KIND = "memory.gate_read";

/**
 * D14's durable producer, in its OWN module.
 *
 * It is not in `preedit-coverage.ts` because that module's header states it is
 * pure — "no graph, no ledger, no I/O" — and it is the second caller's whole
 * reason for existing. Adding a database write there would have made a comment
 * false, which is the exact class of defect this work keeps closing.
 */
/**
 * D14's MISSING PRODUCER — persist the fact that a gate read happened, and what
 * it saw.
 *
 * D14 shipped the coverage OUTPUT: an operator looking at one empty gate now
 * learns whether nothing is known about this code or nothing was even searched.
 * What it did not ship is a record, so the DISTRIBUTION over time was
 * unobservable: `docs/design/memory-index-validation.md` §1.2 row 25 asks for
 * "gate reads in the last N days by empty-reason enum" and could never become a
 * number. §6 sequencing puts D14 first precisely because "without it nothing else
 * is measurable in production, and the §0 number can recur silently" — and half of
 * that was still open. One read is an anecdote; the distribution is the signal.
 *
 * AN `Event` ROW, not a new table. `Event` is append-only, deliberately carries no
 * relations so it survives task deletion, and has no update/delete route — which is
 * exactly the shape an audit counter wants. `memory.graph_mirror_failed` already
 * uses it for the same reason, and reusing that convention beats inventing a
 * second one. The sentinel `laneId`/`taskId` follow that producer verbatim.
 *
 * COUNTS AND THE ENUM ONLY. No note text, no note ids, no anchor VALUES — those
 * are workspace-relative coordinates and this table has no workspace fence. The
 * whole payload is numbers plus one closed-enum member, so a row is safe to read
 * from any surface and safe to paste into an issue.
 *
 * EVERY read is recorded, not just the empty ones. "`no_anchors` dominating" is a
 * RATE, and a producer that only fired on empties would make its own denominator
 * unobservable — the alarm would be unevaluable in exactly the situation it exists
 * for.
 *
 * BEST-EFFORT, ALWAYS. A telemetry write must never fail the hero gate, so this
 * returns void, swallows everything, and is not awaited by the route. If it stops
 * working, row 25 goes quiet — which the harness reports as NOT PRODUCED rather
 * than as zero.
 *
 * KNOWN COST, stated rather than discovered later: one row per pre-edit gate read,
 * and `Event` has no retention sweep today. On a local-first single-operator brain
 * that is a few hundred rows a busy day; it is not free forever, and a retention
 * policy is the honest follow-up if the table ever matters for size.
 *
 * THAT COST WAS UNDERSTATED, and the two ways it AMPLIFIED are closed rather than
 * only noted:
 *   • `projectActivityEdges` used to `findMany` the WHOLE `Event` table at every
 *     boot and skip these rows in the loop, so the boot path scaled with agent edit
 *     volume. It is now bounded and excludes {@link GATE_READ_EVENT_KIND} in SQL.
 *   • `GET /api/events?limit=50` is the only surface any consumer reads
 *     `memory.graph_mirror_failed` from, and a gate read per pre-edit pushes a
 *     once-per-30 s mirror alarm out of that window. That route now takes a `kind`
 *     filter, so the alarm is ADDRESSABLE instead of racing this producer for a
 *     slot. See `backend/src/routes/events.ts`.
 * Neither changes what is recorded here: every read still leaves a row, because
 * "`no_anchors` dominating" is a RATE and a producer that fired only on empties
 * would make its own denominator unobservable.
 */
export function recordGateRead(
  coverage: PreEditCoverage,
  context: {
    tier: string;
    /**
     * TODO 4.3 — the CHARACTER weight of what this read actually put into the
     * caller's context (Σ text length of the surfaced notes). Every cap in the
     * pipeline is a COUNT (`k` notes, `MAX_ANCHOR_MODULES`) while the longest
     * live note is 3,172 chars and counts as one — so without this number,
     * "the gate surfaced 5 notes" cannot distinguish 200 chars of context from
     * 15,000, and nothing can tell whether the standing arm (4.1) helped or
     * just cost. A count and a size are two different measurements; this row
     * now carries both. Optional so the producer's older callers stay valid;
     * absent means NOT MEASURED, never 0.
     */
    contextChars?: number;
    /** ADR-0027: size/count of the separate crew-inform channel. */
    informFindings?: number;
    informContextChars?: number;
  }
): void {
  void Promise.resolve()
    .then(() => {
      // TODO 5.15: stamp the reader. Operator-tier gate reads are human;
      // everything else is the MUON agent principal (never a forged human).
      const actor =
        context.tier === "operator" ? OPERATOR_PRINCIPAL : AGENT_PRINCIPAL;
      const stamp = buildEventAuditStamp({ actor });
      return prisma.event.create({
        data: {
          laneId: "muon",
          taskId: "memory",
          kind: GATE_READ_EVENT_KIND,
          message: `pre-edit gate read: ${coverage.notes.surfaced} surfaced${
            coverage.emptyReason ? ` (${coverage.emptyReason})` : ""
          }`,
          metadata: {
            // Absent when the read was NOT empty. Absence is the signal that this
            // read succeeded, so it must not be coerced to a string here.
            ...(coverage.emptyReason
              ? { emptyReason: coverage.emptyReason }
              : {}),
            tier: context.tier,
            anchorsRequested:
              coverage.anchors.modules.requested +
              coverage.anchors.symbols.requested,
            anchorsResolved:
              coverage.anchors.modules.resolved +
              coverage.anchors.symbols.resolved,
            anchorsUnreadable: coverage.anchors.unreadable,
            considered: coverage.notes.considered,
            admitted: coverage.notes.admitted,
            surfaced: coverage.notes.surfaced,
            crewChat: coverage.crewChat,
            // TODO 4.3: absent = not measured (an older caller), never 0.
            ...(context.contextChars !== undefined
              ? { contextChars: context.contextChars }
              : {}),
            ...(context.informFindings !== undefined
              ? { informFindings: context.informFindings }
              : {}),
            ...(context.informContextChars !== undefined
              ? { informContextChars: context.informContextChars }
              : {}),
          } as Prisma.InputJsonValue,
          ...eventAuditData(stamp),
        },
      });
    })
    .catch(() => undefined);
}
