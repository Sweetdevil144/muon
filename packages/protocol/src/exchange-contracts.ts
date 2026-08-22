import { z } from "zod";
/**
 * ADR-0070 — the exchange contracts, NAMED in one place.
 *
 * Everything that crosses a lane or machine boundary belongs to a versioned
 * family, and a consumer meeting a version from the future refuses WHOLE —
 * never best-effort parses a shape it does not know (ADR-0033's honesty at
 * the wire). The changelog lives beside the schemas in
 * `packages/protocol/PACKETS.md`; a version bump lands with its entry in the
 * same commit.
 *
 * TWO contracts, deliberately not one:
 *  • the PACKET FAMILY — dispatch pack, wrap/handoff packet, continuation
 *    composer output — travels together mid-mission (a continuation reads a
 *    wrap that quotes a dispatch pack), so it carries ONE family version.
 *    The major tracks `HANDOFF_PACKET_VERSION` (the family's wire anchor).
 *  • the MEMORY PACK — the at-rest machine-boundary format (ADR-0064) —
 *    versions on its own lifecycle; forcing one schema over both would
 *    couple two lifecycles that change at different speeds (0064's rejected
 *    alternative, kept rejected).
 */
export const MUON_PACKET_FAMILY_VERSION = "2.0.0";

/** The memory pack's manifest/record version (ADR-0064). Moved here from
 *  the backend so the ONE spelling is importable by every surface that
 *  discloses it; the exporter and importer both bind to this constant. */
export const MEMORY_PACK_VERSION = 1 as const;

/**
 * ADR-0064 A1 residual (closed 2026-08-22): the OPTIONAL provenance block a
 * pack record may carry — THE one spelling (review finding: it was defined
 * separately in the exporter type, the hostile-import validator, and the
 * client file schema, three shapes free to drift around one hash). The
 * exporter binds its type to this schema; the importer and the client parse
 * with it directly. Additive within pack v1: absent on unstamped notes, so
 * pre-enrichment record hashes are unchanged. Data, never authority.
 */
export const memoryPackRecordProvenanceSchema = z.object({
  /** ADR-0058 LATEST grounding stamp — verdict, when, and which check
   *  KINDS ran (details stay home: they may carry machine-local paths). */
  grounding: z
    .object({
      verdict: z.string().min(1).max(64),
      at: z
        .string()
        .refine((value) => !Number.isNaN(Date.parse(value)), {
          message: "must be a parseable ISO-8601 date-time",
        }),
      checkKinds: z.array(z.string().min(1).max(64)).max(16),
    })
    .optional(),
  /** ADR-0060 offer-derived lineage summary — COUNTS and time bounds only;
   *  chat/job ids are machine-local and never leave the box. */
  offers: z
    .object({
      distinctChats: z.number().int().min(0).max(1_000_000_000),
      distinctJobs: z.number().int().min(0).max(1_000_000_000),
      firstOfferedAt: z
        .string()
        .refine((value) => !Number.isNaN(Date.parse(value)), {
          message: "must be a parseable ISO-8601 date-time",
        }),
      lastOfferedAt: z
        .string()
        .refine((value) => !Number.isNaN(Date.parse(value)), {
          message: "must be a parseable ISO-8601 date-time",
        }),
    })
    .optional(),
  })
  // An EMPTY block is refused: `provenance: {}` would hash differently from
  // an absent field while disclosing nothing — the absent-or-populated
  // contract, enforced at the one schema every boundary parses with.
  .refine(
    (value) => value.grounding !== undefined || value.offers !== undefined,
    { message: "provenance must carry a grounding stamp or an offer summary" }
  );
export type MemoryPackRecordProvenance = z.infer<
  typeof memoryPackRecordProvenanceSchema
>;

export type MuonExchangeContracts = {
  packetFamily: string;
  memoryPack: number;
};

/** What an install SPEAKS — disclosed by `whoami` and `muon mcp probe`, so
 *  a consumer negotiates by reading, not by trying. */
export const MUON_EXCHANGE_CONTRACTS: MuonExchangeContracts = {
  packetFamily: MUON_PACKET_FAMILY_VERSION,
  memoryPack: MEMORY_PACK_VERSION,
};
