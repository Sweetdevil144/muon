import { describe, expect, expectTypeOf, it } from "vitest";
import {
  emptyHarnessConfig,
  evaluatorSpecSchema,
  evaluatorVerdictSchema,
  harnessConfigSchema,
  loopProgressSchema,
  type HarnessConfig,
} from "@muon/protocol";

const validEvaluatorSpec = {
  criteria: "Review it.",
};

const validEvaluatorVerdict = {
  pass: true,
  reason: "Approved.",
  fixHints: [],
};

const validLoopProgress = {
  iteration: 1,
  shell: [{ name: "tests", ok: true, exitCode: 0 }],
  evaluator: null,
  repairSeed: "",
  updatedAt: "2026-07-14T00:00:00.000Z",
};

describe("governed evaluator harness contract", () => {
  it("keeps the empty harness on the legacy loop", () => {
    const fresh = harnessConfigSchema.parse({});

    expect(emptyHarnessConfig).toStrictEqual(fresh);
    expect(emptyHarnessConfig.loopKind).toBe("check_repair");
    expect(Object.hasOwn(emptyHarnessConfig, "evaluator")).toBe(false);
  });

  it("defaults bounded critique_patch evaluator limits", () => {
    const harness = harnessConfigSchema.parse({
      requires: { interactive: false, worktree: true },
      loopKind: "critique_patch",
      evaluator: { criteria: "Reject missing error handling." },
    });

    expect(harness.evaluator).toMatchObject({
      maxDiffBytes: 64_000,
      timeoutMs: 120_000,
    });
  });

  it("accepts budget.maxIterations", () => {
    const harness = harnessConfigSchema.parse({
      budget: { maxIterations: 4 },
    });

    expect(harness.budget.maxIterations).toBe(4);
  });

  it("enforces evaluator criteria max 8000", () => {
    expect(() =>
      evaluatorSpecSchema.parse({
        ...validEvaluatorSpec,
        criteria: "c".repeat(8_000),
      })
    ).not.toThrow();
    expect(() =>
      evaluatorSpecSchema.parse({
        ...validEvaluatorSpec,
        criteria: "c".repeat(8_001),
      })
    ).toThrow();
  });

  it("enforces evaluator model max 200", () => {
    expect(() =>
      evaluatorSpecSchema.parse({
        ...validEvaluatorSpec,
        model: "m".repeat(200),
      })
    ).not.toThrow();
    expect(() =>
      evaluatorSpecSchema.parse({
        ...validEvaluatorSpec,
        model: "m".repeat(201),
      })
    ).toThrow();
  });

  it("enforces evaluator maxDiffBytes max 1000000", () => {
    expect(() =>
      evaluatorSpecSchema.parse({
        ...validEvaluatorSpec,
        maxDiffBytes: 1_000_000,
      })
    ).not.toThrow();
    expect(() =>
      evaluatorSpecSchema.parse({
        ...validEvaluatorSpec,
        maxDiffBytes: 1_000_001,
      })
    ).toThrow();
  });

  it("enforces evaluator timeoutMs max 600000", () => {
    expect(() =>
      evaluatorSpecSchema.parse({
        ...validEvaluatorSpec,
        timeoutMs: 600_000,
      })
    ).not.toThrow();
    expect(() =>
      evaluatorSpecSchema.parse({
        ...validEvaluatorSpec,
        timeoutMs: 600_001,
      })
    ).toThrow();
  });

  it("rejects critique_patch without an evaluator", () => {
    expect(() =>
      harnessConfigSchema.parse({
        loopKind: "critique_patch",
        requires: { interactive: false, worktree: true },
      })
    ).toThrow();
  });

  it("rejects an evaluator with check_repair", () => {
    expect(() =>
      harnessConfigSchema.parse({
        loopKind: "check_repair",
        evaluator: { criteria: "Review it." },
        requires: { interactive: false, worktree: true },
      })
    ).toThrow();
  });

  it("rejects an explicit cursor evaluator", () => {
    expect(() =>
      harnessConfigSchema.parse({
        loopKind: "critique_patch",
        evaluator: { laneKey: "cursor", criteria: "Review it." },
        requires: { interactive: false, worktree: true },
      })
    ).toThrow();
  });

  it("rejects an evaluator without a required worktree", () => {
    expect(() =>
      harnessConfigSchema.parse({
        loopKind: "critique_patch",
        evaluator: { criteria: "Review it." },
        requires: { interactive: false, worktree: false },
      })
    ).toThrow();
  });

  it("rejects propose_revise as a harness loop kind in v1", () => {
    expect(() =>
      harnessConfigSchema.parse({
        loopKind: "propose_revise",
      })
    ).toThrow();
  });

  it("narrows harness loop kinds to v1 at compile time", () => {
    expectTypeOf<HarnessConfig["loopKind"]>().toEqualTypeOf<
      "check_repair" | "critique_patch"
    >();
  });

  it("enforces evaluator verdict reason max 500", () => {
    expect(() =>
      evaluatorVerdictSchema.parse({
        ...validEvaluatorVerdict,
        reason: "r".repeat(500),
      })
    ).not.toThrow();
    expect(() =>
      evaluatorVerdictSchema.parse({
        ...validEvaluatorVerdict,
        reason: "r".repeat(501),
      })
    ).toThrow();
  });

  it("enforces evaluator verdict max 10 fixHints", () => {
    expect(() =>
      evaluatorVerdictSchema.parse({
        ...validEvaluatorVerdict,
        fixHints: Array.from({ length: 10 }, (_, index) => `Hint ${index}`),
      })
    ).not.toThrow();
    expect(() =>
      evaluatorVerdictSchema.parse({
        ...validEvaluatorVerdict,
        fixHints: Array.from({ length: 11 }, (_, index) => `Hint ${index}`),
      })
    ).toThrow();
  });

  it("enforces evaluator verdict hint max 300", () => {
    expect(() =>
      evaluatorVerdictSchema.parse({
        ...validEvaluatorVerdict,
        fixHints: ["h".repeat(300)],
      })
    ).not.toThrow();
    expect(() =>
      evaluatorVerdictSchema.parse({
        ...validEvaluatorVerdict,
        fixHints: ["h".repeat(301)],
      })
    ).toThrow();
  });

  it("requires evaluator verdict pass to be boolean", () => {
    expect(() =>
      evaluatorVerdictSchema.parse({
        ...validEvaluatorVerdict,
        pass: false,
      })
    ).not.toThrow();
    expect(() =>
      evaluatorVerdictSchema.parse({
        ...validEvaluatorVerdict,
        pass: "true",
      })
    ).toThrow();
  });

  it("validates durable loop progress as typed control state", () => {
    expect(loopProgressSchema.parse(validLoopProgress)).toEqual(validLoopProgress);
  });

  it("requires loop progress iteration to be a positive integer", () => {
    expect(() =>
      loopProgressSchema.parse({ ...validLoopProgress, iteration: 1 })
    ).not.toThrow();
    expect(() =>
      loopProgressSchema.parse({ ...validLoopProgress, iteration: 0 })
    ).toThrow();
    expect(() =>
      loopProgressSchema.parse({ ...validLoopProgress, iteration: 1.5 })
    ).toThrow();
  });

  it("validates loop progress shell control fields", () => {
    expect(() => loopProgressSchema.parse(validLoopProgress)).not.toThrow();
    expect(() =>
      loopProgressSchema.parse({
        ...validLoopProgress,
        shell: [{ name: "", ok: true, exitCode: 0 }],
      })
    ).toThrow();
    expect(() =>
      loopProgressSchema.parse({
        ...validLoopProgress,
        shell: [{ name: "tests", ok: "true", exitCode: 0 }],
      })
    ).toThrow();
    expect(() =>
      loopProgressSchema.parse({
        ...validLoopProgress,
        shell: [{ name: "tests", ok: true, exitCode: 0.5 }],
      })
    ).toThrow();
  });

  it("enforces loop progress repairSeed max 4000", () => {
    expect(() =>
      loopProgressSchema.parse({
        ...validLoopProgress,
        repairSeed: "r".repeat(4_000),
      })
    ).not.toThrow();
    expect(() =>
      loopProgressSchema.parse({
        ...validLoopProgress,
        repairSeed: "r".repeat(4_001),
      })
    ).toThrow();
  });

  it("enforces loop progress degraded max 300", () => {
    expect(() =>
      loopProgressSchema.parse({
        ...validLoopProgress,
        degraded: "d".repeat(300),
      })
    ).not.toThrow();
    expect(() =>
      loopProgressSchema.parse({
        ...validLoopProgress,
        degraded: "d".repeat(301),
      })
    ).toThrow();
  });

  it("requires loop progress updatedAt to be a valid datetime", () => {
    expect(() =>
      loopProgressSchema.parse({
        ...validLoopProgress,
        updatedAt: "2026-07-14T00:00:00.000Z",
      })
    ).not.toThrow();
    expect(() =>
      loopProgressSchema.parse({
        ...validLoopProgress,
        updatedAt: "not-a-datetime",
      })
    ).toThrow();
  });

  it("requires a nonempty loop progress evaluator laneKey", () => {
    expect(() =>
      loopProgressSchema.parse({
        ...validLoopProgress,
        evaluator: {
          ...validEvaluatorVerdict,
          laneKey: "codex",
        },
      })
    ).not.toThrow();
    expect(() =>
      loopProgressSchema.parse({
        ...validLoopProgress,
        evaluator: {
          ...validEvaluatorVerdict,
          laneKey: "",
        },
      })
    ).toThrow();
  });
});
