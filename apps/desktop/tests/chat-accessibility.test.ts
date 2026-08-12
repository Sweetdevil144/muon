import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatView } from "../src/renderer/chat.js";

describe("desktop orchestrator chat accessibility", () => {
  it("announces conversation progress and describes the keyboard composer", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatView, {
        chat: {
          id: "chat-1",
          title: "Repair parser",
          workspacePath: "/tmp/muon",
        },
        approvals: [],
        running: true,
        live: [{ role: "status", text: "Codex is implementing the fix." }],
        onSend: vi.fn(),
        onResolveApproval: vi.fn(),
        onLiveSettled: vi.fn(),
      })
    );

    expect(html).toContain('role="log"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="Mission conversation log"');
    expect(html).toContain("Mission chat");
    expect(html).toContain('aria-label="Queue message"');
    expect(html).toContain('aria-label="Message to MUON"');
    expect(html).toContain("composer-toolbar");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-describedby="composer-hint"');
    expect(html).toContain('id="composer-hint"');
  });

  it("visually distinguishes a blocked activity event from neutral progress", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatView, {
        chat: {
          id: "chat-1",
          title: "Repair parser",
          workspacePath: "/tmp/muon",
        },
        approvals: [],
        running: false,
        live: [
          {
            role: "status",
            text: "Missing environment variable: AZURE_OPENAI_API_KEY.",
          },
        ],
        onSend: vi.fn(),
        onResolveApproval: vi.fn(),
        onLiveSettled: vi.fn(),
      })
    );

    expect(html).toContain("transcript-work");
    expect(html).toContain("msg-live");
    expect(html).toContain("needs-attention");
  });
});
