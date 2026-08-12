import { describe, expect, it, vi } from "vitest";
import {
  captureFromMemoryProposals,
  captureFromSignal,
  ingestCandidates,
} from "../src/memory-capture.js";
import type { MemoryCandidate } from "../src/memory-extract-lane.js";

describe("captureFromSignal", () => {
  it("turns a CONCERNS review verdict into one attempt note", () => {
    const notes = captureFromSignal(
      { type: "second_opinion", verdict: "VERDICT: CONCERNS the retry has no upper bound" },
      { taskId: "task-1", laneId: "lane-1" }
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "attempt", trust: "low", taskId: "task-1" });
    expect(notes[0]!.text).toContain("Review raised concerns");
  });

  it("records nothing for a clean APPROVE", () => {
    expect(
      captureFromSignal({ type: "second_opinion", verdict: "VERDICT: APPROVE looks good" })
    ).toEqual([]);
  });

  it("captures a non-converging loop, ignores an empty stop reason", () => {
    expect(
      captureFromSignal({ type: "loop_escalation", stopReason: "typecheck still failing after 3 tries" })
    ).toHaveLength(1);
    expect(captureFromSignal({ type: "loop_escalation", stopReason: "" })).toEqual([]);
  });

  it("captures an open question and ensures it ends with '?'", () => {
    const notes = captureFromSignal({ type: "open_question", question: "Which DB owns the runner heartbeat" });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.kind).toBe("question");
    expect(notes[0]!.text.endsWith("?")).toBe(true);
  });

  it("captures an execution attempt with a structured outcome", () => {
    const notes = captureFromSignal({
      type: "execution_attempt",
      summary: "replace the parser with a streaming state machine",
      outcome: "abandoned",
    });
    expect(notes).toEqual([
      expect.objectContaining({
        kind: "attempt",
        outcome: "abandoned",
        topics: ["mission", "attempt"],
      }),
    ]);
  });
});

describe("ingestCandidates", () => {
  const candidates: MemoryCandidate[] = [
    { kind: "decision", text: "a", topics: [], modules: [], trust: "low", createdBy: "muon-capture" },
    { kind: "attempt", text: "b", topics: [], modules: [], trust: "low", createdBy: "muon-capture" },
    { kind: "question", text: "c", topics: [], modules: [], trust: "low", createdBy: "muon-capture" },
  ];

  it("tallies how each write resolved", async () => {
    const sink = {
      addMemoryNoteWithAction: vi
        .fn()
        .mockResolvedValueOnce({ action: "inserted" })
        .mockResolvedValueOnce({ action: "duplicate" })
        .mockResolvedValueOnce({ action: "inserted" }),
    };
    const summary = await ingestCandidates(sink, candidates);
    expect(summary).toEqual({
      proposed: 3,
      ingested: 3,
      actions: { inserted: 2, duplicate: 1 },
    });
    expect(sink.addMemoryNoteWithAction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ outcome: undefined })
    );
  });

  it("swallows a failed write so capture never breaks the job", async () => {
    const sink = {
      addMemoryNoteWithAction: vi
        .fn()
        .mockResolvedValueOnce({ action: "inserted" })
        .mockRejectedValueOnce(new Error("brain unreachable"))
        .mockResolvedValueOnce({ action: "inserted" }),
    };
    const summary = await ingestCandidates(sink, candidates);
    expect(summary.proposed).toBe(3);
    expect(summary.ingested).toBe(2);
  });
});

describe("captureFromMemoryProposals", () => {
  it("keeps proposals provisional and anchors only caller-supplied modules", () => {
    const notes = captureFromMemoryProposals(
      [
        {
          kind: "constraint",
          text: "The parser accepts only the final complete report.",
        },
      ],
      {
        taskId: "task-1",
        laneId: "lane-1",
        modules: ["packages/core/src/worker-final-report.ts"],
        createdBy: "agent:codex",
      }
    );

    expect(notes).toEqual([
      expect.objectContaining({
        kind: "constraint",
        trust: "low",
        taskId: "task-1",
        laneId: "lane-1",
        modules: ["packages/core/src/worker-final-report.ts"],
        createdBy: "agent:codex",
      }),
    ]);
  });
});
