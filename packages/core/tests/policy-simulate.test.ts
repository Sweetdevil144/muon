import { describe, expect, it } from "vitest";
import {
  ALWAYS_ASK_ACTION_CLASSES,
  POLICY_ACTION_CLASSES,
  defaultPolicyProfile,
  policyProfileSchema,
  type PolicyActionClass,
  type PolicyDecision,
  type PolicyProfile,
} from "@muon/protocol";
import {
  isWithinTaskRadius,
  simulatePolicy,
} from "../src/policy-simulate.js";

// ── Profile variants under test ─────────────────────────────────────────────
// Each is parsed through the schema so it is a genuinely valid profile (and so
// the always-ask guard is exercised — a variant that allowed network/merge/ship
// simply would not parse).

const boldEditProfile = policyProfileSchema.parse({
  version: 1,
  label: "bold-edit",
  postures: {
    read: "allow",
    test: "allow",
    edit: "allow", // edits auto-approved everywhere
    network: "gate",
    merge: "gate",
    ship: "gate",
  },
});

const denyNetworkProfile = policyProfileSchema.parse({
  version: 1,
  label: "deny-network",
  postures: {
    read: "allow",
    test: "allow",
    edit: "gate",
    network: "deny",
    merge: "gate",
    ship: "gate",
  },
});

const radiusProfile = policyProfileSchema.parse({
  version: 1,
  label: "radius",
  postures: {
    read: "allow",
    test: "allow",
    edit: "gate", // outside the radius → ask
    network: "gate",
    merge: "gate",
    ship: "gate",
  },
  editInRadius: "allow", // inside the radius → free
  taskRadius: ["src/app"],
});

const strictProfile = policyProfileSchema.parse({
  version: 1,
  label: "strict",
  postures: {
    read: "gate",
    test: "gate",
    edit: "deny",
    network: "deny",
    merge: "deny",
    ship: "deny",
  },
});

// ── Exhaustive table: every action class × every profile variant ────────────

type Case = {
  profile: PolicyProfile;
  action: { class: PolicyActionClass; path?: string };
  expected: PolicyDecision;
  within?: boolean;
};

const cases: Case[] = [
  // Default posture: read/test free, everything else asks.
  { profile: defaultPolicyProfile, action: { class: "read" }, expected: "allow" },
  { profile: defaultPolicyProfile, action: { class: "test" }, expected: "allow" },
  {
    profile: defaultPolicyProfile,
    action: { class: "edit" },
    expected: "gate",
    within: false,
  },
  {
    profile: defaultPolicyProfile,
    action: { class: "edit", path: "src/app/page.ts" },
    expected: "gate", // no radius configured → outside
    within: false,
  },
  { profile: defaultPolicyProfile, action: { class: "network" }, expected: "gate" },
  { profile: defaultPolicyProfile, action: { class: "merge" }, expected: "gate" },
  { profile: defaultPolicyProfile, action: { class: "ship" }, expected: "gate" },

  // Bold-edit posture: edits allowed, dangerous classes still gated.
  { profile: boldEditProfile, action: { class: "read" }, expected: "allow" },
  { profile: boldEditProfile, action: { class: "test" }, expected: "allow" },
  {
    profile: boldEditProfile,
    action: { class: "edit", path: "anywhere/x.ts" },
    expected: "allow",
    within: false,
  },
  { profile: boldEditProfile, action: { class: "network" }, expected: "gate" },
  { profile: boldEditProfile, action: { class: "merge" }, expected: "gate" },
  { profile: boldEditProfile, action: { class: "ship" }, expected: "gate" },

  // Deny-network posture.
  { profile: denyNetworkProfile, action: { class: "read" }, expected: "allow" },
  { profile: denyNetworkProfile, action: { class: "test" }, expected: "allow" },
  {
    profile: denyNetworkProfile,
    action: { class: "edit" },
    expected: "gate",
    within: false,
  },
  { profile: denyNetworkProfile, action: { class: "network" }, expected: "deny" },
  { profile: denyNetworkProfile, action: { class: "merge" }, expected: "gate" },
  { profile: denyNetworkProfile, action: { class: "ship" }, expected: "gate" },

  // Radius posture: inside → allow, outside → gate.
  { profile: radiusProfile, action: { class: "read" }, expected: "allow" },
  { profile: radiusProfile, action: { class: "test" }, expected: "allow" },
  {
    profile: radiusProfile,
    action: { class: "edit", path: "src/app/page.ts" },
    expected: "allow",
    within: true,
  },
  {
    profile: radiusProfile,
    action: { class: "edit", path: "src/app" },
    expected: "allow", // exact prefix match
    within: true,
  },
  {
    profile: radiusProfile,
    action: { class: "edit", path: "src/other.ts" },
    expected: "gate",
    within: false,
  },
  {
    profile: radiusProfile,
    action: { class: "edit" },
    expected: "gate", // unscoped edit is never inside a radius
    within: false,
  },
  { profile: radiusProfile, action: { class: "network" }, expected: "gate" },
  { profile: radiusProfile, action: { class: "merge" }, expected: "gate" },
  { profile: radiusProfile, action: { class: "ship" }, expected: "gate" },

  // Strict posture: everything gated or denied.
  { profile: strictProfile, action: { class: "read" }, expected: "gate" },
  { profile: strictProfile, action: { class: "test" }, expected: "gate" },
  {
    profile: strictProfile,
    action: { class: "edit", path: "src/app/page.ts" },
    expected: "deny",
    within: false,
  },
  { profile: strictProfile, action: { class: "network" }, expected: "deny" },
  { profile: strictProfile, action: { class: "merge" }, expected: "deny" },
  { profile: strictProfile, action: { class: "ship" }, expected: "deny" },
];

