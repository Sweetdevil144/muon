import { z } from "zod";

/**
 * ADR-0060 — the offer ledger's wire vocabulary.
 *
 * An OFFER is a server-observed fact: "MUON put this note's content in front
 * of job J" — recorded inside the serve paths, never asserted by a caller.
 * A decision's `derived_from` set is DERIVED from offer rows at query time
 * (offers in the decision's partition with firstAt <= recordedAt); nothing
 * here is authority, and no read is granted or widened by any of it.
 */

/** The POSITIVE list of serve paths that record offers (ADR-0060 D2). The
 *  pack arms are the /recall route's standing/institutional branches, derived
 *  server-side from the arm flags — which is how dispatch-pack assembly is
 *  covered (the runner fetches those arms with the job's capability-bound
 *  client). A pack-arm offer means "served to the assembler for this job";
 *  the runner's bounded selection may narrow what reaches the prompt. */
export const MEMORY_OFFER_SURFACES = [
  "search",
  "recall",
  "standing-pack",
  "institutional-pack",
  "preedit",
  "neighbors",
  "explain",
  "clone",
  "add",
  // ADR-0069's pre-answer serves confirmed note EXCERPTS to the asker's
  // session — a serve like any other, and (0088's research finding) the
  // one that shipped unrecorded: its disclosed notes are citable via
  // `answered_from_memory`, so the missing rows made every such citation
  // audit as an offered:false relay.
  "question-preanswer",
  // ADR-0082: the crew-context block beside a blocking question serves
  // UNCONFIRMED same-mission note excerpts — a serve like any other.
  "question-crew-context",
] as const;

export type MemoryOfferSurface = (typeof MEMORY_OFFER_SURFACES)[number];

export const memoryOfferSurfaceSchema = z.enum(MEMORY_OFFER_SURFACES);

const offerCoordinateSchema = z.string().min(1).max(512);
const offerTimestampSchema = z.string().min(1).max(64);

/** One offer row as surfaces render it: coordinates only, never note text —
 *  a history entry surfaces ids; reading a listed note's content still passes
 *  every fence (ADR-0060 D5). */
export const memoryOfferRowSchema = z.object({
  noteId: offerCoordinateSchema,
  jobId: offerCoordinateSchema,
  /** The FIRST offer's surface: set semantics mean a later re-serve through
   *  another surface changes nothing — `firstAt`/`surface` together read
   *  "first offered at T via S", never "only ever via S". */
  surface: memoryOfferSurfaceSchema,
  firstAt: offerTimestampSchema,
});

export type MemoryOfferRow = z.infer<typeof memoryOfferRowSchema>;

/**
 * The decision-history section of a note dossier (ADR-0060 D4): who wrote
 * the note, what the brain had offered its partition by then, and where the
 * note itself has been offered since. Every list is bounded AND carries its
 * total, so truncation is disclosed, never silent.
 */
export const memoryDecisionHistorySchema = z.object({
  written: z.object({
    by: z.string().max(200).nullable(),
    at: offerTimestampSchema,
    partition: offerCoordinateSchema.nullable(),
    /** The job that wrote it, when the ledger observed the write as a serve
     *  (the note's own add/clone offer row). Null for operator writes and
     *  pre-ledger notes. */
    job: offerCoordinateSchema.nullable(),
  }),
  derivedFrom: z.discriminatedUnion("status", [
    /** The note predates migration 0062 — "no offer ledger at write time",
     *  which is NOT the same fact as "read nothing" (ADR-0060 non-goals). */
    z.object({ status: z.literal("predates-offer-ledger") }),
    /** The note has no session partition (an operator write): no governed
     *  session context is attributable. */
    z.object({ status: z.literal("unpartitioned") }),
    z.object({
      status: z.literal("ok"),
      total: z.number().int().nonnegative(),
      truncated: z.boolean(),
      offers: z.array(memoryOfferRowSchema).max(50),
    }),
  ]),
  offeredTo: z.object({
    total: z.number().int().nonnegative(),
    jobs: z.number().int().nonnegative(),
    partitions: z.number().int().nonnegative(),
    truncated: z.boolean(),
    recent: z
      .array(
        z.object({
          jobId: offerCoordinateSchema,
          partition: offerCoordinateSchema,
          surface: memoryOfferSurfaceSchema,
          firstAt: offerTimestampSchema,
        })
      )
      .max(20),
  }),
});

export type MemoryDecisionHistory = z.infer<typeof memoryDecisionHistorySchema>;
