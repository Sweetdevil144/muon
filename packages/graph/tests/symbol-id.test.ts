import { describe, expect, it } from "vitest";
import {
  deriveModulesFromSymbols,
  gitnexusUidToLocalSymbolId,
  moduleOfSymbol,
  symbolNameOf,
  toSymbolId,
} from "../src/symbol-id.js";

// ADR-0012 symbol identity, the pure `<module>#<name>` helpers. The load-bearing
// invariant is `moduleOfSymbol(toSymbolId(m, n)) === m` for an m already produced
// by `toWorkspaceRelativePosix`, so a symbol id is a strict refinement inside the
// module namespace (never a new namespace). The cross-package byte-identity with
// the codegraph copy is pinned by the merge-gating round-trip E2E test.

describe("symbol identity helpers (ADR-0012)", () => {
  it("round-trips: moduleOfSymbol(toSymbolId(m, n)) === m; symbolNameOf recovers n", () => {
    const cases: [string, string][] = [
      ["backend/src/lib/preedit.ts", "preEditContext"],
      // A METHOD: the '.' lives INSIDE the symbol part (# already split the module).
      ["packages/client/src/api-client.ts", "MuonApiClient.preEditContext"],
      ["src/a.ts", "foo"],
    ];
    for (const [m, n] of cases) {
      const id = toSymbolId(m, n);
      expect(id).toBe(`${m}#${n}`);
      expect(moduleOfSymbol(id)).toBe(m);
      expect(symbolNameOf(id)).toBe(n);
    }
  });

  it("a module-only value (no #) passes through UNCHANGED → clean degrade to module", () => {
    expect(moduleOfSymbol("backend/src/a.ts")).toBe("backend/src/a.ts");
    expect(symbolNameOf("backend/src/a.ts")).toBe("");
  });

  it("F1: DECLINES (null) when the MODULE path contains '#' → degrade to module-level; a private-field NAME still works", () => {
    // '#' is a legal POSIX filename char, so `src/weird#name.ts` is a real file,
    // forming an id would let moduleOfSymbol mis-derive `src/weird`. Decline instead.
    expect(toSymbolId("src/weird#name.ts", "foo")).toBeNull();
    expect(toSymbolId("a#b", "x")).toBeNull();
    // Only the MODULE side is guarded, an ES private-field NAME `#priv` is fine.
    const id = toSymbolId("src/a.ts", "#priv");
    expect(id).toBe("src/a.ts##priv");
    expect(moduleOfSymbol(id!)).toBe("src/a.ts");
    expect(symbolNameOf(id!)).toBe("#priv");
  });

  it("splits on the FIRST # only (module never contains #; the symbol part may)", () => {
    expect(moduleOfSymbol("m#a#b")).toBe("m");
    expect(symbolNameOf("m#a#b")).toBe("a#b");
  });

  it("deriveModulesFromSymbols unions + dedups module prefixes, order-preserving", () => {
    expect(
      deriveModulesFromSymbols([
        "src/a.ts#foo",
        "src/a.ts#bar", // same module → deduped
        "src/b.ts#baz",
      ])
    ).toEqual(["src/a.ts", "src/b.ts"]);
    expect(deriveModulesFromSymbols([])).toEqual([]);
    // A module-only value contributes itself (the degrade case).
    expect(deriveModulesFromSymbols(["src/only.ts"])).toEqual(["src/only.ts"]);
  });
});

// D2 option B (docs/design/memory-index-decisions.md): the GitNexus uid → local
// id mapping the `symbolUid` cache is keyed by (ADR-0012 Decision 1's "drop
// `Kind:` + `#overload` → `path#leafName`").
describe("gitnexusUidToLocalSymbolId (ADR-0012 GitNexus FK mapping)", () => {
  it("drops the Kind prefix and any #overload suffix, keeping path#name", () => {
    expect(
      gitnexusUidToLocalSymbolId(
        "Function:backend/src/lib/preedit.ts:preEditContext#1"
      )
    ).toBe("backend/src/lib/preedit.ts#preEditContext");
  });

  it("qualifies a method with Class.method, the '.' living inside the symbol part", () => {
    expect(
      gitnexusUidToLocalSymbolId(
        "Method:packages/client/src/api-client.ts:MuonApiClient.preEditContext#1"
      )
    ).toBe(
      "packages/client/src/api-client.ts#MuonApiClient.preEditContext"
    );
  });

  it("has no overload suffix to drop when GitNexus omits one", () => {
    expect(
      gitnexusUidToLocalSymbolId("Function:src/auth/guard.ts:authorize")
    ).toBe("src/auth/guard.ts#authorize");
  });

  it("round-trips through moduleOfSymbol/symbolNameOf like any other local id", () => {
    const id = gitnexusUidToLocalSymbolId(
      "Function:src/auth/session.ts:readSession"
    )!;
    expect(moduleOfSymbol(id)).toBe("src/auth/session.ts");
    expect(symbolNameOf(id)).toBe("readSession");
  });

  it("degrades to undefined on malformed input rather than a wrong id", () => {
    expect(gitnexusUidToLocalSymbolId("")).toBeUndefined();
    expect(gitnexusUidToLocalSymbolId("no-colons-at-all")).toBeUndefined();
    expect(gitnexusUidToLocalSymbolId("Function:onlyonecolon")).toBeUndefined();
    // A module path containing '#' cannot form a well-formed local id
    // (`toSymbolId`'s own guard) — this degrades to undefined, never a
    // mis-split id.
    expect(
      gitnexusUidToLocalSymbolId("Function:src/weird#name.ts:foo")
    ).toBeUndefined();
  });
});
