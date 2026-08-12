import { describe, expect, it } from "vitest";
import {
  ALWAYS_ASK_ACTION_CLASSES,
  POLICY_ACTION_CLASSES,
  defaultPolicyProfile,
  policyActionSchema,
  policyProfileSchema,
} from "../src/index.js";

describe("policy action vocabulary", () => {
  it("exposes the six canonical action classes in order", () => {
    expect([...POLICY_ACTION_CLASSES]).toEqual([
      "read",
      "test",
      "edit",
      "network",
      "merge",
      "ship",
    ]);
  });

  it("marks exactly network/merge/ship as always-ask", () => {
    expect([...ALWAYS_ASK_ACTION_CLASSES]).toEqual(["network", "merge", "ship"]);
    // Every always-ask class is a real action class.
    for (const cls of ALWAYS_ASK_ACTION_CLASSES) {
      expect(POLICY_ACTION_CLASSES).toContain(cls);
    }
  });
});

describe("defaultPolicyProfile", () => {
  it("is read/test free, edit-gated, network/merge/ship always-ask", () => {
    expect(defaultPolicyProfile).toEqual({
      version: 1,
      label: "default",
      postures: {
        read: "allow",
        test: "allow",
        edit: "gate",
        network: "gate",
        merge: "gate",
        ship: "gate",
      },
      editInRadius: "allow",
      taskRadius: [],
    });
  });

  it("re-parses cleanly (round-trips through the schema)", () => {
    expect(policyProfileSchema.parse(defaultPolicyProfile)).toEqual(
      defaultPolicyProfile
    );
  });
});

const validProfile = {
  version: 1 as const,
  label: "custom",
  postures: {
    read: "allow" as const,
    test: "allow" as const,
    edit: "gate" as const,
    network: "gate" as const,
    merge: "gate" as const,
    ship: "gate" as const,
  },
  editInRadius: "allow" as const,
  taskRadius: ["src/app"],
};

describe("policyProfileSchema", () => {
  it("accepts a well-formed profile", () => {
    expect(policyProfileSchema.parse(validProfile)).toEqual(validProfile);
  });

  it("defaults editInRadius and taskRadius when omitted", () => {
    const { editInRadius: _e, taskRadius: _t, ...minimal } = validProfile;
    const parsed = policyProfileSchema.parse(minimal);
    expect(parsed.editInRadius).toBe("allow");
    expect(parsed.taskRadius).toEqual([]);
  });

  it("rejects an unknown top-level key (strict)", () => {
    expect(() =>
      policyProfileSchema.parse({ ...validProfile, autoApprove: true })
    ).toThrow();
  });

  it("rejects an unknown posture key (strict)", () => {
    expect(() =>
      policyProfileSchema.parse({
        ...validProfile,
        postures: { ...validProfile.postures, deploy: "gate" },
      })
    ).toThrow();
  });

  it("rejects a version other than 1", () => {
    expect(() =>
      policyProfileSchema.parse({ ...validProfile, version: 2 })
    ).toThrow();
  });

  // The type-level invariant: network/merge/ship can never be `allow`.
  it.each(["network", "merge", "ship"] as const)(
    "refuses to allow the always-ask class %s",
    (guarded) => {
      expect(() =>
        policyProfileSchema.parse({
          ...validProfile,
          postures: { ...validProfile.postures, [guarded]: "allow" },
        })
      ).toThrow();
    }
  );

  it.each(["gate", "deny"] as const)(
    "permits the always-ask classes to be %s",
    (guarded) => {
      const parsed = policyProfileSchema.parse({
        ...validProfile,
        postures: {
          ...validProfile.postures,
          network: guarded,
          merge: guarded,
          ship: guarded,
        },
      });
      expect(parsed.postures.network).toBe(guarded);
      expect(parsed.postures.merge).toBe(guarded);
      expect(parsed.postures.ship).toBe(guarded);
    }
  );

  it.each(["allow", "gate", "deny"] as const)(
    "lets read/test/edit take the flexible posture %s",
    (posture) => {
      const parsed = policyProfileSchema.parse({
        ...validProfile,
        postures: {
          ...validProfile.postures,
          read: posture,
          test: posture,
          edit: posture,
        },
      });
      expect(parsed.postures.read).toBe(posture);
      expect(parsed.postures.test).toBe(posture);
      expect(parsed.postures.edit).toBe(posture);
    }
  );

  it("rejects a task-radius prefix with a traversal segment", () => {
    expect(() =>
      policyProfileSchema.parse({
        ...validProfile,
        taskRadius: ["../secrets"],
      })
    ).toThrow();
  });

  it("rejects an over-long task radius (bounded)", () => {
    expect(() =>
      policyProfileSchema.parse({
        ...validProfile,
        taskRadius: Array.from({ length: 65 }, (_, i) => `dir-${i}`),
      })
    ).toThrow();
  });
});

describe("policyActionSchema", () => {
  it("accepts a bare action class", () => {
    expect(policyActionSchema.parse({ class: "read" })).toEqual({
      class: "read",
    });
  });

  it("accepts an edit action carrying a path", () => {
    expect(
      policyActionSchema.parse({ class: "edit", path: "src/app/page.ts" })
    ).toEqual({ class: "edit", path: "src/app/page.ts" });
  });

  it("rejects an unknown action class", () => {
    expect(() => policyActionSchema.parse({ class: "deploy" })).toThrow();
  });

  it("rejects an unknown field (strict)", () => {
    expect(() =>
      policyActionSchema.parse({ class: "read", scope: "everything" })
    ).toThrow();
  });

  it("rejects an over-long path (bounded)", () => {
    expect(() =>
      policyActionSchema.parse({ class: "edit", path: "a".repeat(1025) })
    ).toThrow();
  });
});
