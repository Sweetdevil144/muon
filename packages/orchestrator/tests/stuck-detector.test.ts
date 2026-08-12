import { describe, expect, it } from "vitest";
import {
  detectStuckPattern,
  normalizeStuckText,
  stuckStepsFromChunks,
  type StuckStep,
} from "../src/stuck-detector.js";
import { decideContinuation } from "../src/reconcile.js";

function action(
  key: string,
  opts?: Partial<Pick<StuckStep, "isError" | "isContextWindowError">>
): StuckStep {
  return {
    key,
    isAction: true,
    isError: opts?.isError ?? false,
    isContextWindowError: opts?.isContextWindowError ?? false,
  };
}

function mono(key: string): StuckStep {
  return {
    key,
    isAction: false,
    isError: false,
    isContextWindowError: false,
  };
}

describe("TODO 5.4: stuck detector", () => {
  it("normalizes ids and timestamps out of equality", () => {
    const a = normalizeStuckText(
      "Edit packages/foo.ts id=550e8400-e29b-41d4-a716-446655440000 at 2026-07-31T00:00:00.000Z"
    );
    const b = normalizeStuckText(
      "Edit packages/foo.ts id=11111111-2222-4333-8444-555555555555 at 2026-07-31T01:02:03.000Z"
    );
    expect(a).toBe(b);
  });

  it("halts identical action/observation ×4", () => {
    const halt = detectStuckPattern([
      action("edit|foo"),
      action("edit|foo"),
      action("edit|foo"),
      action("edit|foo"),
    ]);
    expect(halt?.pattern).toBe("identical_action_observation");
    expect(halt?.message).toBe("Halted: identical action/observation ×4");
  });

  it("halts action/error ×3", () => {
    const halt = detectStuckPattern([
      action("shell|npm test", { isError: true }),
      action("shell|npm test", { isError: true }),
      action("shell|npm test", { isError: true }),
    ]);
    expect(halt?.pattern).toBe("action_error");
    expect(halt?.count).toBe(3);
  });

  it("halts monologue ×3 when near-duplicate", () => {
    const halt = detectStuckPattern([
      mono("i am thinking about the approach carefully"),
      mono("i am thinking about the approach carefully now"),
      mono("i am thinking about the approach carefully again"),
    ]);
    expect(halt?.pattern).toBe("monologue");
  });

  it("halts alternating pattern ×6", () => {
    const halt = detectStuckPattern([
      action("a"),
      action("b"),
      action("a"),
      action("b"),
      action("a"),
      action("b"),
    ]);
    expect(halt?.pattern).toBe("ping_pong_alternation");
    expect(halt?.message).toBe("Halted: alternating pattern ×6");
  });

  it("halts repeated context-window errors", () => {
    const halt = detectStuckPattern([
      action("chat", { isContextWindowError: true }),
      action("chat", { isContextWindowError: true }),
    ]);
    expect(halt?.pattern).toBe("context_window_error");
  });

  it("projects steps from activity chunks since the last human turn", () => {
    const steps = stuckStepsFromChunks([
      { kind: "user.message", content: "[you] go" },
      {
        kind: "activity",
        content: "Edit",
        detail: {
          args: "path=foo.ts",
          result: "ok id=550e8400-e29b-41d4-a716-446655440000",
        },
      },
      {
        kind: "activity",
        content: "Edit",
        detail: {
          args: "path=foo.ts",
          result: "ok id=11111111-2222-4333-8444-555555555555",
        },
      },
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.key).toBe(steps[1]!.key);
  });

  it("treats a trusted milestone as progress, not agent payload", () => {
    const steps = stuckStepsFromChunks([
      { kind: "user.message", content: "[you] go" },
      { kind: "output.message", content: "Still collecting the mission result." },
      { kind: "output.message", content: "Still collecting the mission result." },
      { kind: "output.message", content: "Still collecting the mission result." },
      { kind: "milestone", content: "[event] job child-a terminal" },
      { kind: "output.message", content: "Still collecting the mission result." },
    ]);

    expect(steps.some((step) => step.boundary)).toBe(true);
    expect(detectStuckPattern(steps)).toBeNull();
  });

  it("decideContinuation yields affordance when stuckReason is set", () => {
    expect(
      decideContinuation({
        uncertain: false,
        autoContinueEnabled: true,
        autoTurnsUsed: 0,
        stuckReason: "Halted: alternating pattern ×6",
      })
    ).toBe("affordance");
  });
});
