import { describe, expect, it } from "vitest";
import {
  firstTaskApprovalId,
  shouldShowOnboarding,
} from "../src/renderer/onboarding-visibility.js";

describe("desktop onboarding visibility", () => {
  const readyFirstRun = {
    stateReady: true,
    online: true,
    firstTaskRunning: true,
    chatCount: 1,
    readinessKnown: true,
    anyVendorReady: true,
    pendingApprovalCount: 0,
    dismissed: false,
  };

  it("keeps onboarding visible while the first task runs normally", () => {
    expect(shouldShowOnboarding(readyFirstRun)).toBe(true);
  });

  it("NEVER re-shows once dismissed — the mission takes over immediately", () => {
    // The user clicked "Run your first task": no second doctor panel, even
    // while the task runs and even with no chat yet.
    expect(
      shouldShowOnboarding({ ...readyFirstRun, dismissed: true, chatCount: 0 })
    ).toBe(false);
  });

  it("yields to the cockpit when the first task needs a human decision", () => {
    expect(
      shouldShowOnboarding({
        ...readyFirstRun,
        pendingApprovalCount: 1,
      })
    ).toBe(false);
  });

  it("focuses only a pending first-task approval", () => {
    expect(firstTaskApprovalId(true, [{ id: "approval-1" }])).toBe(
      "approval-1"
    );
    expect(firstTaskApprovalId(false, [{ id: "approval-1" }])).toBeNull();
    expect(firstTaskApprovalId(true, [])).toBeNull();
  });
});
