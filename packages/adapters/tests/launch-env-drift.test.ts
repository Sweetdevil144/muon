import { describe, expect, it } from "vitest";
import { VENDOR_REGISTRY } from "@muon/protocol";
import { codexGuardEnv } from "../src/codex-guard.js";
import { opencodeGuardEnv } from "../src/opencode-adapter.js";

// ADR-0022 §9.3.1 drift-lock. The registry's `execution.guards.launchEnv` and
// the adapter's actual guard-env builder are TWO statements of the same
// governance boundary; this test is what makes divergence a failure instead
// of a silent re-widening. A new env lever added to a builder without a
// registry declaration (or vice versa) fails here by NAME.

const declared = (id: string): string[] =>
  [...(VENDOR_REGISTRY[id as keyof typeof VENDOR_REGISTRY].execution.guards
    .launchEnv ?? [])]
    .map((entry) => entry.name)
    .sort();

describe("launchEnv registry ↔ adapter drift-lock", () => {
  it("opencode: the five env levers match the builder exactly", () => {
    const actual = Object.keys(opencodeGuardEnv("/tmp/drift-lock")).sort();
    expect(declared("opencode")).toEqual(actual);
  });

  it("codex: the guard home is the one declared lever", () => {
    const actual = Object.keys(codexGuardEnv("/tmp/drift-lock")).sort();
    expect(declared("codex")).toEqual(actual);
  });

  it("argv-only vendors declare an EMPTY list (a statement, not an omission)", () => {
    for (const id of ["claude-code", "cursor", "fake"]) {
      expect(declared(id), id).toEqual([]);
    }
  });

  it("every registered vendor states launchEnv (total record, no undefined)", () => {
    for (const [id, entry] of Object.entries(VENDOR_REGISTRY)) {
      expect(Array.isArray(entry.execution.guards.launchEnv), id).toBe(true);
      for (const lever of entry.execution.guards.launchEnv) {
        expect(lever.name.length, id).toBeGreaterThan(0);
        expect(lever.purpose.length, `${id}:${lever.name}`).toBeGreaterThan(20);
      }
    }
  });
});
