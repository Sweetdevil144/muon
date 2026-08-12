import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { activitySummary, ChatActivity } from "../src/renderer/chat-activity.js";
import { ChatMarkdown } from "../src/renderer/chat-markdown.js";

describe("ChatMarkdown", () => {
  it("renders bold, lists, and fenced code from GFM", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMarkdown, {
        text: "**Ready.**\n\n- one\n\n```ts\nconst x = 1;\n```",
      })
    );
    expect(html).toContain("msg-markdown");
    expect(html).toContain("<strong>Ready.</strong>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<code");
    expect(html).toContain("const x = 1;");
  });

  it("keeps model-authored links inert and does not fetch images", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatMarkdown, {
        text: "[review](https://attacker.invalid/x) ![diagram](https://attacker.invalid/pixel.png)",
      })
    );
    expect(html).toContain("review");
    expect(html).toContain("[image omitted: diagram]");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("src=");
    expect(html).not.toContain("attacker.invalid");
  });
});

describe("ChatActivity", () => {
  it("keeps short status lines compact", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatActivity, {
        text: "[task.started] Codex session started",
      })
    );
    expect(html).toContain("msg-activity");
    expect(html).not.toContain("<details");
    expect(html).toContain("[task.started] Codex session started");
  });

  it("uses a collapsible details row for longer tool output", () => {
    const text = "Explored chat-history.ts\n1 search\n1 tool\nfull payload here";
    const html = renderToStaticMarkup(
      React.createElement(ChatActivity, { text, live: true })
    );
    expect(html).toContain("<details");
    expect(html).toContain("msg-live");
    expect(html).toContain(activitySummary(text));
    expect(html).toContain("full payload here");
  });

  it("opens attention-needed activity by default", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatActivity, {
        text: "blocked\nMissing environment variable: KEY",
        needsAttention: true,
      })
    );
    expect(html).toContain("needs-attention");
    expect(html).toMatch(/<details[^>]*open/);
  });
});
