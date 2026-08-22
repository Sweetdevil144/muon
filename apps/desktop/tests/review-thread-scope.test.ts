import { describe, expect, it } from "vitest";
import { resolveReviewThreadTarget } from "../src/lib/review-thread-scope.js";

/**
 * H1 — the IPC-boundary fence for the review-thread verbs.
 *
 * The renderer is untrusted: prompt injection reaches it through repo files the
 * agents render, and "typed as string" is a claim about our code, not a fact
 * about what crossed the bridge. Both fields end up in an operator-tier request
 * PATH, so both are bounded here before anything is asked about them.
 */

describe("H1 — a review thread may only be the selected mission's", () => {
  it("admits the bound chat", () => {
    expect(
      resolveReviewThreadTarget(
        { targetKind: "chat", targetId: "chat-1" },
        "chat-1"
      )
    ).toEqual({
      kind: "chat",
      target: { targetKind: "chat", targetId: "chat-1" },
    });
  });

  it("admits a task, and hands it back for the caller's own authorization", () => {
    const scope = resolveReviewThreadTarget(
      { targetKind: "task", targetId: "task-1" },
      "chat-1"
    );
    expect(scope.kind).toBe("task");
    if (scope.kind !== "task") throw new Error("expected a task scope");
    // The task fence itself needs the client, so it stays at the call site —
    // this only guarantees the caller is HANDED a bounded id to authorize.
    expect(scope.taskId).toBe("task-1");
  });

  it("refuses another mission's chat thread", () => {
    expect(() =>
      resolveReviewThreadTarget(
        { targetKind: "chat", targetId: "chat-other" },
        "chat-1"
      )
    ).toThrow(/not the selected mission/i);
  });

  it("refuses any thread when no mission is selected", () => {
    expect(() =>
      resolveReviewThreadTarget({ targetKind: "chat", targetId: "chat-1" }, null)
    ).toThrow(/not the selected mission/i);
    expect(() =>
      resolveReviewThreadTarget({ targetKind: "task", targetId: "task-1" }, null)
    ).toThrow(/Select a mission/i);
  });

  it("refuses a kind MUON does not name — it is a URL PATH SEGMENT", () => {
    // `encodeURIComponent` guards the id at the client call site; the KIND had
    // no guard at all, and it sits in the same path with the operator token.
    for (const kind of [
      "../../api/chats",
      "task/../chat",
      "TASK",
      "",
      42,
      null,
      undefined,
      { targetKind: "task" },
    ]) {
      expect(() =>
        resolveReviewThreadTarget(
          { targetKind: kind, targetId: "chat-1" },
          "chat-1"
        )
      ).toThrow(/about a task or a chat/i);
    }
  });

  it("refuses an id that is not a record id", () => {
    for (const id of [
      "../../api/chats/chat-1",
      "chat 1",
      "chat/1",
      "chat%2F1",
      "",
      7,
      null,
    ]) {
      expect(() =>
        resolveReviewThreadTarget(
          { targetKind: "chat", targetId: id },
          "chat-1"
        )
      ).toThrow();
    }
  });
});
