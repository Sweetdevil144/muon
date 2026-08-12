import { describe, expect, it } from "vitest";
import {
  activateTab,
  activateTabByOrdinal,
  activeTab,
  closeTab,
  CHAT_TAB,
  cycleTab,
  DESK_TAB,
  deskTabId,
  initialDeskTabs,
  openTab,
  pruneTabState,
  type DeskTab,
} from "../src/lib/desk-tabs.js";

// ADR-0032 D2. The point of these tests is that switching is an index change:
// no transition below may drop or recreate a tab that was not the subject.

function streamTab(agentId: string): DeskTab {
  return {
    id: deskTabId("stream", agentId),
    kind: "stream",
    title: agentId,
    closable: true,
    subject: agentId,
  };
}

describe("initial state", () => {
  it("opens with chat and crew, chat active", () => {
    const state = initialDeskTabs();
    expect(state.tabs.map((t) => t.id)).toEqual(["chat", "desk"]);
    expect(state.activeId).toBe("chat");
  });

  it("keeps chat and crew as coexisting tabs, not a width ternary", () => {
    // The inventory found that widening past 150 columns REMOVED the
    // conversation. Both are permanent tabs now, at every width.
    const state = initialDeskTabs();
    expect(state.tabs).toContainEqual(CHAT_TAB);
    expect(state.tabs).toContainEqual(DESK_TAB);
  });
});

describe("opening", () => {
  it("appends a new tab and focuses it", () => {
    const state = openTab(initialDeskTabs(), streamTab("claude-1"));
    expect(state.tabs).toHaveLength(3);
    expect(state.activeId).toBe("stream:claude-1");
  });

  it("re-opening the same subject focuses the existing tab, never duplicates", () => {
    // This is what keeps a re-opened stream's scrollback and cursor intact.
    let state = openTab(initialDeskTabs(), streamTab("claude-1"));
    state = activateTab(state, "chat");
    const before = state.tabs;
    state = openTab(state, streamTab("claude-1"));
    expect(state.tabs).toHaveLength(3);
    expect(state.tabs).toBe(before); // identical list, not a rebuilt one
    expect(state.activeId).toBe("stream:claude-1");
  });

  it("distinguishes subjects of the same kind", () => {
    let state = openTab(initialDeskTabs(), streamTab("claude-1"));
    state = openTab(state, streamTab("codex-2"));
    expect(state.tabs.map((t) => t.id)).toEqual([
      "chat",
      "desk",
      "stream:claude-1",
      "stream:codex-2",
    ]);
  });
});

describe("closing", () => {
  it("refuses to close a permanent tab", () => {
    const state = initialDeskTabs();
    expect(closeTab(state, "chat")).toBe(state);
    expect(closeTab(state, "desk")).toBe(state);
  });

  it("activates the left neighbour when the active tab closes", () => {
    let state = openTab(initialDeskTabs(), streamTab("a"));
    state = openTab(state, streamTab("b"));
    expect(state.activeId).toBe("stream:b");
    state = closeTab(state, "stream:b");
    expect(state.activeId).toBe("stream:a");
  });

  it("leaves the active tab alone when a background tab closes", () => {
    let state = openTab(initialDeskTabs(), streamTab("a"));
    state = openTab(state, streamTab("b"));
    state = activateTab(state, "chat");
    state = closeTab(state, "stream:a");
    expect(state.activeId).toBe("chat");
    expect(state.tabs.map((t) => t.id)).toEqual(["chat", "desk", "stream:b"]);
  });

  it("is a no-op for an unknown id", () => {
    const state = initialDeskTabs();
    expect(closeTab(state, "stream:nope")).toBe(state);
  });
});

describe("switching", () => {
  it("activates by ordinal", () => {
    const state = openTab(initialDeskTabs(), streamTab("a"));
    expect(activateTabByOrdinal(state, 2).activeId).toBe("desk");
    expect(activateTabByOrdinal(state, 3).activeId).toBe("stream:a");
  });

  it("ignores an out-of-range ordinal instead of wrapping", () => {
    const state = initialDeskTabs();
    expect(activateTabByOrdinal(state, 9)).toBe(state);
    expect(activateTabByOrdinal(state, 0)).toBe(state);
  });

  it("cycles as a ring in both directions", () => {
    const state = openTab(initialDeskTabs(), streamTab("a"));
    expect(cycleTab(state, "next").activeId).toBe("chat"); // wrapped from last
    const atChat = activateTab(state, "chat");
    expect(cycleTab(atChat, "next").activeId).toBe("desk");
    expect(cycleTab(atChat, "prev").activeId).toBe("stream:a");
  });

  it("ignores activating a tab that does not exist", () => {
    const state = initialDeskTabs();
    expect(activateTab(state, "stream:ghost")).toBe(state);
  });

  it("always resolves an active tab, even from a stale snapshot", () => {
    const stale = { tabs: initialDeskTabs().tabs, activeId: "stream:gone" };
    expect(activeTab(stale).id).toBe("chat");
  });
});

describe("per-tab retained state", () => {
  it("survives a switch away and back", () => {
    // The module holds identity; this asserts the contract callers rely on —
    // nothing about switching touches the payload map.
    let state = openTab(initialDeskTabs(), streamTab("a"));
    const payloads = { "stream:a": { cursor: 42 } };
    state = activateTab(state, "chat");
    state = activateTab(state, "stream:a");
    expect(pruneTabState(state, payloads)["stream:a"]).toEqual({ cursor: 42 });
  });

  it("is pruned when its tab closes, so a long session cannot accumulate", () => {
    let state = openTab(initialDeskTabs(), streamTab("a"));
    state = openTab(state, streamTab("b"));
    const payloads = {
      "stream:a": { cursor: 1 },
      "stream:b": { cursor: 2 },
      chat: { cursor: 3 },
    };
    state = closeTab(state, "stream:a");
    expect(Object.keys(pruneTabState(state, payloads)).sort()).toEqual([
      "chat",
      "stream:b",
    ]);
  });
});
