import { describe, expect, it } from "vitest";
import {
  blockingQuestionAskSchema,
  deriveBlockingQuestions,
  openBlockingQuestions,
  MAX_ANSWER_CHARS,
  MAX_QUESTION_BODY_CHARS,
  QUESTION_ANSWERED_EVENT_KIND,
  QUESTION_BLOCKED_EVENT_KIND,
  QUESTION_WITHDRAWN_EVENT_KIND,
  type QuestionSpineEvent,
} from "../src/blocking-question.js";

function opened(
  id: string,
  overrides: Partial<QuestionSpineEvent> & {
    metadata?: Record<string, unknown>;
  } = {}
): QuestionSpineEvent {
  return {
    kind: QUESTION_BLOCKED_EVENT_KIND,
    taskId: "task-1",
    timestamp: "2026-08-07T10:00:00.000Z",
    ...overrides,
    metadata: {
      questionId: id,
      jobId: "job-1",
      role: "implementer",
      vendor: "claude-code",
      subject: "Which auth provider?",
      body: "The brief names none; the repo has stubs for two.",
      ...(overrides.metadata ?? {}),
    },
  };
}

describe("ADR-0043 — blocking-question derivation", () => {
  it("the ask schema is strict and identity-free — no lever fields exist", () => {
    expect(
      blockingQuestionAskSchema.safeParse({ subject: "s", body: "b" }).success
    ).toBe(true);
    // D4/D5: identity is server-derived and there is no deadline/priority
    // lever. Any such field must be REJECTED, not ignored.
    for (const extra of [
      { jobId: "job-x" },
      { taskId: "task-x" },
      { deadline: "2026-01-01" },
      { priority: "high" },
      { pauseJob: true },
    ]) {
      expect(
        blockingQuestionAskSchema.safeParse({
          subject: "s",
          body: "b",
          ...extra,
        }).success,
        JSON.stringify(extra)
      ).toBe(false);
    }
  });

  it("derives an open question from a blocked event", () => {
    const questions = deriveBlockingQuestions([opened("q-1")]);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      id: "q-1",
      status: "open",
      askedByRole: "implementer",
      subject: "Which auth provider?",
    });
  });

  it("an answer closes it; a second terminal event is ignored (first wins)", () => {
    const questions = deriveBlockingQuestions([
      opened("q-1"),
      {
        kind: QUESTION_ANSWERED_EVENT_KIND,
        principalKind: "human",
        taskId: "task-1",
        timestamp: "2026-08-07T10:05:00.000Z",
        metadata: { questionId: "q-1", answer: "Use the OAuth stub." },
      },
      {
        kind: QUESTION_ANSWERED_EVENT_KIND,
        principalKind: "human",
        taskId: "task-1",
        timestamp: "2026-08-07T10:06:00.000Z",
        metadata: { questionId: "q-1", answer: "No wait, the other one." },
      },
      {
        kind: QUESTION_WITHDRAWN_EVENT_KIND,
        taskId: "task-1",
        timestamp: "2026-08-07T10:07:00.000Z",
        metadata: { questionId: "q-1" },
      },
    ]);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      status: "answered",
      answer: "Use the OAuth stub.",
      answeredAt: "2026-08-07T10:05:00.000Z",
    });
  });

  it("an answer or withdrawal for an id nothing opened derives nothing", () => {
    expect(
      deriveBlockingQuestions([
        {
          kind: QUESTION_ANSWERED_EVENT_KIND,
          principalKind: "human",
          taskId: "task-1",
          timestamp: "2026-08-07T10:05:00.000Z",
          metadata: { questionId: "ghost", answer: "to nobody" },
        },
        {
          kind: QUESTION_WITHDRAWN_EVENT_KIND,
          taskId: "task-1",
          timestamp: "2026-08-07T10:06:00.000Z",
          metadata: { questionId: "ghost" },
        },
      ])
    ).toEqual([]);
  });

  it("a malformed blocked row derives NOTHING — a corrupt fact cannot half-exist", () => {
    const missingSubject = opened("q-bad", {
      metadata: { subject: undefined as unknown as string },
    });
    const overBound = opened("q-long", {
      metadata: { body: "x".repeat(MAX_QUESTION_BODY_CHARS + 1) },
    });
    expect(deriveBlockingQuestions([missingSubject, overBound])).toEqual([]);
  });

  it("a duplicate open for the same id is ignored — first row wins", () => {
    const questions = deriveBlockingQuestions([
      opened("q-1"),
      opened("q-1", { metadata: { subject: "rewritten subject" } }),
    ]);
    expect(questions).toHaveLength(1);
    expect(questions[0]!.subject).toBe("Which auth provider?");
  });

  it("withdrawal closes without an answer, and open filtering works", () => {
    const spine: QuestionSpineEvent[] = [
      opened("q-1"),
      opened("q-2", { metadata: { questionId: "q-2" } }),
      {
        kind: QUESTION_WITHDRAWN_EVENT_KIND,
        taskId: "task-1",
        timestamp: "2026-08-07T10:08:00.000Z",
        metadata: { questionId: "q-1" },
      },
    ];
    const all = deriveBlockingQuestions(spine);
    expect(all.find((q) => q.id === "q-1")).toMatchObject({
      status: "withdrawn",
    });
    expect(all.find((q) => q.id === "q-1")?.answer).toBeUndefined();
    expect(openBlockingQuestions(spine).map((q) => q.id)).toEqual(["q-2"]);
  });

  it("an over-long answer in a spine row is bounded on derivation", () => {
    const questions = deriveBlockingQuestions([
      opened("q-1"),
      {
        kind: QUESTION_ANSWERED_EVENT_KIND,
        principalKind: "human",
        taskId: "task-1",
        timestamp: "2026-08-07T10:05:00.000Z",
        metadata: { questionId: "q-1", answer: "y".repeat(MAX_ANSWER_CHARS + 500) },
      },
    ]);
    expect(questions[0]!.answer).toHaveLength(MAX_ANSWER_CHARS);
  });
});

