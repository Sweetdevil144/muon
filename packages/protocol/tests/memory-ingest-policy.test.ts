import { describe, expect, it } from "vitest";
import {
  evaluateMemoryIngestPolicy,
  EMPTY_MEMORY_INGEST_POLICY,
  parseMemoryIngestPolicy,
} from "../src/memory-ingest-policy.js";

describe("parseMemoryIngestPolicy", () => {
  it("defaults missing arrays to empty", () => {
    expect(parseMemoryIngestPolicy({}).ok).toBe(true);
  });

  it("rejects oversized pattern lists", () => {
    const deny = Array.from({ length: 33 }, (_, index) => `p${index}`);
    expect(parseMemoryIngestPolicy({ deny }).ok).toBe(false);
  });
});

describe("evaluateMemoryIngestPolicy", () => {
  it("allows everything when both lists are empty", () => {
    expect(
      evaluateMemoryIngestPolicy("any prose", EMPTY_MEMORY_INGEST_POLICY).allowed
    ).toBe(true);
  });

  it("denies on a deny hit", () => {
    const decision = evaluateMemoryIngestPolicy("do not store SECRET", {
      deny: ["secret"],
      allow: [],
    });
    expect(decision).toEqual({
      allowed: false,
      reason: "note text matched an ingest deny pattern",
    });
  });

  it("requires an allow hit when allow is non-empty", () => {
    const decision = evaluateMemoryIngestPolicy("unrelated prose", {
      deny: [],
      allow: ["deploy"],
    });
    expect(decision.allowed).toBe(false);
  });
});
