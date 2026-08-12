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

// LOW-2: `maxSymbolScanMs` is a SINGLE budget SHARED across the TS and Python
// adapters (accumulated in ONE indexer loop). This pins the graceful outcome:
// when the shared sub-budget is unavailable — disabled here, the same
// `symbolLayerAvailable=false` mechanism a mid-scan EXHAUSTION on a Python-heavy
// repo trips — BOTH languages' symbol edges degrade to module-level and NOTHING
// throws; the always-correct module reverse-import floor is intact for both.

let root: string;

function write(rel: string, content: string) {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cg-mixed-budget-")));
  write("package.json", "{}");
  // TS symbol edge: src/x.ts#x ← src/y.ts#y
  write("src/x.ts", "export const x = 1;");
  write("src/y.ts", "import { x } from './x.js';\nexport const y = x + 1;");
  // Python symbol edge: m.py#helper ← b.py#bar
  write("m.py", "def helper(v):\n    return v\n");
  write("b.py", "from m import helper\ndef bar():\n    return helper(1)\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("shared maxSymbolScanMs budget across adapters (LOW-2)", () => {
  it("full budget: BOTH TS and Python symbol edges are populated", () => {
    const index = buildReverseImportIndex({ root });
    expect(index.symbolLayerAvailable).toBe(true);
    expect(index.symbolReverse.get("src/x.ts#x")).toEqual(
      new Set(["src/y.ts#y"])
    );
    expect(index.symbolReverse.get("m.py#helper")).toEqual(
      new Set(["b.py#bar"])
    );
  });

  it("budget unavailable: TS symbol edges degrade to module-level, no throw", () => {
    const index = buildReverseImportIndex({
      root,
      budget: { maxSymbolScanMs: 0 },
    });
    // No symbol edges for EITHER language, and the call did not throw.
    expect(index.symbolLayerAvailable).toBe(false);
    expect(index.symbolReverse.size).toBe(0);
    // The module reverse-import floor is intact for BOTH languages.
    expect(index.reverse.get(join(root, "src/x.ts"))).toEqual(
      new Set([join(root, "src/y.ts")])
    );
    expect(index.reverse.get(join(root, "m.py"))).toEqual(
      new Set([join(root, "b.py")])
    );
  });
});
