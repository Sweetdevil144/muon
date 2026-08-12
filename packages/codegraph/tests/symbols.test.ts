import { describe, expect, it } from "vitest";
import { extractSymbolDefs } from "../src/symbols.js";

// ADR-0012 Phase 2, exported/top-level symbol-definition extraction via
// `ts.createSourceFile` (zero native deps, never throws). Emits `<module>#<name>`
// ids in the workspace-relative POSIX namespace the caller supplies.

const M = "src/mod.ts";
const names = (src: string) =>
  new Set(extractSymbolDefs(src, M).map((d) => d.name));

describe("extractSymbolDefs (ADR-0012 Phase 2)", () => {
  it("emits <module>#<name> ids for exported declarations", () => {
    const defs = extractSymbolDefs(
      `export function foo() {}\nexport class Bar {}\n`,
      M
    );
    expect(defs.map((d) => d.id).sort()).toEqual([
      "src/mod.ts#Bar",
      "src/mod.ts#foo",
    ]);
    // The module prefix is exactly the caller-supplied (already-canonical) module.
    expect(defs.every((d) => d.module === M)).toBe(true);
  });

  it("covers function / class / interface / type / enum / var (incl. multi-declarator)", () => {
    const src = `
      export function fn() {}
      export class Cls {}
      export interface Iface {}
      export type Alias = number;
      export enum En { A }
      export const v = 1, w = 2;
    `;
    expect(names(src)).toEqual(
      new Set(["fn", "Cls", "Iface", "Alias", "En", "v", "w"])
    );
  });

  it("OVERLOADS collapse to ONE id (name-based, v1)", () => {
    const src = `
      export function over(a: string): void;
      export function over(a: number): void;
      export function over(a: unknown): void {}
    `;
    expect(extractSymbolDefs(src, M).filter((d) => d.name === "over")).toHaveLength(1);
  });

  it("re-exports resolve to the EXPORTED name (`b as c` → c)", () => {
    expect(names(`export { a, b as c } from "./other.js";`)).toEqual(
      new Set(["a", "c"])
    );
  });

  it("a top-level LOCAL is captured; a NESTED symbol (inside a body) is NOT", () => {
    const src = `
      function topLevel() { const nested = 1; return nested; }
      export const x = () => { function inner() {} return inner; };
    `;
    const emitted = names(src);
    expect(emitted.has("topLevel")).toBe(true);
    expect(emitted.has("x")).toBe(true);
    expect(emitted.has("nested")).toBe(false);
    expect(emitted.has("inner")).toBe(false);
  });

  it("`export default function () {}` collapses to the `default` name", () => {
    expect(names(`export default function () {}`)).toContain("default");
  });

  it("never throws on malformed source (returns an array)", () => {
    expect(Array.isArray(extractSymbolDefs("export function (((", M))).toBe(true);
    expect(Array.isArray(extractSymbolDefs("", M))).toBe(true);
  });

  it("F1: a module path containing '#' emits NO symbol defs (degrade to MODULE-level, no mis-derivation)", () => {
    // `src/weird#name.ts` is a real file, but its `#` is our id delimiter, the
    // file gets NO symbol anchor and its raw path stays a valid module anchor.
    expect(extractSymbolDefs(`export function foo() {}`, "src/weird#name.ts")).toEqual([]);
    expect(extractSymbolDefs(`export class Bar {}`, "a#b#c.ts")).toEqual([]);
  });
});
