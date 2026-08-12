import { handoffPacketSchema, type HandoffPacket } from "@muon/protocol";

/**
 * The packet's CLOSED check vocabulary, re-exported so a surface cannot widen
 * it to `string`. A renderer keys styling off this value; widening it means a
 * new outcome renders with no visual policy and nobody is forced to decide.
 */
export type HandoffCheckOutcome = HandoffPacket["checks"][number]["outcome"];

/**
 * READ-SIDE HONESTY for a handoff packet, stated ONCE.
 *
 * `packetJson` is a JSON column holding AGENT-PRODUCED, UNTRUSTED data. Every
 * surface that renders a handoff owes the same three admissions, and until now
 * only `handoff_read` (the MCP tool) made them — so the classification lived
 * inline there and the desktop had no way to show a packet without restating
 * the rule. A second statement is how two surfaces come to disagree about
 * whether a packet is trustworthy, which is exactly the disagreement a handoff
 * cannot afford.
 *
 * The contract, unchanged from the MCP handler this was extracted from:
 *  - `prose_only`          — no typed packet at all (legacy row); the prose is
 *                            all there is, and the reader must not infer that
 *                            checks passed from its absence.
 *  - `typed`               — a valid packet.
 *  - `typed_degraded`      — a valid packet that DECLARES its own degradation
 *                            (no diff evidence, no checks run…). Still typed,
 *                            never silently promoted to trustworthy.
 *  - `packet_parse_failed` — stored JSON that does not satisfy the schema. A
 *                            failure to parse is REPORTED, never thrown and
 *                            never quietly treated as "no packet": the two
 *                            mean different things to a human deciding whether
 *                            to trust the work.
 */
export type HandoffPacketContract =
  | "prose_only"
  | "typed"
  | "typed_degraded"
  | "packet_parse_failed";

export type ClassifiedHandoffPacket = {
  readonly contract: HandoffPacketContract;
  /** The validated packet, or null for every non-`typed*` contract. */
  readonly packet: HandoffPacket | null;
};

/** Classify one stored `packetJson`. Never throws. */
export function classifyHandoffPacket(
  packetJson: unknown
): ClassifiedHandoffPacket {
  if (packetJson === null || packetJson === undefined) {
    return { contract: "prose_only", packet: null };
  }
  const parsed = handoffPacketSchema.safeParse(packetJson);
  if (!parsed.success) {
    return { contract: "packet_parse_failed", packet: null };
  }
  return {
    contract: parsed.data.degraded.flag ? "typed_degraded" : "typed",
    packet: parsed.data,
  };
}

/**
 * One line a human can read at a glance, per contract. Deliberately says what
 * the reader should NOT conclude — an absent packet is the case most often
 * misread as "nothing went wrong".
 */
export function describeHandoffContract(
  contract: HandoffPacketContract
): string {
  switch (contract) {
    case "typed":
      return "Typed packet — evidence attached.";
    case "typed_degraded":
      return "Typed packet, DEGRADED — it declares its own missing evidence.";
    case "packet_parse_failed":
      return "Stored packet failed validation — treat its claims as unverified.";
    case "prose_only":
      return "Prose only — no typed evidence; absence is not a pass.";
  }
}
