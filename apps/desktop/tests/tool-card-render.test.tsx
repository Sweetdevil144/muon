// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ChatTranscript } from "../src/renderer/chat-transcript.js";
import { ToolCardList } from "../src/renderer/chat-activity.js";
import { buildToolCards } from "../src/renderer/lib/tool-cards.js";
import type { ChatMessage } from "../src/lib/chat-history.js";

afterEach(cleanup);

function status(text: string, seq: number): ChatMessage {
  return { role: "status", text, seq };
}

describe("ToolCardList", () => {
  it("renders one card per tool call with its intent title and wire name", () => {
    render(
      <ToolCardList
        cards={buildToolCards([
          { text: "mcp__muon__code_query started", count: 1 },
          { text: "mcp__muon__code_query completed", count: 1 },
        ])}
      />
    );

    const list = screen.getByRole("list", {
      name: "Tool and execution activity",
    });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Code graph · code_query")).toBeTruthy();
    expect(screen.getByText("mcp__muon__code_query")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
  });

  it("shows a repeat count instead of N rows", () => {
    const activities = [];
    for (let index = 0; index < 197; index += 1) {
      activities.push({ text: "ToolSearch started", count: 1 });
      activities.push({ text: "ToolSearch completed", count: 1 });
    }
    render(<ToolCardList cards={buildToolCards(activities)} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByLabelText("repeated 197 times")).toBeTruthy();
  });

  it("mounts the untrusted result only after the human expands the card", async () => {
    const user = userEvent.setup();
    render(
      <ToolCardList
        cards={buildToolCards([{ text: "Read started", count: 1 }], {
          rawByLine: new Map([["Read started", "Read started\nSECRET-PAYLOAD"]]),
        })}
      />
    );

    expect(screen.queryByText(/SECRET-PAYLOAD/)).toBeNull();
    const toggle = screen.getByRole("button");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await user.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/SECRET-PAYLOAD/)).toBeTruthy();
    // Bounded + scrollable container, never the page.
    expect(document.querySelector(".tool-card-output")).toBeTruthy();

    await user.click(toggle);
    expect(screen.queryByText(/SECRET-PAYLOAD/)).toBeNull();
  });

  it("spins while a call is in flight and never lies once the turn settles", () => {
    const live = renderToStaticMarkup(
      <ToolCardList
        cards={buildToolCards([{ text: "Bash started", count: 1, live: true }])}
        turnLive
      />
    );
    expect(live).toContain("tool-card-spinner");
    expect(live).toContain("running");

    const settled = renderToStaticMarkup(
      <ToolCardList cards={buildToolCards([{ text: "Bash started", count: 1 }])} />
    );
    expect(settled).not.toContain("tool-card-spinner");
    expect(settled).toContain("no result recorded");
    expect(settled).toContain("tool-card-stalled");
  });

  it("opens a denial by default and names the governance that refused it", () => {
    render(
      <ToolCardList
        cards={buildToolCards([
          { text: "Write started", count: 1 },
          {
            text: "[task.blocked] MUON policy denied: /etc/hosts is outside the task radius",
            count: 1,
            needsAttention: true,
          },
          { text: "Write denied", count: 1, needsAttention: true },
        ])}
      />
    );

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("denied by MUON governance")).toBeTruthy();
    expect(
      within(alert).getByText(/outside the task radius/)
    ).toBeTruthy();
    expect(alert.className).toContain("tool-card-denied");
  });

  it("renders a failure as its own alert card, not a generic step", () => {
    render(
      <ToolCardList
        cards={buildToolCards([
          {
            text: "[contract.failed] Coordinator dispatch contract failed: no admitted child jobs.",
            count: 1,
            needsAttention: true,
          },
        ])}
      />
    );

    const alert = screen.getByRole("alert");
    expect(alert.className).toContain("tool-card-failed");
    expect(within(alert).getByText("Dispatch contract failed")).toBeTruthy();
    expect(within(alert).getByText(/no admitted child jobs/)).toBeTruthy();
  });
});

