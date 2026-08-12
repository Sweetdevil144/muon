import { describe, expect, it } from "vitest";
import {
  MUON_ATTACHED_COORDINATOR_CONTROL_REMAINDER,
  MUON_ATTACHED_COORDINATOR_TOOL_NAMES,
  MUON_CONTEXT_TOOL_NAMES,
  MUON_COORDINATION_TOOL_NAMES,
  MUON_DELEGATE_CAPABILITY_TOOL_NAMES,
  MUON_ORCHESTRATOR_TOOL_NAMES,
  describeToolGap,
  dispatchToolGap,
  grantedToolNames,
  laneProfileSchema,
  toolCapabilityGap,
} from "../src/index.js";

// Feature #10. The failure being closed: a specialist whose whole job is
// judgment had an allowlist that excluded MCP, so "always use the code graph"
// was unenforceable and the degrade into grep was silent. These assertions are
// about the gap being NAMED, and about the naming never becoming authority.

describe("the gap is computed against what this session actually holds", () => {
  it("names a required tool a worker does not hold", () => {
    // `dispatch` is a control verb; a worker never holds it.
    const gap = toolCapabilityGap(["code_query", "dispatch"], "worker");
    expect(gap.missing).toEqual(["dispatch"]);
    expect(gap.satisfied).toBe(false);
    expect(describeToolGap(gap)).toContain("dispatch");
  });

  it("is satisfied when every required tool is granted", () => {
    const gap = toolCapabilityGap(["code_query", "peer_message"], "worker");
    expect(gap).toMatchObject({ missing: [], unknown: [], satisfied: true });
    // A satisfied gap adds NO line: a preamble that reassures on every dispatch
    // trains agents to skip the block on the one dispatch that matters.
    expect(describeToolGap(gap)).toBeUndefined();
  });

  it("requires nothing by default, so no existing harness grows a gap", () => {
    expect(toolCapabilityGap([], "worker").satisfied).toBe(true);
    expect(toolCapabilityGap([], null).satisfied).toBe(true);
  });

  it("ignores blank entries rather than reporting an empty name as missing", () => {
    expect(toolCapabilityGap(["  ", ""], "worker").satisfied).toBe(true);
    expect(toolCapabilityGap([" code_query "], "worker").satisfied).toBe(true);
  });
});

describe("an unknown name is a harness mistake, not a capability gap", () => {
  it("separates the two, because they need opposite responses", () => {
    const gap = toolCapabilityGap(["code_graph_query", "dispatch"], "worker");
    // Collapsing these would tell an agent to route around a typo.
    expect(gap.unknown).toEqual(["code_graph_query"]);
    expect(gap.missing).toEqual(["dispatch"]);
    const described = describeToolGap(gap)!;
    expect(described).toMatch(/not MUON tools at all/);
  });

  it("knows every tool any tier can grant, including control verbs", () => {
    // `set_fleet` is granted to no mode an agent runs under, but it IS a MUON
    // tool; reporting it as a typo would be wrong.
    for (const name of MUON_ATTACHED_COORDINATOR_CONTROL_REMAINDER) {
      expect(toolCapabilityGap([name], "worker").unknown, name).toEqual([]);
    }
  });
});

describe("an unrecognised mode lands on the NARROW side", () => {
  it("gives an unknown mode the base tier, never everything", () => {
    // ADR-0022's rule: a set is derived positively, so a mode nobody
    // anticipated must not arrive holding control verbs.
    for (const mode of ["", "supervisor", "root", null, undefined]) {
      const granted = grantedToolNames(mode);
      expect(granted, String(mode)).not.toContain("dispatch");
      expect(granted, String(mode)).toContain("code_query");
    }
  });

  it("does not treat an attached coordinator as an orchestrator", () => {
    // Tier C holds the observer reads but only a slice of the control verbs.
    // Collapsing them would make whoami claim `set_fleet` for a seat that
    // cannot call it.
    const attached = grantedToolNames("attached-coordinator");
    expect(attached).toContain("fleet_status");
    expect(attached).toContain("dispatch");
    expect(attached).not.toContain("set_fleet");
    expect(MUON_ORCHESTRATOR_TOOL_NAMES).toContain("set_fleet");
  });

  it("gives a delegate the base tier plus delegate, and no control verb", () => {
    const granted = grantedToolNames("delegate");
    expect(granted).toContain("delegate");
    expect(granted).toContain("code_query");
    expect(granted).not.toContain("dispatch");
  });
});

