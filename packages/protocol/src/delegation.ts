import { z } from "zod";
import { MUON_DELEGATE_CAPABILITY_TOOL_NAMES } from "./mcp-tool-inventory.js";

export const DELEGATION_MAX_DEPTH = 3;
export const DELEGATION_MAX_CHILDREN = 3;
export const DELEGATION_MAX_DESCENDANTS = 8;
// Right-sized default wall-clock budget for a delegated child (20 min). The
// default child no longer grabs the whole root pool: a plain delegate reserves
// min(this, parent cap, remaining wall, remaining root budget), so sibling
// workers enqueue concurrently instead of deterministically 409-ing. An
// explicit `maxWallMs` still overrides (and keeps the strict 400/409 checks).
//
// Was 600 000 (10 min), and 10 minutes was measurably too small for the work
// MUON actually delegates: on the founder's mission BOTH claude implementers ran
// 603 s against it and were killed mid-edit, having done graph queries, read
// code, made changes, and started a package test suite. Doubling is bounded on
// three sides and each still holds:
//   • per child ≤ the manifest's hard 1 800 000 ms cap, with 10 min of headroom
//     left for an explicit larger request;
//   • the default root pool is DELEGATION_MAX_DESCENDANTS × this = 160 min,
//     still well under the schema's 240-min ceiling (8 × 30 min);
//   • it stays strictly BELOW the 30-minute chat-turn budget, so a full wave of
//     children can finish and leave the coordinator time to report on them — a
//     child sized at the 30-min cap could not.
export const DEFAULT_CHILD_WALL_MS = 1_200_000;

const recordId = z.string().trim().min(1).max(128);
const workspace = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.split(/[\\/]+/).some((segment) => segment === "." || segment === ".."),
    "workspace paths must be canonical"
  );

export const delegationManifestSchema = z
  .object({
    version: z.literal(1),
    rootJobId: recordId,
    parentJobId: recordId,
    jobId: recordId,
    depth: z.number().int().min(1).max(DELEGATION_MAX_DEPTH),
    maxDepth: z.number().int().min(1).max(DELEGATION_MAX_DEPTH),
    maxChildrenPerParent: z
      .number()
      .int()
      .min(1)
      .max(DELEGATION_MAX_CHILDREN),
    maxTotalDescendants: z
      .number()
      .int()
      .min(1)
      .max(DELEGATION_MAX_DESCENDANTS),
    rootWorkspace: workspace,
    workspacePath: workspace,
    budget: z
      .object({
        maxWallMs: z.number().int().min(1).max(1_800_000),
        maxIterations: z.number().int().min(1).max(10).optional(),
      })
      .strict(),
    deadlineAt: z.string().datetime({ offset: true }),
    delegationIterationCap: z.number().int().min(1).max(10),
    authority: z.literal("work"),
    forbiddenAuthority: z.tuple([
      z.literal("govern"),
      z.literal("approve"),
      z.literal("merge"),
      z.literal("ship"),
    ]),
    canDelegate: z.boolean(),
    /**
     * ADR-0048 — what this child may do to FILES, attested by its parent at
     * mint. `read` is the default and what every manifest minted before this
     * field existed means (records stay valid; the conservative direction —
     * an old child does not silently gain edit).
     *
     * `edit` is minted ONLY when the child's harness requires an isolated
     * worktree (implement/repair-class): the worktree IS the write boundary.
     * The runner re-checks the harness at launch, so a hand-edited manifest
     * cannot grant edit to a read-shaped harness.
     */
    fileAuthority: z.enum(["read", "edit"]).default("read"),
    propagatedTools: z
      .array(z.enum(MUON_DELEGATE_CAPABILITY_TOOL_NAMES))
      .min(6)
      .max(MUON_DELEGATE_CAPABILITY_TOOL_NAMES.length),
    narrowingAttested: z.literal(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.depth > value.maxDepth) {
      ctx.addIssue({
        code: "custom",
        path: ["depth"],
        message: "delegation depth exceeds maxDepth",
      });
    }
    const root = value.rootWorkspace.replace(/[\\/]+$/, "");
    const child = value.workspacePath.replace(/[\\/]+$/, "");
    if (child !== root && !child.startsWith(`${root}/`)) {
      ctx.addIssue({
        code: "custom",
        path: ["workspacePath"],
        message: "child workspace must remain inside the root workspace",
      });
    }
    // NO WIDENING — which is not the same as equality, and the difference
    // took down every dispatch on this machine.
    //
    // This used to require `propagatedTools` to EQUAL the policy exactly. The
    // policy is `MUON_DELEGATE_CAPABILITY_TOOL_NAMES`, a constant that grows
    // whenever a tool joins the context or coordination tier — and a manifest
    // is a RECORD, written once and read for the life of the job. So adding
    // `publish_finding` on 2026-08-10 instantly invalidated every manifest
    // already in the ledger: `muon dispatch status` failed to parse its own
    // jobs, and enqueueing a child failed because the PARENT's stored manifest
    // no longer validated. One tool addition, and the crew could not form.
    //
    // Equality was defending a real property in the wrong shape. What must
    // never happen is a manifest granting MORE than the policy; a manifest
    // granting LESS is strictly safer, and is exactly what an older record is.
    // Reading a manifest is also the wrong moment to enforce producer
    // discipline — the producer is checked where it produces (dispatch.ts
    // derives from this same constant, and a test pins that it mints the
    // policy exactly), so nothing is lost by scoping this to the boundary.
    //
    // The direction matters: a newly added tier is now NOT retroactively
    // propagated into manifests minted before it existed. That is the
    // conservative default — a running child does not silently gain a
    // capability its parent never attested to.
    //
    // `z.enum` above already rejects any name outside the policy, so the only
    // widening left to catch here is the authority one: `delegate` itself.
    if (!value.canDelegate && value.propagatedTools.includes("delegate")) {
      ctx.addIssue({
        code: "custom",
        path: ["propagatedTools"],
        message:
          "a manifest that cannot delegate must not propagate the delegate tool",
      });
    }
  });

