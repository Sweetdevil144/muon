import { describe, expect, it } from "vitest";
import {
  buildCrewAskEscalation,
  clampWaitTimeout,
  conditionSatisfied,
  describeCrewAsk,
  MAX_PEER_WAIT_MS,
  MIN_PEER_WAIT_MS,
  PEER_WAIT_BUDGET_MARGIN_MS,
  peerWaitConditionSchema,
  peerWaitRequestSchema,
} from "../src/peer-wait.js";

// ADR-0034. The governance-bearing assertions are the clamp ones: a wait that
// outlives its waiter turns a coordination feature into a budget leak, and
// unbounded waits compose into deadlock.

describe("ADR-0034 D2 — a wait cannot outlive its waiter", () => {
  it("clamps to the ceiling when the caller asks for more", () => {
    const clamp = clampWaitTimeout(MAX_PEER_WAIT_MS * 10, null);
    expect(clamp.timeoutMs).toBe(MAX_PEER_WAIT_MS);
    expect(clamp.clamped).toBe(true);
    expect(clamp.reason).toBe("ceiling");
  });

  it("clamps to the remaining budget, keeping a margin to act on the answer", () => {
    // A wait that consumes the last millisecond of a budget bought nothing.
    const remaining = 45_000;
    const clamp = clampWaitTimeout(MAX_PEER_WAIT_MS, remaining);
    expect(clamp.timeoutMs).toBe(remaining - PEER_WAIT_BUDGET_MARGIN_MS);
    expect(clamp.reason).toBe("budget");
  });

  it("lets the budget win over the ceiling, not the other way round", () => {
    const clamp = clampWaitTimeout(MAX_PEER_WAIT_MS, 40_000);
    expect(clamp.timeoutMs).toBeLessThan(MAX_PEER_WAIT_MS);
    expect(clamp.reason).toBe("budget");
  });

  it("refuses to block at all when the budget leaves no room", () => {
    // Degrades to a single immediate check: "no" now beats "no" in a second.
    const clamp = clampWaitTimeout(60_000, PEER_WAIT_BUDGET_MARGIN_MS);
    expect(clamp.timeoutMs).toBe(0);
    expect(clamp.clamped).toBe(true);
  });

  it("refuses to block when the budget is already overspent", () => {
    const clamp = clampWaitTimeout(60_000, 0);
    expect(clamp.timeoutMs).toBe(0);
    expect(clamp.reason).toBe("budget");
  });

  it("honours a smaller request without calling it clamped", () => {
    const clamp = clampWaitTimeout(5_000, 600_000);
    expect(clamp.timeoutMs).toBe(5_000);
    expect(clamp.clamped).toBe(false);
    expect(clamp.reason).toBeUndefined();
  });

  it("still bounds a caller whose remaining budget is unknown", () => {
    // Unknown budget must not mean unbounded wait.
    for (const unknown of [null, undefined, Number.NaN, Infinity]) {
      const clamp = clampWaitTimeout(undefined, unknown as number | null);
      expect(clamp.timeoutMs).toBeLessThanOrEqual(MAX_PEER_WAIT_MS);
      expect(clamp.timeoutMs).toBeGreaterThanOrEqual(MIN_PEER_WAIT_MS);
    }
  });
});

describe("ADR-0034 D3 — a wait resolves to facts, never text", () => {
  it("accepts only lifecycle states and reply-shaped inbox kinds", () => {
    expect(
      peerWaitConditionSchema.safeParse({
        kind: "peer_state",
        jobId: "job-1",
        states: ["blocked", "done"],
      }).success
    ).toBe(true);
    expect(
      peerWaitConditionSchema.safeParse({
        kind: "inbox_kind",
        messageKind: "answer",
      }).success
    ).toBe(true);
  });

  it("refuses to wait on chatter kinds — that is a busy-loop with extra steps", () => {
    for (const messageKind of ["status", "constraint", "question", "review_request"]) {
      expect(
        peerWaitConditionSchema.safeParse({ kind: "inbox_kind", messageKind })
          .success,
        messageKind
      ).toBe(false);
    }
  });

  it("bounds the request shape", () => {
    expect(
      peerWaitRequestSchema.safeParse({
        condition: { kind: "inbox_kind", messageKind: "answer" },
        timeoutMs: MAX_PEER_WAIT_MS * 2,
      }).success
    ).toBe(false);
    expect(
      peerWaitConditionSchema.safeParse({
        kind: "peer_state",
        jobId: "job-1",
        states: [],
      }).success
    ).toBe(false);
  });
});

describe("condition evaluation", () => {
  const peerCondition = {
    kind: "peer_state",
    jobId: "job-1",
    states: ["blocked", "done"],
  } as const;

  it("matches any listed state", () => {
    expect(conditionSatisfied(peerCondition, { state: "done" })).toBe(true);
    expect(conditionSatisfied(peerCondition, { state: "blocked" })).toBe(true);
  });

  it("does not match an unlisted or absent state", () => {
    expect(conditionSatisfied(peerCondition, { state: "working" })).toBe(false);
    expect(conditionSatisfied(peerCondition, {})).toBe(false);
  });

  it("matches an inbox condition only once something actually arrived", () => {
    const inbox = { kind: "inbox_kind", messageKind: "answer" } as const;
    expect(conditionSatisfied(inbox, { matchingUnread: 0 })).toBe(false);
    expect(conditionSatisfied(inbox, {})).toBe(false);
    expect(conditionSatisfied(inbox, { matchingUnread: 2 })).toBe(true);
  });
});

describe("ADR-0034 D5 — a timed-out ask escalates with the exchange", () => {
  it("records who was asked and for how long, and that nobody answered", () => {
    const escalation = buildCrewAskEscalation({
      askedJobIds: ["job-a", "job-b"],
      askedRoles: ["reviewer", "architect"],
      subject: "Which module owns session expiry?",
      waitedMs: 60_000,
    });
    expect(escalation.answered).toBe(false);
    expect(escalation.askedRoles).toEqual(["reviewer", "architect"]);
    expect(escalation.waitedMs).toBe(60_000);
  });

  it("tells the human the CREW could not resolve it, not that an agent is stuck", () => {
    // The point of the whole feature: a cheaper decision for the operator.
    const line = describeCrewAsk(
      buildCrewAskEscalation({
        askedJobIds: ["job-a"],
        askedRoles: ["reviewer"],
        subject: "Which module owns session expiry?",
        waitedMs: 60_000,
      })
    );
    expect(line).toMatch(/crew could not resolve/i);
    expect(line).toContain("reviewer");
    expect(line).toContain("60s");
    expect(line).toContain("Which module owns session expiry?");
  });

  it("falls back to a peer count when roles are unknown", () => {
    const line = describeCrewAsk(
      buildCrewAskEscalation({
        askedJobIds: ["job-a", "job-b"],
        askedRoles: [],
        subject: "s",
        waitedMs: 1_000,
      })
    );
    expect(line).toContain("2 peer(s)");
  });

  it("copies its inputs so a later mutation cannot rewrite an escalation", () => {
    const roles = ["reviewer"];
    const escalation = buildCrewAskEscalation({
      askedJobIds: ["job-a"],
      askedRoles: roles,
      subject: "s",
      waitedMs: 1,
    });
    roles.push("implementer");
    expect(escalation.askedRoles).toEqual(["reviewer"]);
  });
});
