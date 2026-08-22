import { describe, expect, it } from "vitest";
import { fingerprintPolicyProfile } from "../src/lib/policy-profile.js";

// ── ADR-0056: the posture binding a durable grant is minted under ────────────
//
// Pure unit coverage of the hash itself; `tests/approval-grants.test.ts` proves
// the ROUTE behaviour (a policy edit invalidates a live grant, and removing the
// edit restores it) against the real ledger. Lives in the backend rather than
// in @muon/protocol for the same reason `fingerprintManifest` does: the
// protocol root is browser-safe, and only the server ever computes this.

describe("fingerprintPolicyProfile", () => {
  it("is key-order independent and 128 bits", () => {
    const left = fingerprintPolicyProfile({ a: 1, b: { c: 2, d: 3 } });
    const right = fingerprintPolicyProfile({ b: { d: 3, c: 2 }, a: 1 });
    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{32}$/);
  });

  it("gives 'no profile' its own stable fingerprint", () => {
    expect(fingerprintPolicyProfile(null)).toBe(
      fingerprintPolicyProfile(undefined)
    );
    expect(fingerprintPolicyProfile(null)).toMatch(/^[a-f0-9]{32}$/);
    // Adding a FIRST profile must invalidate as loudly as editing one, so the
    // "no policy" posture cannot collide with any real profile.
    expect(fingerprintPolicyProfile(null)).not.toBe(
      fingerprintPolicyProfile({ version: 1 })
    );
    expect(fingerprintPolicyProfile(null)).not.toBe(
      fingerprintPolicyProfile({})
    );
  });

  it("changes when any posture changes", () => {
    expect(
      fingerprintPolicyProfile({ version: 1, postures: { edit: "gate" } })
    ).not.toBe(
      fingerprintPolicyProfile({ version: 1, postures: { edit: "deny" } })
    );
  });

  it("distinguishes a task-scoped override from the workspace row it shadows", () => {
    // The route folds the scope label in, so a task row that happens to be
    // byte-identical to the workspace row is still a different posture.
    const profile = { version: 1, label: "default" };
    expect(fingerprintPolicyProfile({ scope: "task", profile })).not.toBe(
      fingerprintPolicyProfile({ scope: "workspace", profile })
    );
  });
});
