import { z } from "zod";

/** TODO 4.8 / D7 — how a note entered the ledger before any derivation ships. */
export const NOTE_DERIVATIONS = ["authored", "inferred"] as const;

export type NoteDerivation = (typeof NOTE_DERIVATIONS)[number];

export const noteDerivationSchema = z.enum(NOTE_DERIVATIONS);

/** Accept wire null/undefined; reject any other string. NULL on the row = legacy authored. */
export const noteDerivationNullableSchema = noteDerivationSchema.nullish();

/** Operator review stamp, separate from confirm/reject lifecycle. */
export const NOTE_REVIEW_STATUSES = ["pending", "reviewed", "deferred"] as const;

export type NoteReviewStatus = (typeof NOTE_REVIEW_STATUSES)[number];

export const noteReviewStatusSchema = z.enum(NOTE_REVIEW_STATUSES);

export const noteReviewStatusNullableSchema = noteReviewStatusSchema.nullish();

/** Operator library ordering for the bounded review queue (TODO 4.8). */
export const MEMORY_LIBRARY_ORDER_BY = ["updatedAt", "supportCount"] as const;

export type MemoryLibraryOrderBy = (typeof MEMORY_LIBRARY_ORDER_BY)[number];

export const memoryLibraryOrderBySchema = z.enum(MEMORY_LIBRARY_ORDER_BY);

export function isNoteDerivation(value: unknown): value is NoteDerivation {
  return noteDerivationSchema.safeParse(value).success;
}

export function isNoteReviewStatus(value: unknown): value is NoteReviewStatus {
  return noteReviewStatusSchema.safeParse(value).success;
}

/** Normalize a nullable ledger column to the wire enum; NULL/unknown → `authored`. */
export function normalizeNoteDerivation(
  value: string | null | undefined
): NoteDerivation {
  return isNoteDerivation(value) ? value : "authored";
}