describe("pass-7 hardening", () => {
  const ESC = String.fromCharCode(27);
  const NUL = String.fromCharCode(0);

  it("an answered row WITHOUT a human principal is ignored — the fold checks the actor", () => {
    const questions = deriveBlockingQuestions([
      opened("q-1"),
      {
        kind: QUESTION_ANSWERED_EVENT_KIND,
        taskId: "task-1",
        timestamp: "2026-08-08T10:05:00.000Z",
        principalKind: "agent",
        metadata: { questionId: "q-1", answer: "an agent answering itself" },
      },
      {
        kind: QUESTION_ANSWERED_EVENT_KIND,
        taskId: "task-1",
        timestamp: "2026-08-08T10:06:00.000Z",
        metadata: { questionId: "q-1", answer: "no principal at all" },
      },
    ]);
    expect(questions[0]).toMatchObject({ status: "open" });
    expect(questions[0]!.answer).toBeUndefined();
  });

  it("a verified human answer carries answeredBy as a derived fact", () => {
    const questions = deriveBlockingQuestions([
      opened("q-1"),
      {
        kind: QUESTION_ANSWERED_EVENT_KIND,
        taskId: "task-1",
        timestamp: "2026-08-08T10:05:00.000Z",
        principalKind: "human",
        metadata: { questionId: "q-1", answer: "yes, the OAuth stub" },
      },
    ]);
    expect(questions[0]).toMatchObject({
      status: "answered",
      answeredBy: "operator",
    });
  });

  it("a subject with ANY control character refuses — one row cannot forge another", () => {
    for (const subject of [
      "two\nrows",
      "tabbed\tsubject",
      `${ESC}[2J wiped`,
    ]) {
      expect(
        blockingQuestionAskSchema.safeParse({ subject, body: "b" }).success,
        JSON.stringify(subject)
      ).toBe(false);
    }
  });

  it("a body keeps newlines and tabs but nothing else", () => {
    expect(
      blockingQuestionAskSchema.safeParse({
        subject: "s",
        body: "line one\n\tline two",
      }).success
    ).toBe(true);
    for (const body of ["cr\rhere", `${ESC}[31m red`, `${NUL} null byte`]) {
      expect(
        blockingQuestionAskSchema.safeParse({ subject: "s", body }).success,
        JSON.stringify(body)
      ).toBe(false);
    }
  });
});
