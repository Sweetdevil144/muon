import { describe, expect, it } from "vitest";
import {
  MEMORY_LIBRARY_ORDER_BY,
  NOTE_DERIVATIONS,
  NOTE_REVIEW_STATUSES,
  memoryLibraryOrderBySchema,
  normalizeNoteDerivation,
  noteDerivationNullableSchema,
  noteDerivationSchema,
  noteReviewStatusNullableSchema,
  noteReviewStatusSchema,
} from "../src/note-derivation.js";

describe("note-derivation", () => {
  it("accepts the two provenance tiers", () => {
    for (const derivation of NOTE_DERIVATIONS) {
      expect(noteDerivationSchema.parse(derivation)).toBe(derivation);
    }
  });

  it("accepts the three review stamps", () => {
    for (const status of NOTE_REVIEW_STATUSES) {
      expect(noteReviewStatusSchema.parse(status)).toBe(status);
    }
  });

  it("nullable schemas accept null and undefined", () => {
    expect(noteDerivationNullableSchema.parse(null)).toBeNull();
    expect(noteDerivationNullableSchema.parse(undefined)).toBeUndefined();
    expect(noteReviewStatusNullableSchema.parse(null)).toBeNull();
  });

  it("rejects unknown derivation strings", () => {
    expect(noteDerivationSchema.safeParse("proposed").success).toBe(false);
    expect(noteDerivationNullableSchema.safeParse("derived").success).toBe(false);
  });

  it("normalizes legacy NULL to authored", () => {
    expect(normalizeNoteDerivation(null)).toBe("authored");
    expect(normalizeNoteDerivation(undefined)).toBe("authored");
    expect(normalizeNoteDerivation("inferred")).toBe("inferred");
  });

  it("accepts library order-by values", () => {
    for (const orderBy of MEMORY_LIBRARY_ORDER_BY) {
      expect(memoryLibraryOrderBySchema.parse(orderBy)).toBe(orderBy);
    }
  });
});
