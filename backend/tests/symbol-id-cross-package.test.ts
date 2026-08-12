import {
  moduleOfSymbol as cgModuleOf,
  toSymbolId as cgToSymbolId,
} from "@muon/codegraph";
import {
  moduleOfSymbol as graphModuleOf,
  toSymbolId as graphToSymbolId,
} from "@muon/graph";
import { describe, expect, it } from "vitest";

// ADR-0012 F2, the symbol-id helpers exist in TWO copies: `@muon/graph` (used by
// the ledger + graph) and `@muon/codegraph` (used by the provider + extraction,
// kept native-dep-free so CG-1 never transitively loads LadybugDB's native addon).
// They are byte-identical today; the round-trip E2E only exercises single-`#` ids
// where every split variant (indexOf / lastIndexOf / off-by-one) AGREES, so a
// future divergence on multi-`#` / edge inputs would sail through green. THIS is
// the real merge-gate: a shared adversarial battery asserting both copies produce
// byte-identical output (and pinning F1's `#`-in-module decline in both).

const MODULES = [
  "src/a.ts",
  "backend/src/lib/preedit.ts",
  "packages/client/src/api-client.ts",
  "src/unicode/café.ts",
  "a",
  "",
];
const NAMES = [
  "foo",
  "MuonApiClient.preEditContext", // method: the '.' lives INSIDE the symbol part
  "#priv", // ES private-field NAME (only the MODULE side is guarded)
  "café", // unicode
  "with space",
  "",
];

describe("symbol-id helpers, cross-package byte-identity (ADR-0012 F2)", () => {
  it("toSymbolId agrees across @muon/graph and @muon/codegraph over the full battery", () => {
    for (const m of MODULES) {
      for (const n of NAMES) {
        expect(cgToSymbolId(m, n)).toBe(graphToSymbolId(m, n));
      }
    }
  });

  it("both copies DECLINE (null) when the MODULE path contains '#' (F1 pinned identically)", () => {
    for (const badModule of ["src/weird#name.ts", "a#b", "#lead.ts", "trailing#", "#"]) {
      expect(graphToSymbolId(badModule, "foo")).toBeNull();
      expect(cgToSymbolId(badModule, "foo")).toBeNull();
      // …and byte-identical decline.
      expect(cgToSymbolId(badModule, "foo")).toBe(graphToSymbolId(badModule, "foo"));
    }
  });

  it("moduleOfSymbol agrees across copies over multi-'#' + edge inputs (splits on the FIRST '#')", () => {
    const ids = [
      "src/a.ts#foo",
      "src/a.ts##priv", // private-field name → module recovered before the FIRST '#'
      "m#a#b", // multi-# → split on the FIRST
      "no-hash-module",
      "#leadingHash",
      "",
      "trailing#",
    ];
    for (const id of ids) {
      expect(cgModuleOf(id)).toBe(graphModuleOf(id));
    }
  });

  it("round-trip holds in BOTH copies for every in-namespace module (no '#'): moduleOfSymbol(toSymbolId(m,n)) === m", () => {
    for (const m of MODULES) {
      for (const n of NAMES) {
        const gid = graphToSymbolId(m, n);
        const cid = cgToSymbolId(m, n);
        expect(gid).not.toBeNull();
        expect(cid).not.toBeNull();
        expect(graphModuleOf(gid!)).toBe(m);
        expect(cgModuleOf(cid!)).toBe(m);
      }
    }
  });
});