export type DelegationManifest = z.infer<typeof delegationManifestSchema>;

// The version-invariant shape shared by every root policy revision. The
// descendant pool (v2+) is layered on top so an in-flight v1 root still validates.
const rootPolicyShape = {
  jobId: recordId,
  workspacePath: workspace,
  maxDepth: z.number().int().min(1).max(DELEGATION_MAX_DEPTH),
  maxChildrenPerParent: z.number().int().min(1).max(DELEGATION_MAX_CHILDREN),
  maxTotalDescendants: z.number().int().min(1).max(DELEGATION_MAX_DESCENDANTS),
  maxIterations: z.number().int().min(1).max(10),
  deadlineAt: z.string().datetime({ offset: true }),
  authority: z.literal("orchestrator"),
  childAuthority: z.literal("work"),
  narrowingRequired: z.literal(true),
};

// v1: minted before the fleet-scaled pool (S3). The aggregate descendant budget
// was implicitly the root's OWN turn timeout (root.maxWallMs). Roots created
// before the migration keep validating (and delegating) through this branch.
export const delegationRootPolicyV1Schema = z
  .object({ version: z.literal(1), ...rootPolicyShape })
  .strict();

// v2 (S3): the aggregate descendant wall-clock pool is DECOUPLED from the root's
// own turn timeout and sized to the fleet (DELEGATION_MAX_DESCENDANTS ×
// DEFAULT_CHILD_WALL_MS by default = 160 min), so N read-only workers enqueue
// concurrently instead of starving on the 30-min turn budget. The ceiling is every
// descendant at the per-child wall cap (30 min), so the pool can never exceed the
// aggregate a fully-fanned-out tree could ever consume.
export const delegationRootPolicyV2Schema = z
  .object({
    version: z.literal(2),
    ...rootPolicyShape,
    maxDescendantWallMs: z
      .number()
      .int()
      .min(1)
      .max(DELEGATION_MAX_DESCENDANTS * 1_800_000),
  })
  .strict();

// Accept BOTH revisions: an in-flight v1 root still validates while every new root
// carries the pool. `.strict()` on each branch keeps the consistency check honest —
// a v2-only field can never slip through v1 validation unnoticed ("never ignore
// unknown fields"); the version literal disambiguates the union.
export const delegationRootPolicySchema = z.union([
  delegationRootPolicyV1Schema,
  delegationRootPolicyV2Schema,
]);

export type DelegationRootPolicy = z.infer<
  typeof delegationRootPolicySchema
>;

export const delegationPolicySchema = z.union([
  delegationRootPolicySchema,
  delegationManifestSchema,
]);
export type DelegationPolicy = z.infer<typeof delegationPolicySchema>;