describe("ChatTranscript work section", () => {
  it("collapses a 198-line turn into a handful of cards with the failure surfaced", () => {
    const history: ChatMessage[] = [{ role: "user", text: "Ship it", seq: 0 }];
    let seq = 1;
    for (let index = 0; index < 98; index += 1) {
      history.push(status("ToolSearch started", seq));
      seq += 1;
      history.push(status("ToolSearch completed", seq));
      seq += 1;
    }
    history.push(
      status(
        "[contract.failed] Coordinator dispatch contract failed: no admitted child jobs.",
        seq
      )
    );

    render(<ChatTranscript history={history} live={[]} running={false} />);

    const cards = screen.getAllByRole("listitem");
    expect(cards.length).toBeLessThanOrEqual(3);
    // The turn header itself carries the failure count, so a collapsed turn
    // can never hide it.
    expect(screen.getByLabelText("Needs attention: 1 failed")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Dispatch contract failed")).toBeTruthy();
  });

  it("auto-opens a turn that contains a failure", () => {
    const html = renderToStaticMarkup(
      <ChatTranscript
        history={[
          { role: "user", text: "Ship it", seq: 0 },
          status("Bash started", 1),
          status("Bash failed", 2),
        ]}
        live={[]}
        running={false}
      />
    );

    expect(html).toMatch(/<details[^>]*open/);
    expect(html).toContain("1 failed");
  });

  it("does not use dangerouslySetInnerHTML anywhere on the card path", () => {
    const html = renderToStaticMarkup(
      <ToolCardList
        cards={buildToolCards([
          {
            text: "[task.blocked] MUON policy denied: <img src=x onerror=alert(1)>",
            count: 1,
            needsAttention: true,
          },
        ])}
      />
    );

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("shows args and result in bounded, independently scrollable boxes", async () => {
    const user = userEvent.setup();
    render(
      <ToolCardList
        cards={buildToolCards([
          {
            text: "Bash started",
            count: 1,
            detail: { args: "command: npm test" },
          },
          {
            text: "Bash completed",
            count: 1,
            detail: { result: "PASS 12 tests", resultTruncated: true },
          },
        ])}
      />
    );

    // Untrusted output is NOT in the DOM until the human asks for it.
    expect(screen.queryByText("PASS 12 tests")).toBeNull();

    await user.click(screen.getByRole("button"));

    expect(screen.getByText("Tool activity · untrusted")).toBeTruthy();
    expect(screen.getByText("Called with")).toBeTruthy();
    expect(screen.getByText("Returned")).toBeTruthy();
    expect(screen.getByText("PASS 12 tests")).toBeTruthy();
    // Truncation is stated, never implied away.
    expect(
      screen.getByText("Earlier output dropped; MUON kept the end.")
    ).toBeTruthy();
    // Each value scrolls inside its OWN bounded box, never on the page.
    const boxes = document.querySelectorAll(".tool-card-output");
    expect(boxes.length).toBe(2);
    expect(document.querySelector(".tool-card-args-box")).toBeTruthy();
  });

  it("renders a credential-shaped result as inert text, never as markup", () => {
    const html = renderToStaticMarkup(
      <ToolCardList
        cards={buildToolCards([
          {
            text: "Bash failed",
            count: 1,
            needsAttention: true,
            detail: {
              args: "command: <img src=x onerror=alert(1)>",
              result: "MUON_API_TOKEN=[redacted]\n<script>alert(1)</script>",
            },
          },
        ])}
      />
    );

    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("[redacted]");
  });

  it("survives an old persisted chat whose statuses have no lifecycle shape", () => {
    render(
      <ChatTranscript
        history={[
          { role: "user", text: "Old chat", seq: 0 },
          status("Codex capability preflight completed", 1),
          status("some legacy ledger prose", 2),
          { role: "assistant", text: "Done.", seq: 3 },
        ]}
        live={[]}
        running={false}
      />
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("some legacy ledger prose")).toBeTruthy();
  });
});