describe("declaring a tool grants nothing", () => {
  it("a harness naming a control verb still does not receive it", () => {
    // The load-bearing property: `requires.tools` is a DECLARATION. If this
    // ever widened a tier it would be an authority path through a config file.
    const before = [...grantedToolNames("worker")];
    toolCapabilityGap(["dispatch", "ship", "steer"], "worker");
    expect([...grantedToolNames("worker")]).toEqual(before);
    expect(grantedToolNames("worker")).not.toContain("dispatch");
  });

  it("never returns MORE than the tier grants, whatever a harness declares", () => {
    // This replaces a regex over export NAMES, which proved far less than it
    // claimed: it passed with the behaviour removed and would pass for a
    // widening function named anything outside the pattern. The property that
    // actually matters is that no declaration adds to the granted set, so
    // assert it against the set itself.
    for (const mode of ["worker", "delegate", "orchestrator"]) {
      const tier = new Set(grantedToolNames(mode));
      const declared = [
        "dispatch",
        "ship",
        "steer",
        "set_fleet",
        "raise_budget",
        "delegate",
      ];
      const gap = toolCapabilityGap(declared, mode);
      // Every declared name is either granted ALREADY by the tier, or comes
      // back reported as missing. There is no third outcome in which naming it
      // made it available.
      for (const name of declared) {
        const wasGranted = tier.has(name);
        expect(
          wasGranted || gap.missing.includes(name),
          `${mode}/${name}`
        ).toBe(true);
      }
      expect(new Set(grantedToolNames(mode))).toEqual(tier);
    }
  });
});

describe("the sentence an agent reads", () => {
  it("never suggests proceeding as if the tool had been used", () => {
    const gap = toolCapabilityGap(["dispatch", "nonsense_tool"], "worker");
    const described = describeToolGap(gap)!;
    expect(described).not.toMatch(/ignore|proceed anyway|assume|pretend|skip/i);
  });

  it("names the missing tool, so the report can name it too", () => {
    const described = describeToolGap(
      toolCapabilityGap(["dispatch"], "worker")
    )!;
    expect(described).toContain("dispatch");
    expect(described).toContain("does not hold");
  });
});

describe("the tier map is anchored to the real inventories", () => {
  // An earlier version of this block asserted that every tool in
  // `grantedToolNames(mode)` satisfies `toolCapabilityGap([tool], mode)` and
  // called it "whoami and the gap check agree by construction". It was a pure
  // tautology — `toolCapabilityGap` CALLS `grantedToolNames` — and it never
  // touched whoami at all. Deleted rather than kept as decoration; what
  // follows asserts something that can actually fail.

  it("returns the exported inventory itself for each named mode", () => {
    expect(grantedToolNames("orchestrator")).toEqual(
      MUON_ORCHESTRATOR_TOOL_NAMES
    );
    expect(grantedToolNames("attached-coordinator")).toEqual(
      MUON_ATTACHED_COORDINATOR_TOOL_NAMES
    );
    expect(grantedToolNames("delegate")).toEqual(
      MUON_DELEGATE_CAPABILITY_TOOL_NAMES
    );
    expect(grantedToolNames("worker")).toEqual([
      ...MUON_CONTEXT_TOOL_NAMES,
      ...MUON_COORDINATION_TOOL_NAMES,
    ]);
  });

  it("classifies an observer-only tool as MISSING, not as a typo", () => {
    // `everyKnownTool` once omitted the observer tier, which made a real
    // capability gap read as "not a MUON tool at all — a harness mistake" —
    // the single confusion this module says it must never make.
    const gap = toolCapabilityGap(["fleet_status"], "worker");
    expect(gap.missing).toEqual(["fleet_status"]);
    expect(gap.unknown).toEqual([]);
  });

  it("keeps whoami itself in the base tier — every agent can ask", () => {
    expect(MUON_CONTEXT_TOOL_NAMES).toContain("whoami");
    expect(grantedToolNames("worker")).toContain("whoami");
    expect(grantedToolNames("delegate")).toContain("whoami");
  });
});

