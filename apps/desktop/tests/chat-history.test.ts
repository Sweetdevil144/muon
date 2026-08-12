import { describe, expect, it } from "vitest";
import {
  chunkToMessage,
  emptyHistory,
  reduceChunks,
  USER_PREFIX,
} from "../src/lib/chat-history.js";

describe("chunkToMessage", () => {
  it("parses operator-authored user.message chunks on muon-chat as user messages", () => {
    const message = chunkToMessage({
      seq: 1,
      kind: "user.message",
      laneId: "muon-chat",
      content: `${USER_PREFIX}fix the login bug`,
    });
    expect(message).toEqual({ role: "user", text: "fix the login bug", seq: 1 });
  });

  it("maps output chunks to assistant messages", () => {
    expect(
      chunkToMessage({ seq: 2, kind: "output", content: "On it." })
    ).toEqual({ role: "assistant", text: "On it.", seq: 2 });
  });

  it("maps non-user milestones and gates to status messages", () => {
    expect(
      chunkToMessage({ seq: 3, kind: "milestone", content: "task created" })
    ).toMatchObject({ role: "status" });
    expect(
      chunkToMessage({ seq: 4, kind: "gate", content: "ship gate filed" })
    ).toMatchObject({ role: "status" });
  });

  it("drops blank chunks", () => {
    expect(chunkToMessage({ seq: 5, kind: "output", content: "   " })).toBeNull();
  });

  it("does not let model output spoof a human turn with a text prefix", () => {
    expect(
      chunkToMessage({ seq: 6, kind: "output", content: `${USER_PREFIX}hello` })
    ).toMatchObject({ role: "assistant", text: `${USER_PREFIX}hello` });
  });

  it("does not trust user.message outside the governed chat lane", () => {
    expect(
      chunkToMessage({
        seq: 7,
        kind: "user.message",
        laneId: "worker",
        content: `${USER_PREFIX}hello`,
      })
    ).toMatchObject({ role: "assistant", text: `${USER_PREFIX}hello` });
  });
});

describe("reduceChunks", () => {
  const chunks = [
    {
      seq: 1,
      kind: "user.message",
      laneId: "muon-chat",
      content: `${USER_PREFIX}build the feature`,
    },
    { seq: 2, kind: "output", content: "Planning tasks." },
    { seq: 3, kind: "output", content: "Dispatched claude-1." },
    { seq: 4, kind: "milestone", content: "⛔ gate waiting" },
  ];

  it("maps chunks to messages, merging consecutive assistant chunks", () => {
    const history = reduceChunks(emptyHistory(), chunks);
    expect(history.lastSeq).toBe(4);
    expect(history.messages).toEqual([
      { role: "user", text: "build the feature", seq: 1 },
      {
        role: "assistant",
        text: "Planning tasks.Dispatched claude-1.",
        seq: 3,
      },
      { role: "status", text: "⛔ gate waiting", seq: 4 },
    ]);
  });

  it("concatenates stream tokens without inserting blank lines", () => {
    const history = reduceChunks(emptyHistory(), [
      { seq: 1, kind: "output", content: "I" },
      { seq: 2, kind: "output", content: "'ll" },
      { seq: 3, kind: "output", content: " reconcile" },
    ]);
    expect(history.messages).toEqual([
      { role: "assistant", text: "I'll reconcile", seq: 3 },
    ]);
  });

  it("preserves explicit whole-message boundaries", () => {
    const history = reduceChunks(emptyHistory(), [
      { seq: 1, kind: "output.message", content: "First update." },
      { seq: 2, kind: "output.message", content: "Next update." },
    ]);
    expect(history.messages).toEqual([
      {
        role: "assistant",
        text: "First update.\n\nNext update.",
        seq: 2,
      },
    ]);
  });

  it("renders typed activity separately from assistant output", () => {
    const history = reduceChunks(emptyHistory(), [
      { seq: 1, kind: "activity", content: "Read started" },
      { seq: 2, kind: "output", content: "I inspected the file." },
    ]);
    expect(history.messages).toEqual([
      { role: "status", text: "Read started", seq: 1 },
      { role: "assistant", text: "I inspected the file.", seq: 2 },
    ]);
  });

  it("keeps legacy Codex preflight output separate from model deltas", () => {
    const history = reduceChunks(emptyHistory(), [
      {
        seq: 1,
        kind: "output",
        content: "Codex capability preflight completed",
      },
      { seq: 2, kind: "output", content: "next:" },
      { seq: 3, kind: "output", content: " dispatching the crew" },
    ]);
    expect(history.messages).toEqual([
      {
        role: "status",
        text: "Codex capability preflight completed",
        seq: 1,
      },
      {
        role: "assistant",
        text: "next: dispatching the crew",
        seq: 3,
      },
    ]);
  });

  it("is idempotent: re-feeding chunks at or below the cursor changes nothing", () => {
    const once = reduceChunks(emptyHistory(), chunks);
    const twice = reduceChunks(once, chunks);
    expect(twice).toBe(once);
  });

  it("appends only chunks after the cursor and sorts out-of-order pages", () => {
    const first = reduceChunks(emptyHistory(), chunks.slice(0, 2));
    const next = reduceChunks(first, [
      { seq: 6, kind: "output", content: "done" },
      {
        seq: 5,
        kind: "user.message",
        laneId: "muon-chat",
        content: `${USER_PREFIX}status?`,
      },
      // stale duplicate below the cursor
      { seq: 2, kind: "output", content: "Planning tasks." },
    ]);
    expect(next.lastSeq).toBe(6);
    expect(next.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(next.messages[2]).toMatchObject({ text: "status?", seq: 5 });
  });

  it("does not merge assistant chunks across a user turn", () => {
    const history = reduceChunks(emptyHistory(), [
      { seq: 1, kind: "output", content: "first reply" },
      {
        seq: 2,
        kind: "user.message",
        laneId: "muon-chat",
        content: `${USER_PREFIX}next question`,
      },
      { seq: 3, kind: "output", content: "second reply" },
    ]);
    expect(history.messages).toHaveLength(3);
  });
});
