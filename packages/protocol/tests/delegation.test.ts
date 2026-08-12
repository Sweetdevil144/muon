import { describe, expect, it } from "vitest";
import {
  DELEGATION_MAX_DESCENDANTS,
  MUON_DELEGATE_CAPABILITY_TOOL_NAMES,
  delegationManifestSchema,
  delegationRootPolicySchema,
  delegationRootPolicyV2Schema,
} from "../src/index.js";

const validManifest = {
  version: 1 as const,
  rootJobId: "job-root",
  parentJobId: "job-parent",
  jobId: "job-child",
  depth: 2,
  maxDepth: 3,
  maxChildrenPerParent: 3,
  maxTotalDescendants: 8,
  rootWorkspace: "/repo",
  workspacePath: "/repo/packages/client",
  budget: {
    maxWallMs: 120_000,
    maxIterations: 3,
  },
  deadlineAt: "2026-07-16T12:00:00.000Z",
  delegationIterationCap: 3,
  authority: "work" as const,
  forbiddenAuthority: ["govern", "approve", "merge", "ship"] as const,
  canDelegate: true,
  propagatedTools: [...MUON_DELEGATE_CAPABILITY_TOOL_NAMES],
  narrowingAttested: true,
};

describe("delegationManifestSchema", () => {
  it("accepts a bounded, work-only child manifest", () => {
    expect(delegationManifestSchema.parse(validManifest)).toEqual({
      ...validManifest,
      // ADR-0048: the parse SUPPLIES the default — a fixture without the
      // field is an older record, and older records mean read.
      fileAuthority: "read",
    });
  });

  it.each([
    ["depth", { depth: 4 }],
    ["workspace", { workspacePath: "/other/repo" }],
    ["wall budget", { budget: { maxWallMs: 0, maxIterations: 3 } }],
    ["authority", { authority: "govern" }],
    ["tool widening", { propagatedTools: ["set_fleet"] }],
    ["unattested narrowing", { narrowingAttested: false }],
  ])("rejects invalid %s", (_label, patch) => {
    expect(() =>
      delegationManifestSchema.parse({ ...validManifest, ...patch })
    ).toThrow();
  });
});

const validRootV1 = {
  version: 1 as const,
  jobId: "job-root",
  workspacePath: "/repo",
  maxDepth: 3,
  maxChildrenPerParent: 3,
  maxTotalDescendants: 8,
  maxIterations: 10,
  deadlineAt: "2026-07-16T12:00:00.000Z",
  authority: "orchestrator" as const,
  childAuthority: "work" as const,
  narrowingRequired: true as const,
};
// v2 adds the fleet-scaled descendant pool decoupled from the root's own turn.
const validRootV2 = {
  ...validRootV1,
  version: 2 as const,
  maxDescendantWallMs: DELEGATION_MAX_DESCENDANTS * 600_000,
};

describe("delegationRootPolicySchema (versioned: v1 in-flight, v2 fleet pool)", () => {
  it("still validates a v1 in-flight root (no descendant pool)", () => {
    expect(delegationRootPolicySchema.parse(validRootV1)).toEqual(validRootV1);
  });

  it("validates a v2 root carrying the fleet-scaled descendant pool", () => {
    expect(delegationRootPolicySchema.parse(validRootV2)).toEqual(validRootV2);
    // The v2 branch is directly usable for minting a new root.
    expect(delegationRootPolicyV2Schema.parse(validRootV2)).toEqual(validRootV2);
  });

  it("rejects a v2 root that omits the descendant pool", () => {
    const { maxDescendantWallMs: _omitted, ...noPool } = validRootV2;
    expect(() => delegationRootPolicySchema.parse(noPool)).toThrow();
  });

  it.each([
    ["zero pool", { maxDescendantWallMs: 0 }],
    [
      "pool above the aggregate per-child ceiling",
      { maxDescendantWallMs: DELEGATION_MAX_DESCENDANTS * 1_800_000 + 1 },
    ],
  ])("rejects a v2 root with a %s", (_label, patch) => {
    expect(() =>
      delegationRootPolicySchema.parse({ ...validRootV2, ...patch })
    ).toThrow();
  });

  it("never ignores unknown fields: a v1 object carrying the v2 pool is rejected", () => {
    // Strict union — the v1 branch forbids the extra key and the v2 branch
    // requires version:2, so a pool smuggled onto a v1 policy can never validate.
    expect(() =>
      delegationRootPolicySchema.parse({
        ...validRootV1,
        maxDescendantWallMs: 4_800_000,
      })
    ).toThrow();
  });
});

