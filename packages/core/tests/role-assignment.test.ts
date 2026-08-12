import { describe, expect, it } from "vitest";
import {
  AGENT_ROLES,
  ROLE_SPECS,
  type AgentRole,
  type LaneCapabilities,
} from "@muon/protocol";
import {
  assignRoles,
  roleFit,
  rolesForVendor,
  vendorForRole,
  type LaneCandidate,
} from "../src/role-assignment.js";

const FULL_CAPABILITIES: LaneCapabilities = {
  canStreamEvents: true,
  canInterrupt: true,
  canBackground: true,
  supportsApprovals: true,
  supportsWorktrees: true,
};

function lane(
  vendor: string,
  overrides: Partial<LaneCandidate> = {}
): LaneCandidate {
  return {
    vendor,
    displayName: vendor,
    capabilities: { ...FULL_CAPABILITIES },
    health: "healthy",
    // The full ceiling, STATED. The field used to be optional and every lane
    // here omitted it, which the engine read as "unconstrained" — the same
    // default that admitted a forgetful adapter to every role. Spelling it out
    // keeps every expectation below byte-identical while removing the reliance
    // on absence (ADR-0022 §5 C1).
    supportedRoles: [...AGENT_ROLES],
    ...overrides,
  };
}

const READ_ONLY_ROLES = AGENT_ROLES.filter(
  (role) => ROLE_SPECS[role].authority === "read-only"
);

describe("assignRoles is deterministic", () => {
  it("produces an identical plan for identical input, twice", () => {
    const input = {
      chatId: "chat-1",
      lanes: [
        lane("claude-code", { cost: 0.9 }),
        lane("codex", { cost: 0.6 }),
        lane("ollama", { cost: 0, health: "degraded" as const }),
      ],
    };
    expect(assignRoles(input)).toEqual(assignRoles(input));
  });

  it("does not depend on a model call or on wall-clock: repeated runs are byte-identical", () => {
    const lanes = [lane("codex"), lane("claude-code"), lane("cursor")];
    const first = assignRoles({ chatId: "chat-1", lanes });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(assignRoles({ chatId: "chat-1", lanes })).toEqual(first);
    }
  });

  it("orders bindings by fixed role priority, not by input order", () => {
    const plan = assignRoles({
      chatId: "chat-1",
      lanes: [lane("claude-code")],
      // Deliberately scrambled; the plan must not reflect this ordering.
      roles: ["scout", "reviewer", "implementer", "orchestrator"],
    });
    expect(plan.bindings.map((binding) => binding.role)).toEqual([
      "orchestrator",
      "implementer",
      "reviewer",
      "scout",
    ]);
  });
});

describe("required capabilities BLOCK, they do not merely lower the score", () => {
  it("refuses a lane that cannot hold the role even when it is the ONLY lane", () => {
    const noWorktrees = lane("cursor", {
      capabilities: { ...FULL_CAPABILITIES, supportsWorktrees: false },
    });
    const fit = roleFit(noWorktrees, "implementer");
    expect(fit.blocked).toBe(true);
    expect(fit.fit).toBe(0);
    expect(fit.blockedReason).toContain("supportsWorktrees");

    // The decisive part: with no alternative, a merely low score would still be
    // the argmax and the lane would be handed authority it cannot honor.
    const plan = assignRoles({
      chatId: "chat-1",
      lanes: [noWorktrees],
      roles: ["implementer"],
    });
    expect(plan.bindings).toEqual([]);
    expect(plan.unfilled).toEqual(["implementer"]);
  });

  it("blocks a coordinator on a lane that cannot background or be interrupted", () => {
    const oneShot = lane("cursor", {
      capabilities: {
        ...FULL_CAPABILITIES,
        canBackground: false,
        canInterrupt: false,
      },
    });
    const fit = roleFit(oneShot, "orchestrator");
    expect(fit.blocked).toBe(true);
    expect(fit.blockedReason).toContain("canInterrupt");
    expect(fit.blockedReason).toContain("canBackground");
  });

  it("holds for every role's declared requiredCapabilities", () => {
    for (const role of AGENT_ROLES) {
      for (const capability of ROLE_SPECS[role].requiredCapabilities) {
        const crippled = lane("codex", {
          capabilities: { ...FULL_CAPABILITIES, [capability]: false },
        });
        expect(roleFit(crippled, role).blocked).toBe(true);
      }
    }
  });
});

