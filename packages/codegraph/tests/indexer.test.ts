import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildReverseImportIndex } from "../src/indexer.js";

// ADR-0015 R1, the SYMBOL layer built in the SAME file loop as the module index,
// under its own sub-budget. Over-budget (or disabled) → the symbol layer is skipped
// and marked unavailable, but the module index is byte-for-byte intact.

let root: string;

function write(rel: string, content: string) {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cg-indexer-")));
  write("package.json", "{}");
  write("src/a.ts", "export const a = 1;");
  write("src/b.ts", "import { a } from './a.js';\nexport const b = a + 1;");
  write("src/c.ts", "import { b } from './b.js';\nexport const c = b + 1;");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("buildReverseImportIndex, symbol layer (R1)", () => {
  it("populates symbolReverse with import-resolved reference edges", () => {
    const index = buildReverseImportIndex({ root });
    expect(index.symbolLayerAvailable).toBe(true);
    // b#b references a#a; c#c references b#b.
    expect(index.symbolReverse.get("src/a.ts#a")).toEqual(new Set(["src/b.ts#b"]));
    expect(index.symbolReverse.get("src/b.ts#b")).toEqual(new Set(["src/c.ts#c"]));
    // The MODULE index is present and correct alongside it.
    expect(index.reverse.get(join(root, "src/a.ts"))).toEqual(
      new Set([join(root, "src/b.ts")])
    );
  });

  it("SUB-BUDGET (maxSymbolScanMs=0) disables the symbol layer; module index intact", () => {
    const index = buildReverseImportIndex({
      root,
      budget: { maxSymbolScanMs: 0 },
    });
    expect(index.symbolLayerAvailable).toBe(false);
    expect(index.symbolReverse.size).toBe(0);
    // The always-correct module floor is unaffected, no regression.
    expect(index.reverse.get(join(root, "src/a.ts"))).toEqual(
      new Set([join(root, "src/b.ts")])
    );
    expect(index.fileCount).toBe(3);
  });
});