describe("the delegate policy bounds WIDENING, not exact equality", () => {
  /**
   * Measured 2026-08-10, on this machine, in production.
   *
   * `propagatedTools` had to EQUAL `MUON_DELEGATE_CAPABILITY_TOOL_NAMES`. That
   * constant grows whenever a tool joins the context or coordination tier, and
   * a manifest is a RECORD — written once, read for the life of the job. So
   * adding `publish_finding` invalidated every manifest already in the ledger:
   * `muon dispatch status` could not parse its own jobs, and enqueueing a child
   * failed because the PARENT's stored manifest no longer validated. One tool
   * addition, and no crew could form.
   *
   * The property worth defending is that a manifest never grants MORE than the
   * policy. Granting less is what an older record IS, and is strictly safer.
   */
  const olderPolicy = MUON_DELEGATE_CAPABILITY_TOOL_NAMES.filter(
    (name) => name !== "publish_finding"
  );

  it("a manifest minted before a tool existed still validates", () => {
    const result = delegationManifestSchema.safeParse({
      ...validManifest,
      propagatedTools: [...olderPolicy],
    });
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("a much narrower manifest validates too — less is never a risk", () => {
    const result = delegationManifestSchema.safeParse({
      ...validManifest,
      canDelegate: false,
      propagatedTools: [
        "whoami",
        "code_query",
        "memory_search",
        "task_context",
        "repo_map",
        "code_context",
      ],
    });
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("WIDENING past the policy is still refused", () => {
    // The boundary that actually matters. `z.enum` rejects the name outright.
    const result = delegationManifestSchema.safeParse({
      ...validManifest,
      propagatedTools: [...MUON_DELEGATE_CAPABILITY_TOOL_NAMES, "set_fleet"],
    });
    expect(result.success).toBe(false);
  });

  it("and a manifest that cannot delegate may not carry `delegate`", () => {
    // The one widening `z.enum` cannot catch: a legal tool name granting an
    // authority this manifest was denied.
    const result = delegationManifestSchema.safeParse({
      ...validManifest,
      canDelegate: false,
      propagatedTools: [...MUON_DELEGATE_CAPABILITY_TOOL_NAMES],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/must not propagate/);
  });
});

describe("ADR-0048 — fileAuthority on the child manifest", () => {
  it("a manifest minted before the field existed means READ", () => {
    // The conservative direction: an old child does not silently gain edit.
    const { fileAuthority, ...withoutField } = validManifest as {
      fileAuthority?: unknown;
    } & typeof validManifest;
    void fileAuthority;
    const parsed = delegationManifestSchema.parse(withoutField);
    expect(parsed.fileAuthority).toBe("read");
  });

  it("edit round-trips", () => {
    const parsed = delegationManifestSchema.parse({
      ...validManifest,
      fileAuthority: "edit",
    });
    expect(parsed.fileAuthority).toBe("edit");
  });

  it("an authority outside the enum is refused, not defaulted", () => {
    // A typo that silently became "read" would look like a working grant that
    // never grants; a typo that silently became "edit" would be a widening.
    const result = delegationManifestSchema.safeParse({
      ...validManifest,
      fileAuthority: "write-everything",
    });
    expect(result.success).toBe(false);
  });
});
