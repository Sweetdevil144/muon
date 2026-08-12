import { describe, expect, it } from "vitest";
import { appendLiveStatus } from "../src/lib/live-chat.js";
import { buildChatTranscript } from "../src/lib/chat-transcript.js";
import { buildToolCards } from "../src/renderer/lib/tool-cards.js";

/**
 * U4 — MUON's own MCP tool calls rendered as bare coordinates
 * (`mcp__muon__dispatch_status started` / `completed`) with no arguments and no
 * result, while Claude's and Codex's vendor tool cards showed both.
 *
 * The gap was never MCP-specific and it was never in the card renderer: a
 * SETTLED turn re-reads its chunks from the brain and gets `detail` from the
 * persisted column, but a LIVE turn was projected from a relayed activity LINE
 * only — the detail was dropped on the way to the renderer. So exactly while
 * the coordinator was working, the human could not see what it asked or got.
 *
 * These pin the desktop half end to end: a live status line that carries detail
 * reaches the card as "Called with" / "Returned", with truncation stated.
 */

function cardsFor(
  live: ReturnType<typeof appendLiveStatus>,
  running = true
) {
  const transcript = buildChatTranscript({
    history: [],
    live: [{ role: "user", text: "check the crew" }, ...live],
    running,
  });
  const work = transcript.find((item) => item.kind === "work");
  if (!work || work.kind !== "work") throw new Error("no work item projected");
  return buildToolCards(work.activities);
}

describe("live tool-call detail", () => {
  it("renders a live mcp__muon__* call's args and result, not bare coordinates", () => {
    let live = appendLiveStatus([], "mcp__muon__dispatch_status started", {
      args: '{"chatId":"chat-1"}',
    });
    live = appendLiveStatus(live, "mcp__muon__dispatch_status completed", {
      result: '{"jobs":[{"id":"job-1","status":"running"}]}',
    });

    const cards = cardsFor(live);
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.tool).toBe("mcp__muon__dispatch_status");
    // The MUON MCP family is titled by intent, with the wire name alongside.
    expect(card.title).toBe("Crew · dispatch_status");
    expect(card.args).toContain("chat-1");
    expect(card.output).toContain("job-1");
    expect(card.status).toBe("ok");
  });

  it("keeps the exact wire name so a friendly title never overstates the call", () => {
    const live = appendLiveStatus([], "mcp__muon__memory_search started", {
      args: '{"query":"retrieval"}',
    });
    const card = cardsFor(live)[0]!;
    expect(card.tool).toBe("mcp__muon__memory_search");
    expect(card.title).toBe("Shared memory · memory_search");
  });

  it("states truncation instead of implying the whole call is shown", () => {
    const live = appendLiveStatus([], "Bash started", {
      args: "npm test",
      argsTruncated: true,
    });
    const card = cardsFor(live)[0]!;
    expect(card.argsTruncated).toBe(true);
  });

  it("degrades to today's coordinates-only card when no detail was captured", () => {
    let live = appendLiveStatus([], "mcp__muon__dispatch_status started");
    live = appendLiveStatus(live, "mcp__muon__dispatch_status completed");
    const card = cardsFor(live)[0]!;
    expect(card.args).toBeUndefined();
    expect(card.output).toBeUndefined();
    // Still a real card — never a blank row.
    expect(card.title).toBe("Crew · dispatch_status");
  });

  it("never merges two calls that returned different results under one repeat", () => {
    let live = appendLiveStatus([], "mcp__muon__dispatch_status started", {
      args: "{}",
    });
    live = appendLiveStatus(live, "mcp__muon__dispatch_status completed", {
      result: "one running",
    });
    live = appendLiveStatus(live, "mcp__muon__dispatch_status started", {
      args: "{}",
    });
    live = appendLiveStatus(live, "mcp__muon__dispatch_status completed", {
      result: "two running",
    });

    const cards = cardsFor(live);
    expect(cards).toHaveLength(2);
    expect(cards[0]!.output).toContain("one running");
    expect(cards[1]!.output).toContain("two running");
  });

  it("carries no detail field at all when the emitter supplied none", () => {
    const entries = appendLiveStatus([], "Bash started");
    expect(entries[0]).not.toHaveProperty("detail");
  });
});
