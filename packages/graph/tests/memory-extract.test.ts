import { describe, expect, it } from "vitest";
import { extractFromSignal } from "../src/memory-extract.js";

describe("deterministic memory extraction", () => {
  it("captures review CONCERNS as an attempt note, ignores clean APPROVE", () => {
    const concern = extractFromSignal({
      type: "second_opinion",
      verdict: "VERDICT: CONCERNS the repro test does not cover the null path",
      taskId: "task-1",
      modules: ["src/auth.ts"],
    });
    expect(concern).toHaveLength(1);
    expect(concern[0].kind).toBe("attempt");
    expect(concern[0].text).toContain("null path");
    expect(concern[0].taskId).toBe("task-1");

    const approve = extractFromSignal({
      type: "second_opinion",
      verdict: "VERDICT: APPROVE looks correct",
    });
    expect(approve).toEqual([]);
  });

  it("captures a non-converging loop as an attempt note", () => {
    const notes = extractFromSignal({
      type: "loop_escalation",
      stopReason: "iteration budget exhausted (3)",
      taskId: "task-2",
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe("attempt");
    expect(notes[0].text).toContain("could not converge");
  });

  it("captures a handoff open question as a question note", () => {
    const notes = extractFromSignal({
      type: "open_question",
      question: "who owns the migration for this table",
      laneId: "lane-cx",
    });
    expect(notes[0].kind).toBe("question");
    expect(notes[0].text.endsWith("?")).toBe(true);
  });

  it("returns nothing for empty/degenerate signals", () => {
    expect(
      extractFromSignal({ type: "loop_escalation", stopReason: "" })
    ).toEqual([]);
    expect(
      extractFromSignal({ type: "open_question", question: "?" })
    ).toEqual([]);
  });
});
