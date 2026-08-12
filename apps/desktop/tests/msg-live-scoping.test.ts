// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../src/renderer/chat.js";

// E1 — `.msg-live` (the rise-up entrance) is scoped to ONLY the live/streaming
// map in chat.tsx. If it ever leaked onto the persisted `history.messages`
// map, switching chats (ChatView is keyed per-chat, so it remounts fresh)
// would replay the ENTIRE chat backlog with a rise-up every time — the exact
// failure mode this test pins against.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockMuonStreams() {
  Object.assign(window, {
    muon: {
      streams: vi.fn().mockResolvedValue([
        {
          seq: 1,
          kind: "user.message",
          laneId: "muon-chat",
          content: "[you] fix the parser",
        },
        { seq: 2, kind: "agent", content: "Working on it now." },
      ]),
    },
  });
}

describe("chat.tsx .msg-live scoping (E1)", () => {
  it("applies .msg-live to the LIVE entry but never to a persisted history message", async () => {
    mockMuonStreams();
    render(
      React.createElement(ChatView, {
        chat: { id: "chat-1", title: "Repair parser", workspacePath: "/tmp/muon" },
        approvals: [],
        running: false,
        live: [{ role: "status", text: "Codex is implementing the fix." }],
        onSend: vi.fn(),
        onResolveApproval: vi.fn(),
        onLiveSettled: vi.fn(),
      })
    );

    // Wait for the persisted history to land (from the mocked streams poll).
    const historyText = await screen.findByText("Working on it now.");
    const historyMsg = historyText.closest(".msg");
    expect(historyMsg).toBeTruthy();
    expect(historyMsg!.classList.contains("msg-live")).toBe(false);
    expect(historyMsg!.classList.contains("assistant")).toBe(true);

    // The live status entry (passed via props.live) DOES carry .msg-live.
    const liveText = screen.getByText("Codex is implementing the fix.");
    const liveMsg = liveText.closest(".msg-live");
    expect(liveMsg).toBeTruthy();
    expect(liveMsg!.classList.contains("msg-live")).toBe(true);
    expect(liveMsg!.classList.contains("transcript-work")).toBe(true);
  });

  it("never applies .msg-live anywhere when there is no live entry (idle chat)", async () => {
    mockMuonStreams();
    render(
      React.createElement(ChatView, {
        chat: { id: "chat-2", title: "Docs pass", workspacePath: "/tmp/muon" },
        approvals: [],
        running: false,
        live: [],
        onSend: vi.fn(),
        onResolveApproval: vi.fn(),
        onLiveSettled: vi.fn(),
      })
    );

    await waitFor(() => {
      expect(screen.getByText("Working on it now.")).toBeTruthy();
    });
    expect(document.querySelectorAll(".msg-live")).toHaveLength(0);
  });
});