describe("an unavailable lane is never assigned", () => {
  it("is refused even when its declared affinity is perfect", () => {
    const dead = lane("codex", {
      health: "unavailable",
      roleAffinity: { reviewer: 1 },
    });
    const alive = lane("claude-code", { roleAffinity: { reviewer: 0.2 } });

    expect(roleFit(dead, "reviewer").blocked).toBe(true);
    const plan = assignRoles({
      chatId: "chat-1",
      lanes: [dead, alive],
      roles: ["reviewer"],
    });
    expect(plan.bindings).toHaveLength(1);
    expect(plan.bindings[0]!.vendor).toBe("claude-code");
  });

  it("leaves every role unfilled when the only lane is unavailable", () => {
    const plan = assignRoles({
      chatId: "chat-1",
      lanes: [lane("codex", { health: "unavailable" })],
      roles: ["reviewer", "qa", "scout"],
    });
    expect(plan.bindings).toEqual([]);
    expect(plan.unfilled).toEqual(["reviewer", "qa", "scout"]);
  });

  it("still assigns a degraded lane, scaled down rather than blocked", () => {
    const degraded = lane("codex", { health: "degraded" });
    const fit = roleFit(degraded, "reviewer");
    expect(fit.blocked).toBe(false);
    expect(fit.fit).toBeGreaterThan(0);
    expect(fit.fit).toBeLessThan(roleFit(lane("codex"), "reviewer").fit);
    expect(fit.reason).toContain("degraded");
  });
});

describe("supportedRoles is an adapter-declared ceiling", () => {
  it("an EMPTY array means the lane holds nothing", () => {
    // The lane helper hands out the FULL capability set, so nothing here is
    // blocked by a missing capability: `[]` alone refuses all seven roles. That
    // is the property the whole ceiling rests on, and it is asserted before the
    // `undefined` default is allowed to change (ADR-0022 §5 B4).
    const inert = lane("ollama", { supportedRoles: [] });
    expect(inert.capabilities).toEqual(FULL_CAPABILITIES);
    for (const role of AGENT_ROLES) {
      const fit = roleFit(inert, role);
      expect(fit.blocked, `${role} must be blocked by the empty ceiling`).toBe(
        true
      );
      expect(fit.fit).toBe(0);
      expect(fit.blockedReason).toContain("not integrated");
    }
    const plan = assignRoles({
      chatId: "chat-1",
      lanes: [inert],
      roles: ["scout", "reviewer"],
    });
    expect(plan.bindings).toEqual([]);
    expect(plan.unfilled).toEqual(["reviewer", "scout"]);
  });

  it("an empty ceiling is refused for EVERY role, in a full assignment too", () => {
    // `roleFit` is the unit; this is the same claim through the engine, so a
    // future ranking change cannot route around the ceiling on the way in.
    const inert = lane("ollama", { supportedRoles: [] });
    const plan = assignRoles({ chatId: "chat-1", lanes: [inert] });
    expect(plan.bindings).toEqual([]);
    expect([...plan.unfilled].sort()).toEqual([...AGENT_ROLES].sort());
  });

  it("there is no 'unset' — a lane that holds everything says so", () => {
    // This test used to read "UNDEFINED means unconstrained", asserting
    // `supportedRoles === undefined` and that every role was then unblocked.
    // That default is exactly what let a new adapter reach `orchestrator` and
    // `implementer` by omission, so the third state is gone: the ceiling is
    // always a list, and "everything" is spelled as the full list.
    const open = lane("claude-code");
    expect(open.supportedRoles).toEqual([...AGENT_ROLES]);
    for (const role of AGENT_ROLES) {
      expect(roleFit(open, role).blocked).toBe(false);
    }
  });

  it("a partial list holds exactly the listed roles", () => {
    const scoutOnly = lane("ollama", { supportedRoles: ["scout"] });
    expect(roleFit(scoutOnly, "scout").blocked).toBe(false);
    expect(roleFit(scoutOnly, "reviewer").blocked).toBe(true);
    expect(roleFit(scoutOnly, "reviewer").blockedReason).toContain(
      "not integrated"
    );
  });
});

