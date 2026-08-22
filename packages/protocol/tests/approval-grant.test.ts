import { describe, expect, it } from "vitest";
import {
  APPROVAL_GRANT_DURATIONS,
  APPROVAL_GRANT_DURATION_TTL_MS,
  APPROVAL_GRANT_HORIZON_MS,
  DURABLE_APPROVAL_GRANT_DURATIONS,
  GRANTABLE_APPROVAL_KINDS,
  RECEIPT_ALLOWED_CLASSES,
  ALWAYS_ASK_ACTION_CLASSES,
  approvalGrantDurationSchema,
  approvalGrantIsLive,
  isDurableApprovalGrantDuration,
  isGrantableApprovalKind,
} from "../src/index.js";

// ── ADR-0056: the graded-grant vocabulary ────────────────────────────────────
//
// These are fail-closed PROPERTIES, not shape assertions: every one of them is
// a way the durable grade could quietly widen. The two that matter most are the
// positively-stated sets (a tier derived by subtraction reclassifies whatever is
// added next) and the read-side horizon (a hand-edited expiry must not buy an
// un-revocable grant).

describe("the three grades", () => {
  it("names all three, with `once` first and present", () => {
    expect(APPROVAL_GRANT_DURATIONS).toEqual(["once", "session", "always"]);
    expect(approvalGrantDurationSchema.parse("once")).toBe("once");
    expect(approvalGrantDurationSchema.safeParse("forever").success).toBe(false);
    expect(approvalGrantDurationSchema.safeParse("").success).toBe(false);
  });

  it("states the durable set POSITIVELY, never as the full set minus `once`", () => {
    expect(DURABLE_APPROVAL_GRANT_DURATIONS).toEqual(["session", "always"]);
    expect(isDurableApprovalGrantDuration("once")).toBe(false);
    expect(isDurableApprovalGrantDuration("session")).toBe(true);
    expect(isDurableApprovalGrantDuration("always")).toBe(true);
    // The property the literal array exists for: a grade added to the full list
    // is NOT durable until someone adds it here deliberately.
    for (const duration of DURABLE_APPROVAL_GRANT_DURATIONS) {
      expect(APPROVAL_GRANT_DURATIONS).toContain(duration);
    }
  });

  it("`once` has no TTL because it mints nothing", () => {
    expect(Object.keys(APPROVAL_GRANT_DURATION_TTL_MS).sort()).toEqual([
      "always",
      "session",
    ]);
  });

  it("never mints past the horizon a reader will believe", () => {
    for (const ttl of Object.values(APPROVAL_GRANT_DURATION_TTL_MS)) {
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThan(APPROVAL_GRANT_HORIZON_MS);
    }
    // `session` can never buy more run-scoped time than the shipped raw dial.
    expect(APPROVAL_GRANT_DURATION_TTL_MS.session).toBeLessThanOrEqual(
      3_600_000
    );
    expect(APPROVAL_GRANT_DURATION_TTL_MS.always).toBeGreaterThan(
      APPROVAL_GRANT_DURATION_TTL_MS.session
    );
  });
});

describe("what a grant may cover", () => {
  it("allow-lists the approval kinds instead of excluding merge", () => {
    expect(GRANTABLE_APPROVAL_KINDS).toEqual(["command"]);
    expect(isGrantableApprovalKind("command")).toBe(true);
    for (const kind of ["merge", "deploy", "dangerous_action", "gate"]) {
      expect(isGrantableApprovalKind(kind)).toBe(false);
    }
    // A kind invented tomorrow is human-decided by default.
    expect(isGrantableApprovalKind("teleport")).toBe(false);
  });

  it("shares the receipt class fence — never an always-ask class", () => {
    for (const forbidden of ALWAYS_ASK_ACTION_CLASSES) {
      expect(RECEIPT_ALLOWED_CLASSES as readonly string[]).not.toContain(
        forbidden
      );
    }
  });
});

describe("approvalGrantIsLive", () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z");
  const inAnHour = new Date(now + 3_600_000).toISOString();

  it("affirms only a live, un-revoked, in-horizon grant", () => {
    expect(approvalGrantIsLive({ expiresAt: inAnHour }, now)).toBe(true);
    expect(
      approvalGrantIsLive({ expiresAt: new Date(now + 3_600_000) }, now)
    ).toBe(true);
  });

  it("treats absence, revocation, a lapse and a malformed instant alike", () => {
    expect(approvalGrantIsLive(undefined, now)).toBe(false);
    expect(approvalGrantIsLive(null, now)).toBe(false);
    expect(
      approvalGrantIsLive(
        { expiresAt: inAnHour, revokedAt: new Date(now).toISOString() },
        now
      )
    ).toBe(false);
    expect(
      approvalGrantIsLive({ expiresAt: new Date(now - 1).toISOString() }, now)
    ).toBe(false);
    expect(approvalGrantIsLive({ expiresAt: "not-a-date" }, now)).toBe(false);
  });

  it("refuses an expiry no legitimate issuer could have minted", () => {
    const forged = new Date(now + APPROVAL_GRANT_HORIZON_MS + 1).toISOString();
    expect(approvalGrantIsLive({ expiresAt: forged }, now)).toBe(false);
    const atCeiling = new Date(now + APPROVAL_GRANT_HORIZON_MS).toISOString();
    expect(approvalGrantIsLive({ expiresAt: atCeiling }, now)).toBe(true);
  });
});
