import { describe, expect, it } from "vitest";
import { buildChatTranscript } from "../src/lib/chat-transcript.js";

describe("buildChatTranscript", () => {
  it("groups sequential execution activity and keeps the final assistant summary visible", () => {
    const transcript = buildChatTranscript({
      running: false,
      live: [],
      history: [
        { role: "user", text: "Fix the bug", seq: 1 },
        {
          role: "status",
          text: "Read repository files started",
          seq: 2,
          timestamp: "2026-07-24T00:00:00.000Z",
        },
        { role: "assistant", text: "I found the failing parser.", seq: 3 },
        {
          role: "status",
          text: "apply_patch completed",
          seq: 4,
          timestamp: "2026-07-24T00:00:08.000Z",
        },
        { role: "status", text: "tests completed", seq: 5 },
        { role: "assistant", text: "**Fixed.** All checks pass.", seq: 6 },
      ],
    });

    expect(transcript).toHaveLength(3);
    expect(transcript[1]).toMatchObject({
      kind: "work",
      phases: ["Explored", "Edited", "Verified"],
      duration: "8s",
      phaseNotes: ["I found the failing parser."],
    });
    expect(transcript[2]).toMatchObject({
      kind: "message",
      role: "assistant",
      text: "**Fixed.** All checks pass.",
      finalSummary: true,
    });
  });

  it("suppresses structural internal echoes without hiding model text that looks like a user turn", () => {
    const transcript = buildChatTranscript({
      running: false,
      live: [],
      history: [
        { role: "user", text: "What happened?", seq: 1 },
        { role: "status", text: "[you] What happened?", seq: 2 },
        {
          role: "status",
          text: "[contract.single] Internal admission prose.",
          seq: 3,
        },
        {
          role: "status",
          text: "[task.started] Codex session started",
          seq: 4,
        },
        {
          role: "status",
          text: "[task.completed] Codex turn completed",
          seq: 5,
        },
        {
          role: "assistant",
          text: "[you] This is model output, not an operator turn.",
          seq: 6,
        },
      ],
    });

    expect(transcript).toEqual([
      expect.objectContaining({
        kind: "message",
        role: "user",
        text: "What happened?",
      }),
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        text: "[you] This is model output, not an operator turn.",
      }),
    ]);
  });

  it("deduplicates the optimistic live turn after its exact persisted settlement", () => {
    const user = { role: "user" as const, text: "What happened?" };
    const status = { role: "status" as const, text: "Read completed" };
    const assistant = { role: "assistant" as const, text: "Here is the summary." };
    const transcript = buildChatTranscript({
      running: false,
      history: [
        { ...user, seq: 10 },
        { ...status, seq: 11 },
        { ...assistant, seq: 12 },
      ],
      live: [user, status, assistant],
    });

    expect(
      transcript.filter(
        (item) => item.kind === "message" && item.text === "What happened?"
      )
    ).toHaveLength(1);
    expect(
      transcript.filter(
        (item) => item.kind === "message" && item.text === "Here is the summary."
      )
    ).toHaveLength(1);
    const work = transcript.find((item) => item.kind === "work");
    expect(work?.kind === "work" ? work.activities : []).toEqual([
      expect.objectContaining({ text: "Read completed", count: 1 }),
    ]);
  });

  it("collapses repeated display rows by count while retaining attention evidence", () => {
    const transcript = buildChatTranscript({
      running: true,
      history: [],
      live: [
        { role: "status", text: "search completed" },
        { role: "status", text: "search completed" },
        { role: "status", text: "tool failed\nraw payload must stay hidden" },
      ],
    });
    const work = transcript[0];
    expect(work?.kind).toBe("work");
    if (work?.kind !== "work") return;
    expect(work.activities).toEqual([
      expect.objectContaining({ text: "search completed", count: 2 }),
      expect.objectContaining({
        text: "tool failed",
        needsAttention: true,
      }),
    ]);
    expect(work.needsAttention).toBe(true);
  });

  it("does not label the latest live assistant update as a final summary", () => {
    const transcript = buildChatTranscript({
      running: true,
      history: [],
      live: [
        { role: "user", text: "Investigate" },
        { role: "assistant", text: "I am still checking the runner." },
      ],
    });

    expect(transcript.at(-1)).toMatchObject({
      kind: "message",
      role: "assistant",
      text: "I am still checking the runner.",
      live: true,
      finalSummary: false,
    });
  });

  it("keeps intentional identical assistant messages within one turn", () => {
    const transcript = buildChatTranscript({
      running: false,
      live: [],
      history: [
        { role: "user", text: "Repeat the result", seq: 1 },
        { role: "assistant", text: "Same result.", seq: 2 },
        { role: "assistant", text: "Same result.", seq: 3 },
      ],
    });

    expect(transcript).toEqual([
      expect.objectContaining({ kind: "message", role: "user" }),
      expect.objectContaining({
        kind: "work",
        phaseNotes: ["Same result."],
      }),
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        text: "Same result.",
      }),
    ]);
  });
});