describe("a human pin outranks the engine", () => {
  it("wins over a strictly higher-fit lane and is attributed to the human", () => {
    const strong = lane("claude-code", { roleAffinity: { reviewer: 1 } });
    const weak = lane("codex", { roleAffinity: { reviewer: 0.05 } });
    // Control: without the pin the engine picks the higher-fit lane.
    expect(
      assignRoles({
        chatId: "chat-1",
        lanes: [strong, weak],
        roles: ["reviewer"],
      }).bindings[0]!.vendor
    ).toBe("claude-code");

    const plan = assignRoles({
      chatId: "chat-1",
      lanes: [strong, weak],
      roles: ["reviewer"],
      pinned: { reviewer: "codex" },
    });
    expect(plan.bindings).toHaveLength(1);
    expect(plan.bindings[0]).toMatchObject({
      vendor: "codex",
      role: "reviewer",
      assignedBy: "human",
      blocked: false,
    });
    expect(plan.bindings[0]!.reason).toContain("Pinned by you");
    expect(vendorForRole(plan, "reviewer")).toBe("codex");
  });

  it("records a pin to a BLOCKED lane as blocked rather than granting it", () => {
    // The pin is honored as PROVENANCE, never as authority: a human cannot
    // hand a lane a role its capabilities cannot honor.
    const noWorktrees = lane("cursor", {
      capabilities: { ...FULL_CAPABILITIES, supportsWorktrees: false },
    });
    const plan = assignRoles({
      chatId: "chat-1",
      lanes: [noWorktrees, lane("claude-code")],
      roles: ["implementer"],
      pinned: { implementer: "cursor" },
    });
    expect(plan.bindings).toHaveLength(1);
    expect(plan.bindings[0]).toMatchObject({
      vendor: "cursor",
      role: "implementer",
      assignedBy: "human",
      blocked: true,
      fit: 0,
    });
    expect(plan.bindings[0]!.blockedReason).toContain("supportsWorktrees");
    // A blocked binding grants nothing downstream.
    expect(vendorForRole(plan, "implementer")).toBeUndefined();
    expect(rolesForVendor(plan, "cursor")).toEqual([]);
  });

  it("records an unavailable pinned lane as blocked, not as a silent grant", () => {
    const plan = assignRoles({
      chatId: "chat-1",
      lanes: [lane("codex", { health: "unavailable" })],
      roles: ["qa"],
      pinned: { qa: "codex" },
    });
    expect(plan.bindings[0]).toMatchObject({
      vendor: "codex",
      blocked: true,
      assignedBy: "human",
    });
    expect(vendorForRole(plan, "qa")).toBeUndefined();
  });

  it("leaves the role unfilled when the pinned vendor is not in the crew at all", () => {
    const plan = assignRoles({
      chatId: "chat-1",
      lanes: [lane("claude-code")],
      roles: ["qa"],
      pinned: { qa: "not-installed" },
    });
    expect(plan.bindings).toEqual([]);
    expect(plan.unfilled).toEqual(["qa"]);
  });
});