describe("a profile that denies a MUON tool is the failure the field notes hit", () => {
  const claude = (deniedTools: string[]) => ({ deniedTools, vendor: "claude" });

  it("names a tool the tier granted but the profile denied", () => {
    // The specialist definitions did not lose MCP to MUON's tier — they lost it
    // on their own allowlists, which is why nothing upstream noticed.
    const gap = toolCapabilityGap(
      ["code_query"],
      "worker",
      claude(["mcp__muon__code_query"])
    );
    expect(gap.missing).toEqual(["code_query"]);
    expect(describeToolGap(gap)).toContain("code_query");
  });

  it("catches EVERY wildcard that reaches the server coordinate", () => {
    // The review's H1. An earlier revision recognised exactly two spellings —
    // `mcp__muon__*` and `mcp__muon` — and silently dropped every other
    // wildcard, including `mcp__*`, which is the literal "excluded MCP
    // entirely" form from the field notes this feature exists for.
    for (const rule of [
      "mcp__*",
      "mcp__mu*",
      "mcp__muon*",
      "mcp__muon__*",
      "mcp__muon",
    ]) {
      const gap = toolCapabilityGap(
        ["code_query", "review_diff"],
        "worker",
        claude([rule])
      );
      expect(gap.missing, rule).toEqual(["code_query", "review_diff"]);
    }
  });

  it("honours a PREFIX wildcard under the server", () => {
    // `mcp__muon__code_*` kills code_query/code_context/code_impact — two of
    // which the `review` harness declares.
    const gap = toolCapabilityGap(
      ["code_query", "code_impact", "review_diff"],
      "worker",
      claude(["mcp__muon__code_*"])
    );
    expect(gap.missing).toEqual(["code_query", "code_impact"]);
  });

  it("decodes cursor's scoped Mcp(...) deny form", () => {
    // `compileCursorProfile` writes deniedTools verbatim into
    // .cursor/cli.json permissions.deny, and `Mcp(server:tool)` is MUON's own
    // documented cursor spelling (ADR-0013, ADR-0019).
    const cursor = (deniedTools: string[]) => ({ deniedTools, vendor: "cursor" });
    expect(
      toolCapabilityGap(["code_query"], "worker", cursor(["Mcp(muon:code_query)"]))
        .missing
    ).toEqual(["code_query"]);
    expect(
      toolCapabilityGap(["code_query", "review_diff"], "worker", cursor(["Mcp(muon)"]))
        .missing
    ).toEqual(["code_query", "review_diff"]);
    // A different server's denial takes nothing of ours.
    expect(
      toolCapabilityGap(["code_query"], "worker", cursor(["Mcp(other:code_query)"]))
        .satisfied
    ).toBe(true);
  });

  it("does NOT read a bare tool name as a denial", () => {
    // No vendor honours one: claude and codex both need the mcp__muon__
    // coordinate and cursor needs Mcp(...). An earlier revision treated a bare
    // name as a denial, which invents a gap on every one of them.
    expect(
      toolCapabilityGap(["code_query"], "worker", claude(["code_query"])).satisfied
    ).toBe(true);
  });

  it("does NOT read allowedTools, because absence there means must-ask", () => {
    // On this codebase `allowedTools` is a PRE-AUTHORIZATION list. If absence
    // counted as a denial, every dispatch would carry a gap block and the
    // warning would stop being read.
    expect(toolCapabilityGap(["code_query"], "worker", claude([])).satisfied).toBe(
      true
    );
  });

  it("ignores an unrelated denial", () => {
    const gap = toolCapabilityGap(
      ["code_query"],
      "worker",
      claude(["Write", "Edit", "WebFetch", "mcp__other__code_query", "mcp__other__*"])
    );
    expect(gap.satisfied).toBe(true);
  });
});

