import { describe, expect, it } from "vitest";
import {
  DEFAULT_PYTHON_IMPORTS_EVAL_SET,
  buildScenarioEdges,
  formatPythonImportsEvalReport,
  runPythonImportsEval,
} from "../src/python-imports-eval.js";

// ADR-0016 GATE 1: PRECISION ≈ 1.0 on the labeled Python import fixture. A single
// WRONG module edge fails the merge (the cardinal sin, applied at MODULE level).
// Recall is reported but secondary (the conservative `from X import n → X` rule
// deliberately lowers it).

describe("python-imports eval, GATE 1: precision is the merge metric", () => {
  const report = runPythonImportsEval(DEFAULT_PYTHON_IMPORTS_EVAL_SET);

  it("PRECISION === 1.0 (no wrong module edge anywhere on the labeled set)", () => {
    expect(report.wrongEdges).toEqual([]);
    expect(report.falsePositives).toBe(0);
    expect(report.precision).toBe(1);
  });

  it("reports a real recall number, lowered ONLY by the conservative degrade misses", () => {
    expect(report.truePositives).toBe(11);
    // Exactly one deliberate miss: `from app import config` → package, not config.py.
    expect(report.falseNegatives).toBe(1);
    expect(report.recall).toBeCloseTo(11 / 12, 5);
    // Surface the numbers in the test log (honest reporting).
    // eslint-disable-next-line no-console
    console.log(formatPythonImportsEvalReport(report));
  });

  it("every ground-truth edge is emitted; every MUST-NOT edge is refused", () => {
    for (const scenario of DEFAULT_PYTHON_IMPORTS_EVAL_SET.scenarios) {
      const emitted = buildScenarioEdges(scenario);
      for (const [from, targets] of Object.entries(scenario.expectedEdges)) {
        for (const to of targets) {
          expect(emitted.has(`${from}|${to}`)).toBe(true);
        }
      }
      for (const [from, targets] of Object.entries(scenario.mustNot ?? {})) {
        for (const to of targets) {
          expect(emitted.has(`${from}|${to}`)).toBe(false);
        }
      }
    }
  });
});
