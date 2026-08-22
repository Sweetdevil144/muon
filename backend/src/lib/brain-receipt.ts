import { HANDOFF_DEGRADATION, type HandoffPacket } from "@muon/protocol";

/**
 * ADR-0062 — the receipt audit, applied SERVER-side at the terminal
 * transition (the one place every packet passes, whatever runner version
 * built it). Two rules, both append-to-degradation and nothing else:
 *
 *  • a packet without a receipt is a DEGRADED wrap (`no_brain_receipt`) —
 *    completion is never refused for it; the wrap stands dirty on the
 *    review cursor exactly like every other degradation (D21 semantics);
 *  • a receipt that disagrees with what the server observed for this job
 *    (offer-ledger add/clone rows + the packet's own memory proposals) is
 *    a RECEIPT MISMATCH — the agent's answer stays stored verbatim, and
 *    the observation rides the reason code. Both kept, neither silently
 *    normalized (D3).
 */
export function brainReceiptFindings(
  packet: Pick<HandoffPacket, "brainReceipt" | "memoryProposals">,
  /** This job's offer-ledger add/clone count — or UNDEFINED when the ledger
   *  could not be read. Unknown must never impersonate zero: an unreadable
   *  observation SKIPS the accusation it cannot support, and only the
   *  packet's own proposals (evidence in hand) may still decide. */
  observedAddOffers: number | undefined
): string[] {
  if (!packet.brainReceipt) {
    return [HANDOFF_DEGRADATION.noBrainReceipt];
  }
  const proposals = packet.memoryProposals.length;
  if (packet.brainReceipt === "context_updated") {
    if (proposals > 0 || observedAddOffers === undefined) {
      return []; // agrees, or cannot be accused on an unreadable ledger
    }
    return observedAddOffers === 0
      ? [
          `${HANDOFF_DEGRADATION.brainReceiptMismatch}:claimed_update_no_observed_writes`,
        ]
      : [];
  }
  // no_update_required: the packet's own proposals decide without the
  // ledger; otherwise the ledger decides only when it was readable.
  if (proposals > 0 || (observedAddOffers ?? 0) > 0) {
    return [
      `${HANDOFF_DEGRADATION.brainReceiptMismatch}:observed_writes_exist`,
    ];
  }
  return [];
}

const MAX_DEGRADATION_REASONS = 20;

/** Return the packet with the audit's findings appended to its OWN
 *  degradation channel (bounded per the schema), or the packet untouched
 *  when the receipt and the observation agree. */
export function applyBrainReceiptAudit(
  packet: HandoffPacket,
  observedAddOffers: number | undefined
): HandoffPacket {
  const findings = brainReceiptFindings(packet, observedAddOffers);
  if (findings.length === 0) {
    return packet;
  }
  // The audit's findings must SURVIVE the schema's reason cap (review
  // finding: append-then-slice dropped the receipt stamp for exactly the
  // most degraded packets). When the cap forces an eviction, the tail of
  // the builder's reasons yields — deterministically — because the server's
  // own observation is the one entry this route exists to guarantee.
  const kept = packet.degraded.reasons.slice(
    0,
    Math.max(0, MAX_DEGRADATION_REASONS - findings.length)
  );
  return {
    ...packet,
    degraded: {
      flag: true,
      reasons: [...kept, ...findings].slice(0, MAX_DEGRADATION_REASONS),
    },
  };
}