describe("roles no lane can hold land in unfilled", () => {
  it("separates the fillable from the unfillable in one plan", () => {
    // `cursor` streams but has no worktrees: it can review and scout, never
    // implement. Nothing else in the crew implements either.
    const plan = assignRoles({
      chatId: "chat-1",
      lanes: [
        lane("cursor", {
          capabilities: { ...FULL_CAPABILITIES, supportsWorktrees: false },
        }),
      ],
      roles: ["implementer", "docs", "reviewer", "scout"],
    });
    expect(plan.unfilled).toEqual(["implementer"]);
    expect(plan.bindings.map((binding) => binding.role)).toEqual([
      "reviewer",
      "docs",
      "scout",
    ]);
  });

  it("returns an empty plan, not a throw, when the crew is empty", () => {
    const plan = assignRoles({ chatId: "chat-1", lanes: [], roles: ["scout"] });
    expect(plan).toMatchObject({
      version: 1,
      chatId: "chat-1",
      bindings: [],
      unfilled: ["scout"],
    });
  });
});

describe("the reuse penalty spreads roles across healthy lanes", () => {
  it("hands the second role to the second lane when two are equally fit", () => {
    const plan = assignRoles({
      chatId: "chat-1",
      lanes: [lane("claude-code"), lane("codex")],
      roles: ["reviewer", "architect", "qa"],
    });
    // Bound in fixed priority order: reviewer → architect → qa. The penalty
    // pushes the second role onto the idle lane, then the tie-break returns to
    // the first lane once both hold one role.
    expect(
      plan.bindings.map((binding) => [binding.role, binding.vendor])
    ).toEqual([
      ["reviewer", "claude-code"],
      ["architect", "codex"],
      ["qa", "claude-code"],
    ]);
    expect(rolesForVendor(plan, "claude-code")).toEqual(["reviewer", "qa"]);
    expect(rolesForVendor(plan, "codex")).toEqual(["architect"]);
  });

  it("collapses onto one lane when the penalty is disabled (control)", () => {
    const plan = assignRoles({
      chatId: "chat-1",
      lanes: [lane("claude-code"), lane("codex")],
      roles: ["reviewer", "architect", "qa"],
      reusePenalty: 0,
    });
    expect(new Set(plan.bindings.map((binding) => binding.vendor))).toEqual(
      new Set(["claude-code"])
    );
  });

  it("still reuses a lane when the crew is smaller than the role list", () => {
    const plan = assignRoles({
      chatId: "chat-1",
      lanes: [lane("claude-code")],
      roles: [...READ_ONLY_ROLES],
    });
    // Reuse must remain POSSIBLE — the penalty is a preference, not a cap.
    expect(plan.bindings).toHaveLength(READ_ONLY_ROLES.length);
    expect(plan.unfilled).toEqual([]);
    expect(rolesForVendor(plan, "claude-code").sort()).toEqual(
      [...READ_ONLY_ROLES].sort()
    );
  });

  it("never lets the penalty drive a fit below zero or flip a block", () => {
    const plan = assignRoles({
      chatId: "chat-1",
      lanes: [lane("claude-code")],
      roles: [...AGENT_ROLES],
      reusePenalty: 5,
    });
    for (const binding of plan.bindings) {
      expect(binding.fit).toBeGreaterThanOrEqual(0);
      expect(binding.fit).toBeLessThanOrEqual(1);
      expect(binding.blocked).toBe(false);
    }
  });
});

