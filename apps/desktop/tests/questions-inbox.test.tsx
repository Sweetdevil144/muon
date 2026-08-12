// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(cleanup);
import { QuestionsInbox } from "../src/renderer/questions-inbox.js";
import type { BlockingQuestion } from "@muon/client";

/**
 * ADR-0043's operator half on the desk (surface-parity audit item 1): agents
 * file blocking questions; before this panel only the CLI could see or answer
 * them. Properties under proof:
 *   1. untrusted agent text renders as TEXT (React escaping — pinned so a
 *      refactor to dangerouslySetInnerHTML fails loudly);
 *   2. the answer goes through the IPC with the QUESTION'S OWN taskId;
 *   3. a stale answer (question closed elsewhere) reports, never silently.
 */

function question(overrides: Partial<BlockingQuestion> = {}): BlockingQuestion {
  return {
    id: "q-1",
    taskId: "task-1",
    jobId: "job-1",
    askedByVendor: "codex",
    askedByRole: "implementer",
    subject: "Which retry policy?",
    body: "Fixed or exponential backoff — blocked until decided.",
    status: "open",
    askedAt: "2026-08-11T00:00:00.000Z",
    ...overrides,
  } as BlockingQuestion;
}

describe("QuestionsInbox", () => {
  it("renders nothing at all with an empty inbox — no dead chrome", () => {
    const { container } = render(
      <QuestionsInbox
        questions={[]}
        activeTaskIds={new Set()}
        onAnswer={vi.fn()}
      />
    );
    expect(container.innerHTML).toBe("");
  });

  it("agent markup arrives as text, never as elements", () => {
    render(
      <QuestionsInbox
        questions={[
          question({
            subject: "<img src=x onerror=alert(1)> policy?",
            body: "<script>alert(2)</script> body",
          }),
        ]}
        activeTaskIds={new Set(["task-1"])}
        onAnswer={vi.fn()}
      />
    );
    // The literal markup is VISIBLE (escaped), and no such element exists.
    expect(
      screen.getByText(/<img src=x onerror=alert\(1\)> policy\?/)
    ).toBeTruthy();
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
  });

  it("answers through the IPC with the question's own taskId", async () => {
    const onAnswer = vi.fn().mockResolvedValue({ answered: true });
    render(
      <QuestionsInbox
        questions={[question()]}
        activeTaskIds={new Set(["task-1"])}
        onAnswer={onAnswer}
      />
    );
    fireEvent.change(screen.getByPlaceholderText(/your decision/i), {
      target: { value: "Exponential, capped at 30s." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(onAnswer).toHaveBeenCalledWith({
      questionId: "q-1",
      taskId: "task-1",
      answer: "Exponential, capped at 30s.",
    });
  });

  it("a question closed elsewhere reports instead of silently succeeding", async () => {
    const onAnswer = vi.fn().mockResolvedValue({ answered: false });
    render(
      <QuestionsInbox
        questions={[question()]}
        activeTaskIds={new Set(["task-1"])}
        onAnswer={onAnswer}
      />
    );
    fireEvent.change(screen.getByPlaceholderText(/your decision/i), {
      target: { value: "too late" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(
      await screen.findByText(/no longer open/i)
    ).toBeTruthy();
  });

  it("the empty answer cannot be sent", () => {
    render(
      <QuestionsInbox
        questions={[question()]}
        activeTaskIds={new Set()}
        onAnswer={vi.fn()}
      />
    );
    const button = screen.getByRole("button", { name: "Answer" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
