import { describe, expect, it } from "vitest";
import {
  ATTEMPT_OUTCOMES,
  attemptOutcomeSchema,
  isAttemptOutcome,
  missionAttemptRecallFilter,
} from "../src/attempt-outcome.js";

describe("attemptOutcomeSchema", () => {
  it("accepts the four substrate outcomes", () => {
    for (const outcome of ATTEMPT_OUTCOMES) {
      expect(attemptOutcomeSchema.parse(outcome)).toBe(outcome);
    }
  });

  it("rejects unknown values", () => {
    expect(attemptOutcomeSchema.safeParse("failed").success).toBe(false);
  });
});

describe("isAttemptOutcome", () => {
  it("narrows known outcomes", () => {
    expect(isAttemptOutcome("worked")).toBe(true);
    expect(isAttemptOutcome(null)).toBe(false);
  });
});

describe("missionAttemptRecallFilter", () => {
  it("fixes attempt + chat scope for mission recall", () => {
    expect(
      missionAttemptRecallFilter({
        chatId: "chat-1",
        module: "src/a.ts",
        outcome: "abandoned",
      })
    ).toEqual({
      kind: "attempt",
      chatId: "chat-1",
      module: "src/a.ts",
      outcome: "abandoned",
    });
  });
});
