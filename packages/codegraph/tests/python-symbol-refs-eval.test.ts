import { describe, expect, it } from "vitest";
import {
  DEFAULT_PYTHON_SYMBOL_REFS_EVAL_SET,
  emittedPyReferencers,
  formatPythonSymbolRefsEvalReport,
  runPythonSymbolRefsEval,
} from "../src/python-symbol-refs-eval.js";

// REC-010 / ADR-0015 parity, GATE 1 for the Python symbol layer: PRECISION === 1.0
// on the labeled fixture corpus. A single wrong symbol edge fails the merge.
// Recall is reported but secondary (the degrade fixtures deliberately lower it).

describe("python symbol-reference eval, GATE 1: precision is the merge metric", () => {
  const report = runPythonSymbolRefsEval(DEFAULT_PYTHON_SYMBOL_REFS_EVAL_SET);

  it("PRECISION === 1.0 (zero wrong edges anywhere on the labeled set)", () => {
    expect(report.wrongEdges).toEqual([]);
    expect(report.falsePositives).toBe(0);
    expect(report.precision).toBe(1);
  });

  it("reports a real recall number, lowered ONLY by the deliberate degrade misses", () => {
    // 8 captured true referencers; 6 deliberate degrade misses (star, __init__
    // re-export, plain import, try/except, shadowing, monkey-patch).
    expect(report.truePositives).toBe(8);
    expect(report.falseNegatives).toBe(6);
    expect(report.recall).toBeCloseTo(8 / 14, 5);
    // Surface the numbers in the test log (honest reporting).
    // eslint-disable-next-line no-console
    console.log(formatPythonSymbolRefsEvalReport(report));
  });

  it("every planted FALSE referencer is excluded; every planted TRUE referencer is emitted", () => {
    for (const scenario of DEFAULT_PYTHON_SYMBOL_REFS_EVAL_SET.scenarios) {
      const emitted = new Set(emittedPyReferencers(scenario));
      for (const truth of scenario.trueReferencers) {
        expect(emitted.has(truth), `${scenario.id}: missing ${truth}`).toBe(true);
      }
      for (const wrong of scenario.falseReferencers) {
        expect(emitted.has(wrong), `${scenario.id}: wrong ${wrong}`).toBe(false);
      }
    }
  });
});
