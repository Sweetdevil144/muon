import { describe, expect, it } from "vitest";
import { extractSymbolDefs } from "../src/symbols.js";
import {
  DEFAULT_SYMBOL_REFS_EVAL_SET,
  emittedReferencers,
  formatSymbolRefsEvalReport,
  runSymbolRefsEval,
} from "../src/symbol-refs-eval.js";

// ADR-0015 §6, GATE 1: PRECISION ≈ 1.0 on the labeled fixture. A single wrong
// symbol edge fails the merge. Recall is reported but secondary (the degrade
// fixtures deliberately lower it).

describe("symbol-reference eval, GATE 1: precision is the merge metric", () => {
  const report = runSymbolRefsEval(DEFAULT_SYMBOL_REFS_EVAL_SET);

  it("PRECISION === 1.0 (no wrong edge anywhere on the labeled set)", () => {
    expect(report.wrongEdges).toEqual([]);
    expect(report.falsePositives).toBe(0);
    expect(report.precision).toBe(1);
  });

  it("reports a real recall number, lowered ONLY by the deliberate degrade misses", () => {
    // 7 captured true referencers; 2 deliberate degrade misses (namespace + barrel).
    expect(report.truePositives).toBe(7);
    expect(report.falseNegatives).toBe(2);
    expect(report.recall).toBeCloseTo(7 / 9, 5);
    // Surface the numbers in the test log (honest reporting).
    // eslint-disable-next-line no-console
    console.log(formatSymbolRefsEvalReport(report));
  });

  it("every planted FALSE referencer is excluded; every planted TRUE referencer is emitted", () => {
    for (const scenario of DEFAULT_SYMBOL_REFS_EVAL_SET.scenarios) {
      const emitted = new Set(emittedReferencers(scenario));
      for (const truth of scenario.trueReferencers) {
        expect(emitted.has(truth)).toBe(true);
      }
      for (const wrong of scenario.falseReferencers) {
        expect(emitted.has(wrong)).toBe(false);
      }
    }
  });
});

describe("symbol-reference eval, referencer ids AGREE with extractSymbolDefs", () => {
  it("a caller id is byte-identical to the id capture would produce for that decl", () => {
    // The referencer id `b.ts#bar` must equal the id `extractSymbolDefs` emits for
    // `bar` in b.ts, so a governed note anchored via capture fuses against it.
    const bText = "import { foo } from './m';\nexport function bar(){ return foo(); }";
    const defIds = new Set(extractSymbolDefs(bText, "b.ts").map((d) => d.id));
    const emitted = emittedReferencers({
      id: "agreement",
      rule: "capture",
      files: [
        { module: "m.ts", text: "export function foo(){ return 1; }" },
        { module: "b.ts", text: bText },
      ],
      target: "m.ts#foo",
      trueReferencers: ["b.ts#bar"],
      falseReferencers: [],
    });
    expect(emitted).toContain("b.ts#bar");
    expect(defIds.has("b.ts#bar")).toBe(true);
  });
});