describe("a denial only counts on a vendor that honours it", () => {
  it("reports NO gap on opencode, whose deniedTools reaches nothing", () => {
    // The review's M7. `compileOpencodeProfile` reports deniedTools as
    // unsupported and `buildOpencodePermissionTable()` takes no arguments — it
    // hardcodes the table. A gap block there would assert the agent lacks a
    // tool it demonstrably holds, which is worse than silence.
    const gap = toolCapabilityGap(["code_query"], "worker", {
      deniedTools: ["mcp__muon__code_query", "mcp__*"],
      vendor: "opencode",
    });
    expect(gap.satisfied).toBe(true);
  });

  it("reports no gap for an unknown vendor, rather than guessing", () => {
    // Positive list: a vendor added later honours nothing until someone says
    // so, and MUON does not claim a gap it cannot substantiate.
    for (const vendor of [undefined, null, "", "some-new-vendor"]) {
      expect(
        toolCapabilityGap(["code_query"], "worker", {
          deniedTools: ["mcp__muon__code_query"],
          vendor,
        }).satisfied,
        String(vendor)
      ).toBe(true);
    }
  });

  it("still reports a TIER gap regardless of vendor", () => {
    // Vendor-honouring gates the DENIAL reading only. A tool the tier never
    // granted is missing on every vendor.
    expect(
      toolCapabilityGap(["dispatch"], "worker", {
        deniedTools: [],
        vendor: "opencode",
      }).missing
    ).toEqual(["dispatch"]);
  });
});

describe("dispatchToolGap reads the profile the agent will actually run under", () => {
  const baseProfile = laneProfileSchema.parse({});

  it("applies ROLE narrowing, which is what removes write-class MUON tools", () => {
    // The review's M3. The runner computed the gap from the harness-overlaid
    // profile while a comment claimed the narrowing was already applied — and
    // the narrowing is precisely what deletes memory_delete/memory_clone for a
    // read-only role. Nothing tested it because the decision was an inline
    // expression; it is a named function now so this can fail.
    // `narrowProfileForRole` moves every write-class entry of `allowedTools`
    // into `deniedTools` for a read-only role, and `isWriteClassTool`
    // classifies `mcp__muon__memory_delete`. So a lane that pre-authorized it
    // loses it entirely under `reviewer`.
    const profile = laneProfileSchema.parse({
      allowedTools: ["mcp__muon__memory_delete", "mcp__muon__code_query"],
    });
    const withGap = dispatchToolGap({
      requiredTools: ["memory_delete"],
      capabilityMode: "worker",
      profile,
      role: "reviewer",
      vendor: "claude",
    });
    expect(withGap.missing).toEqual(["memory_delete"]);

    // Same profile with no role keeps the tool, so the assertion above is about
    // the narrowing and not about the tool being unavailable anyway.
    const noRole = dispatchToolGap({
      requiredTools: ["memory_delete"],
      capabilityMode: "worker",
      profile,
      vendor: "claude",
    });
    expect(noRole.satisfied).toBe(true);
  });

  it("does not narrow for a write-authority role", () => {
    expect(
      dispatchToolGap({
        requiredTools: ["memory_delete"],
        capabilityMode: "worker",
        profile: laneProfileSchema.parse({
          allowedTools: ["mcp__muon__memory_delete"],
        }),
        role: "implementer",
        vendor: "claude",
      }).satisfied
    ).toBe(true);
  });

  it("still honours a profile denial on top of the narrowing", () => {
    expect(
      dispatchToolGap({
        requiredTools: ["code_query"],
        capabilityMode: "worker",
        profile: { ...baseProfile, deniedTools: ["mcp__muon__code_query"] },
        role: "reviewer",
        vendor: "claude",
      }).missing
    ).toEqual(["code_query"]);
  });

  it("leaves the caller's profile untouched", () => {
    // It narrows to READ a deny list and must not hand back a mutated profile
    // the runner would then dispatch with.
    const profile = laneProfileSchema.parse({
      allowedTools: ["mcp__muon__memory_delete"],
    });
    const before = JSON.stringify(profile);
    dispatchToolGap({
      requiredTools: ["memory_delete"],
      capabilityMode: "worker",
      profile,
      role: "reviewer",
      vendor: "claude",
    });
    expect(JSON.stringify(profile)).toBe(before);
  });
});
