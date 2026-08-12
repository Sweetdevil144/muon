import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatTranscript } from "../src/renderer/chat-transcript.js";

describe("ChatTranscript", () => {
  it("renders a collapsed worked section, safe summaries, final markdown, and open-agent actions", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatTranscript, {
        running: false,
        history: [
          { role: "user", text: "Ship it", seq: 1 },
          {
            role: "status",
            text: "dispatch started\n{ \"secretPayload\": true }",
            seq: 2,
          },
          { role: "assistant", text: "**Shipped.**", seq: 3 },
          { role: "user", text: "Verify it", seq: 4 },
          { role: "status", text: "tests completed", seq: 5 },
          { role: "assistant", text: "**Verified.**", seq: 6 },
        ],
        live: [],
        subagents: [
          {
            jobId: "job-1",
            agentId: "agent-1",
            vendor: "codex",
            status: "running",
            pendingCloseAt: null,
            pinned: false,
          },
        ],
        onOpenSubagent: vi.fn(),
      })
    );

    expect(html).toContain("<details");
    expect(html).toContain("Worked for this turn");
    expect(html).toContain("Dispatched");
    // `dispatch started` is now ONE pending card, not a raw `X started` row.
    expect(html).toContain("tool-card tool-card-pending");
    expect(html).toContain('class="tool-card-title">dispatch<');
    // Settled turn, no completion ever arrived — it must not claim to be
    // running, and it must not claim to be done.
    expect(html).toContain("no result recorded");
    // Untrusted payload stays out of the DOM until the human expands the card.
    expect(html).not.toContain("secretPayload");
    expect(html).toContain("MUON · Summary");
    expect(html).toContain("<strong>Shipped.</strong>");
    expect(html).toContain("<strong>Verified.</strong>");
    expect(html).toContain('aria-label="Dispatched subagents"');
    expect(html.match(/aria-label="Dispatched subagents"/g)).toHaveLength(1);
    expect(html).toContain("Open Codex");
  });

  it("labels live assistant prose as MUON, not as a settled summary", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatTranscript, {
        running: true,
        history: [],
        live: [
          { role: "user", text: "Investigate" },
          { role: "assistant", text: "Still working." },
        ],
      })
    );

    expect(html).toContain(">MUON<");
    expect(html).not.toContain("MUON · Summary");
  });

  it("opens live work for observable progress and collapses it after settlement", () => {
    const liveHtml = renderToStaticMarkup(
      React.createElement(ChatTranscript, {
        running: true,
        history: [],
        live: [{ role: "status", text: "search started" }],
      })
    );
    const settledHtml = renderToStaticMarkup(
      React.createElement(ChatTranscript, {
        running: false,
        history: [{ role: "status", text: "search completed", seq: 1 }],
        live: [],
      })
    );

    expect(liveHtml).toMatch(/<details[^>]*open/);
    expect(settledHtml).toContain("<details");
    expect(settledHtml).not.toMatch(/<details[^>]*open/);
  });
});
