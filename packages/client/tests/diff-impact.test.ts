import { describe, expect, it } from "vitest";
import {
  buildDiffImpact,
  diffImpactQueries,
  type DiffImpactInput,
} from "../src/diff-impact.js";

const base = (over: Partial<DiffImpactInput> = {}): DiffImpactInput => ({
  scope: "compare",
  changedFiles: [{ path: "src/gate.ts", hunks: [{ start: 10, end: 20 }] }],
  graphFiles: ["src/gate.ts"],
  symbols: [
    { file: "src/gate.ts", name: "redeemGate", kind: "Function", startLine: 8, endLine: 25 },
    { file: "src/gate.ts", name: "unrelated", kind: "Function", startLine: 40, endLine: 60 },
  ],
  steps: [
    { file: "src/gate.ts", symbol: "redeemGate", startLine: 8, endLine: 25, process: "RedeemGateAtRoute", processId: "proc_1", step: 3, entryPointId: "ep_1" },
  ],
  indexFreshness: { graphCommit: "abc", headCommit: "abc", stale: false },
  ...over,
});

describe("buildDiffImpact — flows-resolved (happy path)", () => {
  it("maps a hunk to the symbol it touches and the process step it disturbs", () => {
    const impact = buildDiffImpact(base());
    expect(impact.verdict).toBe("flows-resolved");
    expect(impact.changedSymbols.map((s) => s.name)).toEqual(["redeemGate"]); // NOT "unrelated" (line 40-60, outside hunk 10-20)
    expect(impact.affectedProcesses).toHaveLength(1);
    expect(impact.affectedProcesses[0]).toMatchObject({
      process: "RedeemGateAtRoute",
      steps: [3],
      via: ["redeemGate"],
    });
    expect(impact.coverage).toBe(1);
    expect(impact.totals.blindFiles).toBe(0);
  });

  it("only intersecting symbols count (hunk-level precision, no whole-file flooding)", () => {
    const impact = buildDiffImpact(
      base({
        symbols: [
          { file: "src/gate.ts", name: "a", kind: "Function", startLine: 1, endLine: 5 },
          { file: "src/gate.ts", name: "b", kind: "Function", startLine: 12, endLine: 14 },
          { file: "src/gate.ts", name: "c", kind: "Function", startLine: 100, endLine: 120 },
        ],
        steps: [],
      })
    );
    expect(impact.changedSymbols.map((s) => s.name)).toEqual(["b"]); // only b intersects 10-20
  });
});

describe("buildDiffImpact — FAIL-CLOSED coverage guard (the point)", () => {
  it("a changed file with no File node is REVIEW BLIND, never silently dropped", () => {
    const impact = buildDiffImpact(
      base({
        changedFiles: [
          { path: "src/gate.ts", hunks: [{ start: 10, end: 20 }] },
          { path: "src/brand-new.ts", hunks: [{ start: 1, end: 50 }] }, // not indexed
        ],
        graphFiles: ["src/gate.ts"], // only the old file is in the graph
      })
    );
    expect(impact.verdict).toBe("review-blind");
    expect(impact.blindFiles).toEqual(["src/brand-new.ts"]);
    expect(impact.totals.blindFiles).toBe(1);
    expect(impact.coverage).toBe(0.5);
    expect(impact.notes.join(" ")).toMatch(/REVIEW BLIND|all-clear/i);
  });

  it("a diff of ENTIRELY new files does not report a false all-clear", () => {
    const impact = buildDiffImpact(
      base({
        changedFiles: [{ path: "src/new-feature.ts", hunks: [{ start: 1, end: 80 }] }],
        graphFiles: [], // graph knows nothing
        symbols: [],
        steps: [],
      })
    );
    // The dangerous case: 0 affected processes MUST NOT read as "safe".
    expect(impact.affectedProcesses).toHaveLength(0);
    expect(impact.verdict).toBe("review-blind"); // NOT flows-resolved
    expect(impact.coverage).toBe(0);
  });

  it("a stale index forces review-blind even when every file is resolved", () => {
    const impact = buildDiffImpact(
      base({ indexFreshness: { graphCommit: "old", headCommit: "new", stale: true } })
    );
    expect(impact.verdict).toBe("review-blind");
    expect(impact.notes.join(" ")).toMatch(/stale/i);
  });
});

describe("buildDiffImpact — edges", () => {
  it("no changed files → no-op verdict, coverage 1", () => {
    const impact = buildDiffImpact(base({ changedFiles: [] }));
    expect(impact.verdict).toBe("no-op");
    expect(impact.coverage).toBe(1);
    expect(impact.totals.changedFiles).toBe(0);
  });

  it("a file changed with no hunk detail treats every symbol as touched", () => {
    const impact = buildDiffImpact(
      base({
        changedFiles: [{ path: "src/gate.ts", hunks: [] }], // binary/rename, no line detail
      })
    );
    // both symbols in the file count (fail-safe: don't under-report)
    expect(impact.changedSymbols.map((s) => s.name).sort()).toEqual(["redeemGate", "unrelated"]);
  });

  it("dedups step ordinals and ranks processes by touch count", () => {
    const impact = buildDiffImpact(
      base({
        symbols: [
          { file: "src/gate.ts", name: "a", kind: "Function", startLine: 10, endLine: 12 },
          { file: "src/gate.ts", name: "b", kind: "Function", startLine: 14, endLine: 16 },
        ],
        steps: [
          { file: "src/gate.ts", symbol: "a", startLine: 10, endLine: 12, process: "P1", processId: "p1", step: 1 },
          { file: "src/gate.ts", symbol: "a", startLine: 10, endLine: 12, process: "P1", processId: "p1", step: 1 }, // dup step
          { file: "src/gate.ts", symbol: "b", startLine: 14, endLine: 16, process: "P1", processId: "p1", step: 2 },
          { file: "src/gate.ts", symbol: "a", startLine: 10, endLine: 12, process: "P2", processId: "p2", step: 5 },
        ],
      })
    );
    expect(impact.affectedProcesses[0]!.process).toBe("P1"); // 2 steps, ranked first
    expect(impact.affectedProcesses[0]!.steps).toEqual([1, 2]);
    expect(impact.affectedProcesses[0]!.via).toEqual(["a", "b"]);
  });
});

describe("diffImpactQueries", () => {
  it("interpolates the quoted file list into all three reads", () => {
    const q = diffImpactQueries(`'src/a.ts', 'src/b.ts'`);
    expect(q.files).toContain("f:File");
    expect(q.files).toContain(`'src/a.ts', 'src/b.ts'`);
    expect(q.symbols).toContain("startLine");
    expect(q.steps).toContain("STEP_IN_PROCESS");
    expect(q.steps).toContain("r.step AS step");
  });
});