describe("simulatePolicy — exhaustive class × profile table", () => {
  it.each(cases)(
    "$profile.label / $action.class → $expected",
    ({ profile, action, expected, within }) => {
      const result = simulatePolicy(action, profile);
      expect(result.decision).toBe(expected);
      expect(result.actionClass).toBe(action.class);
      // Reason is always a bounded, class-tagged sentence.
      expect(result.reason.startsWith(`${action.class}:`)).toBe(true);
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason.length).toBeLessThanOrEqual(1200);
      if (action.class === "edit") {
        expect(result.withinTaskRadius).toBe(within);
      } else {
        expect(result.withinTaskRadius).toBeUndefined();
      }
    }
  );

  it("covers every action class in the table for the default profile", () => {
    const covered = new Set(
      cases
        .filter((c) => c.profile.label === "default")
        .map((c) => c.action.class)
    );
    for (const cls of POLICY_ACTION_CLASSES) {
      expect(covered.has(cls)).toBe(true);
    }
  });

  it("names the offending path in an out-of-radius edit reason", () => {
    const result = simulatePolicy(
      { class: "edit", path: "src/other.ts" },
      radiusProfile
    );
    expect(result.reason).toContain('"src/other.ts"');
    expect(result.reason).toContain("outside the task radius");
  });
});

describe("isWithinTaskRadius", () => {
  it("is false for a missing path", () => {
    expect(isWithinTaskRadius(undefined, ["src"])).toBe(false);
  });

  it("is false against an empty radius", () => {
    expect(isWithinTaskRadius("src/app/page.ts", [])).toBe(false);
  });

  it("matches an exact prefix and paths beneath it", () => {
    expect(isWithinTaskRadius("src/app", ["src/app"])).toBe(true);
    expect(isWithinTaskRadius("src/app/page.ts", ["src/app"])).toBe(true);
  });

  it("normalizes trailing slashes on both sides", () => {
    expect(isWithinTaskRadius("src/app/", ["src/app"])).toBe(true);
    expect(isWithinTaskRadius("src/app/page.ts", ["src/app/"])).toBe(true);
  });

  it("does not match a sibling that merely shares a string prefix", () => {
    // "src/apple" starts with "src/app" as a string but is NOT under it.
    expect(isWithinTaskRadius("src/apple/core.ts", ["src/app"])).toBe(false);
  });

  it("matches when any one radius prefix contains the path", () => {
    expect(isWithinTaskRadius("lib/util.ts", ["src/app", "lib"])).toBe(true);
  });
});

// ── Property test: the never-allow invariant, generatively ──────────────────
//
// "simulation NEVER returns allow for merge/ship/network actions" — over MANY
// generated inputs, not one example. A tiny seeded xorshift32 keeps the loop
// deterministic + reproducible without adding a property-testing dependency.

function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function randomPath(rng: () => number): string | undefined {
  if (rng() < 0.2) {
    return undefined;
  }
  const segments = 1 + Math.floor(rng() * 4);
  const alphabet = "abcdef/._-01234";
  let out = "";
  const length = segments * 4;
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(rng() * alphabet.length)];
  }
  return out;
}

// A random VALID profile: read/test/edit/editInRadius flexible; the guarded
// classes drawn only from {gate, deny} (the schema forbids anything else).
function randomProfile(rng: () => number): PolicyProfile {
  const flexible = ["allow", "gate", "deny"] as const;
  const guarded = ["gate", "deny"] as const;
  const radiusLen = Math.floor(rng() * 4);
  const taskRadius = Array.from({ length: radiusLen }, (_, i) => `dir${i}/sub`);
  return policyProfileSchema.parse({
    version: 1,
    label: "generated",
    postures: {
      read: pick(rng, flexible),
      test: pick(rng, flexible),
      edit: pick(rng, flexible),
      network: pick(rng, guarded),
      merge: pick(rng, guarded),
      ship: pick(rng, guarded),
    },
    editInRadius: pick(rng, flexible),
    taskRadius,
  });
}

describe("property: never allow the always-ask classes", () => {
  it("the default profile never allows network/merge/ship (1000 random actions)", () => {
    const rng = makeRng(0xc0ffee);
    for (let i = 0; i < 1000; i += 1) {
      const actionClass = pick(rng, ALWAYS_ASK_ACTION_CLASSES);
      const result = simulatePolicy(
        { class: actionClass, path: randomPath(rng) },
        defaultPolicyProfile
      );
      expect(result.decision).not.toBe("allow");
      // The default posture gates (rather than denies) all three.
      expect(result.decision).toBe("gate");
    }
  });

  it("NO valid profile allows network/merge/ship (1000 random profiles × actions)", () => {
    const rng = makeRng(0x1234_5678);
    for (let i = 0; i < 1000; i += 1) {
      const profile = randomProfile(rng);
      const actionClass = pick(rng, ALWAYS_ASK_ACTION_CLASSES);
      const result = simulatePolicy(
        { class: actionClass, path: randomPath(rng) },
        profile
      );
      expect(result.decision).not.toBe("allow");
      expect(["gate", "deny"]).toContain(result.decision);
    }
  });

  it("every decision, for any class and any valid profile, is a legal posture", () => {
    const rng = makeRng(0x9e37_79b9);
    for (let i = 0; i < 1000; i += 1) {
      const profile = randomProfile(rng);
      const actionClass = pick(rng, POLICY_ACTION_CLASSES);
      const result = simulatePolicy(
        { class: actionClass, path: randomPath(rng) },
        profile
      );
      expect(["allow", "gate", "deny"]).toContain(result.decision);
      expect(result.reason.length).toBeLessThanOrEqual(1200);
    }
  });
});
