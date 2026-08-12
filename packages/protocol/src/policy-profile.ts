import { z } from "zod";

// ── P0.4 workspace policy profile (slice 1: schema + dry-run only) ───────────
//
// A workspace policy profile is a VERSIONED, bounded description of MUON's
// posture toward the coarse action classes an orchestrated agent can take. It
// answers one question per class: allow (do it), gate (ask a human), or deny
// (never).
//
// THIS IS ENFORCED. The paragraph that used to stand here said this slice was
// "SCHEMA + SIMULATION ONLY — nothing here is wired into the gate/approval
// enforcement path", which was true when the schema landed and has been false
// since enforcement shipped: `startManagedSession` runs `simulatePolicy` over
// this profile on every classified tool request and returns
// `{ behavior: "deny" }` on a `deny` verdict, before the vendor ever sees the
// call (`packages/core/src/session-manager.ts`, the `sim.decision === "deny"`
// arm). `muon policy explain` still renders the same function as a dry run —
// that part was always true — but a reader who trusted the old sentence would
// have believed a posture they set was inert when it actually blocks tool
// calls, which is exactly backwards for a fail-closed surface.
//
// Invariant baked into the TYPE (not merely the default): network, merge, and
// ship "always ask" — the guarded posture below cannot express `allow` for
// them, so no profile, however edited, can auto-approve landing/shipping or
// reaching outside the workspace. read/test/edit stay flexible; only the
// dangerous classes are hard-fenced.

// The coarse, vendor-neutral action classes the policy reasons about, in
// canonical order (drives exhaustive rendering + tests):
//   read    — inspect the workspace: read, list, search — no mutation
//   test    — run the workspace's own tests/checks — no source mutation
//   edit    — modify workspace files
//   network — reach outside the workspace: fetch, install, remote calls
//   merge   — integrate/land a change (branch merge, PR land)
//   ship    — deploy, publish, release
export const POLICY_ACTION_CLASSES = [
  "read",
  "test",
  "edit",
  "network",
  "merge",
  "ship",
] as const;

export const policyActionClassSchema = z.enum(POLICY_ACTION_CLASSES);
export type PolicyActionClass = z.infer<typeof policyActionClassSchema>;

/** The action classes that ALWAYS require a human — never auto-allowable. */
export const ALWAYS_ASK_ACTION_CLASSES = ["network", "merge", "ship"] as const;

/** A posture / decision: do it, ask a human, or refuse. */
export const policyPostureSchema = z.enum(["allow", "gate", "deny"]);
export type PolicyPosture = z.infer<typeof policyPostureSchema>;

/**
 * The simulator's verdict draws from the SAME three values as a posture; a
 * distinct alias keeps call sites honest about which is configured (posture) vs
 * decided (decision).
 */
export type PolicyDecision = PolicyPosture;

/**
 * The guarded posture for the always-ask classes: `allow` is UNREPRESENTABLE,
 * so "network, merge, and ship always ask" is a property of the schema itself,
 * not merely of the default profile. A profile that tries to allow one of them
 * fails to parse.
 */
export const guardedPostureSchema = z.enum(["gate", "deny"]);
export type GuardedPosture = z.infer<typeof guardedPostureSchema>;

// A task-radius prefix: an opaque, canonical path fragment (workspace-relative
// or absolute) that an edit may land inside without asking. Bounded, and — like
// a delegation workspace — forbidden from carrying `.`/`..` segments so radius
// matching can never be widened by traversal.
const taskRadiusPrefix = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value
        .split(/[\\/]+/)
        .some((segment) => segment === "." || segment === ".."),
    "task-radius prefixes must be canonical (no '.' or '..' segments)"
  );

/**
 * A versioned workspace policy profile. `version` gates forward evolution the
 * way delegation policies are versioned; `.strict()` (here and on `postures`)
 * means an unknown key is rejected rather than silently ignored.
 */
export const policyProfileSchema = z
  .object({
    version: z.literal(1),
    /** Short human label (e.g. "default"). Bounded. */
    label: z.string().trim().min(1).max(64),
    /**
     * Posture per action class. For `edit` this is the posture OUTSIDE the task
     * radius (see `editInRadius`); the other classes ignore the radius. The
     * always-ask classes are guarded (gate | deny only). Every class is
     * required, so simulation is total.
     */
    postures: z
      .object({
        read: policyPostureSchema,
        test: policyPostureSchema,
        edit: policyPostureSchema,
        network: guardedPostureSchema,
        merge: guardedPostureSchema,
        ship: guardedPostureSchema,
      })
      .strict(),
    /**
     * Posture for edits that land INSIDE the task radius. Split from
     * `postures.edit` so "edits ask when outside the task radius" is expressible
     * directly: inside → this (allow by default), outside → `postures.edit`.
     */
    editInRadius: policyPostureSchema.default("allow"),
    /**
     * Path prefixes an edit may touch without asking. Empty (the built-in
     * default) means EVERY edit is "outside" the radius and falls to
     * `postures.edit` — conservative by construction. A per-task profile
     * narrows the radius to the files that task is scoped to.
     */
    taskRadius: z.array(taskRadiusPrefix).max(64).default([]),
  })
  .strict();
export type PolicyProfile = z.infer<typeof policyProfileSchema>;

/**
 * The built-in default posture: read and test freely; edits ask when outside
 * the task radius (and with no radius configured, that means every edit asks);
 * network, merge, and ship always ask. This is the profile `muon policy explain`
 * uses when none is supplied, and the posture the never-allow property test pins.
 */
export const defaultPolicyProfile: PolicyProfile = policyProfileSchema.parse({
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

/**
 * A policy action to simulate: the class, plus (for an edit) the target path
 * matched against the task radius. Pure input to `simulatePolicy`; `.strict()`
 * so a stray field never silently changes the decision.
 */
export const policyActionSchema = z
  .object({
    class: policyActionClassSchema,
    /** Target path — edits only; matched against the task radius. Bounded. */
    path: z.string().trim().min(1).max(1024).optional(),
  })
  .strict();
export type PolicyAction = z.infer<typeof policyActionSchema>;