describe("plan hygiene", () => {
  it("dedupes requested roles and ignores unknown ones", () => {
    const plan = assignRoles({
      chatId: "chat-1",
      lanes: [lane("claude-code")],
      roles: ["scout", "scout", "nonsense" as AgentRole],
    });
    expect(plan.bindings.map((binding) => binding.role)).toEqual(["scout"]);
  });

  it("defaults to the full role priority list when no roles are requested", () => {
    // NOTE: the AssignRolesInput JSDoc says the default is "the full taxonomy
    // minus orchestrator", but the implementation defaults to ROLE_PRIORITY,
    // which INCLUDES orchestrator. Pinned here so the discrepancy is visible
    // to a reviewer rather than silently drifting either way.
    const plan = assignRoles({
      chatId: "chat-1",
      lanes: [lane("claude-code")],
    });
    expect(plan.bindings.map((binding) => binding.role)).toEqual([
      "orchestrator",
      "implementer",
      "reviewer",
      "architect",
      "qa",
      "docs",
      "scout",
    ]);
  });

  it("carries a renderable reason on every binding", () => {
    const plan = assignRoles({
      chatId: "chat-1",
      lanes: [lane("claude-code"), lane("codex", { health: "degraded" })],
    });
    for (const binding of plan.bindings) {
      expect(binding.reason.length).toBeGreaterThan(0);
      expect(binding.reason.length).toBeLessThanOrEqual(400);
    }
  });

  it("prefers a cheap local lane for scouting and a capable one for writing", () => {
    const localCheap = lane("ollama", { cost: 0 });
    const frontier = lane("claude-code", { cost: 1 });
    expect(roleFit(localCheap, "scout").fit).toBeGreaterThan(
      roleFit(frontier, "scout").fit
    );
    expect(roleFit(frontier, "implementer").fit).toBeGreaterThan(
      roleFit(localCheap, "implementer").fit
    );
  });
});

describe("the operator preference tie-break (ADR-0022 §4 / Wave E)", () => {
  // Two lanes with IDENTICAL scores. Without a preference the winner is
  // construction order; with one, it is the operator's list — and that is the
  // ONLY thing the preference may change.
  const tied = (): LaneCandidate[] => [
    lane("claude-code", { roleAffinity: { docs: 0.7 }, cost: 0.5 }),
    lane("codex", { roleAffinity: { docs: 0.7 }, cost: 0.5 }),
  ];

  // One role only, so the decision IS the tie-break and not the reuse penalty.
  const roles: AgentRole[] = ["docs"];

  it("is byte-identical to construction order when absent", () => {
    const lanes = tied();
    expect(assignRoles({ chatId: "c", lanes, roles })).toEqual(
      assignRoles({ chatId: "c", lanes, roles, preference: [] })
    );
    expect(
      assignRoles({ chatId: "c", lanes, roles }).bindings.find(
        (b) => b.role === "docs"
      )?.vendor
    ).toBe("claude-code");
  });

  it("breaks a tie BEFORE construction order", () => {
    const lanes = tied();
    const plan = assignRoles({
      chatId: "c",
      lanes,
      roles,
      preference: ["codex"],
    });
    expect(plan.bindings.find((b) => b.role === "docs")?.vendor).toBe("codex");
  });

  it("NEVER grants: a preferred lane still cannot hold a role its ceiling refuses", () => {
    // The safety property. `preference` is consulted only among lanes that have
    // already passed `roleFit` unblocked, so naming a lane cannot admit it.
    const lanes = [
      lane("cursor", { supportedRoles: ["scout"] }),
      lane("codex"),
    ];
    const plan = assignRoles({
      chatId: "c",
      lanes,
      preference: ["cursor"],
      roles: ["implementer"],
    });
    expect(plan.bindings.find((b) => b.role === "implementer")?.vendor).toBe(
      "codex"
    );
    expect(plan.bindings.some((b) => b.vendor === "cursor")).toBe(false);
  });

  it("NEVER outranks fit: a preferred lane does not win a role it scores lower on", () => {
    const lanes = [
      lane("claude-code", { roleAffinity: { docs: 0.95 } }),
      lane("codex", { roleAffinity: { docs: 0.2 } }),
    ];
    const plan = assignRoles({
      chatId: "c",
      lanes,
      roles,
      preference: ["codex"],
    });
    expect(plan.bindings.find((b) => b.role === "docs")?.vendor).toBe(
      "claude-code"
    );
  });

  it("ignores an id no lane carries, and stays deterministic", () => {
    const lanes = tied();
    const plan = assignRoles({ chatId: "c", lanes, roles, preference: ["kiro"] });
    expect(plan).toEqual(assignRoles({ chatId: "c", lanes, roles }));
  });
});
