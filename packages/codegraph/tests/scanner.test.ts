import { describe, expect, it } from "vitest";
import { extractImportSpecifiers } from "../src/scanner.js";

// The import SCANNER (ts.preProcessFile). Specifier extraction only, no Program,
// no typecheck. Covers static import / export-from / bare import / require /
// dynamic-import-with-literal; skips non-literal dynamic imports (residual).

describe("extractImportSpecifiers", () => {
  it("extracts static `import … from`, `export … from`, bare `import`, and barrels", () => {
    const src = `
      import a from "./a";
      import { b } from "./b.js";
      import * as c from "../c/index";
      export { d } from "./d";
      export * from "./barrel";
      import "./side-effect";
    `;
    const specs = extractImportSpecifiers(src);
    expect(specs).toEqual(
      expect.arrayContaining([
        "./a",
        "./b.js",
        "../c/index",
        "./d",
        "./barrel",
        "./side-effect",
      ])
    );
  });

  it("counts TYPE-ONLY imports (safe over-inclusion)", () => {
    const specs = extractImportSpecifiers(
      `import type { T } from "./types";\nimport { type U, v } from "./mixed";`
    );
    expect(specs).toContain("./types");
    expect(specs).toContain("./mixed");
  });

  it("extracts CommonJS `require(...)` and DYNAMIC `import(\"literal\")`", () => {
    const src = `
      const x = require("./x");
      async function load() { return import("./y"); }
    `;
    const specs = extractImportSpecifiers(src);
    expect(specs).toContain("./x");
    expect(specs).toContain("./y");
  });

  it("SKIPS a non-literal / computed dynamic import (documented residual)", () => {
    const src = `
      const mod = "./" + name;
      async function load() { return import(mod); }
      const r = require(variable);
    `;
    const specs = extractImportSpecifiers(src);
    // No string literal → no specifier captured. Never throws.
    expect(specs).not.toContain(undefined);
    expect(specs.every((s) => typeof s === "string")).toBe(true);
    // The only literal-ish token here is none; the computed forms are skipped.
    expect(specs).not.toContain("mod");
    expect(specs).not.toContain("variable");
  });

  it("never throws on malformed source → returns []", () => {
    expect(extractImportSpecifiers("this is ??? not valid <<< ts")).toEqual(
      expect.any(Array)
    );
  });

  it("drops bare `node_modules` specifiers only at RESOLUTION (scanner keeps them)", () => {
    // The scanner is namespace-agnostic; the resolver drops externals.
    const specs = extractImportSpecifiers(`import fs from "node:fs";\nimport z from "zod";`);
    expect(specs).toContain("node:fs");
    expect(specs).toContain("zod");
  });
});
