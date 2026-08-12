import {
  MUON_ATTACHED_COORDINATOR_TOOL_NAMES,
  MUON_CONTEXT_TOOL_NAMES,
  MUON_COORDINATION_TOOL_NAMES,
  MUON_DELEGATE_CAPABILITY_TOOL_NAMES,
  MUON_OBSERVER_TOOL_NAMES,
  MUON_ORCHESTRATOR_TOOL_NAMES,
} from "./mcp-tool-inventory.js";
import { narrowProfileForRole, type AgentRole } from "./agent-role.js";
import type { LaneProfile } from "./lane-profile.js";

/**
 * Next-wave feature #10 — does this agent actually hold the tools its work
 * needs?
 *
 * `capability_preflight` already answers "is a VENDOR ready" (installed,
 * authenticated, provider configured, runner alive). Every one of its reason
 * codes is about vendors and infrastructure. Nothing asks whether the AGENT
 * holds the TOOLS its brief requires, and that is a different failure with a
 * much quieter signature.
 *
 * The orchestrator field notes record it happening: three subagent definitions
 * had tool allowlists that excluded MCP entirely, so the standing instruction
 * "always use the code graph" was unenforceable *for exactly the agents whose
 * job is judgment*. One hand-traced and said so; another died on its first
 * move. Both were only caught by a human reading the output carefully.
 *
 * This REPORTS, it does not refuse. The field notes ask for precisely that:
 * an agent should be told "you were asked to use the graph and cannot",
 * loudly, rather than silently degrading into grep. The completion gates that
 * already fail closed (preflight coverage, review evidence) are unchanged — the
 * point is to turn a confusing late failure into a clear early one.
 */

/** The tools an agent receives, by the capability mode it runs under. */
export function grantedToolNames(
  capabilityMode: string | null | undefined
): readonly string[] {
  switch (capabilityMode) {
    case "orchestrator":
      return MUON_ORCHESTRATOR_TOOL_NAMES;
    // Tier C is NOT the orchestrator tier: it adds the observer reads but holds
    // only a narrower slice of the control verbs. Collapsing the two would make
    // `whoami` claim `set_fleet` for a seat that cannot call it.
    case "attached-coordinator":
      return MUON_ATTACHED_COORDINATOR_TOOL_NAMES;
    case "delegate":
      return MUON_DELEGATE_CAPABILITY_TOOL_NAMES;
    default:
      // A plain worker holds context + coordination. Deliberately the DEFAULT
      // rather than a named case: an unrecognised mode must resolve to the
      // narrowest real set, never to "everything" (ADR-0022's rule that a set
      // is derived positively, so an unknown arrival lands on the narrow side).
      return [...MUON_CONTEXT_TOOL_NAMES, ...MUON_COORDINATION_TOOL_NAMES];
  }
}

export type ToolCapabilityGap = {
  /** Declared as required by the harness and NOT granted to this agent. */
  readonly missing: readonly string[];
  /** Required names that are not MUON tools at all — a harness typo. */
  readonly unknown: readonly string[];
  readonly satisfied: boolean;
};

/**
 * Every tool name MUON can grant, across all tiers — the union of the tier
 * inventories themselves, so a tool added to any tier is automatically known
 * here and cannot be misreported as a harness typo.
 */
function everyKnownTool(): Set<string> {
  return new Set<string>([
    ...MUON_ORCHESTRATOR_TOOL_NAMES,
    ...MUON_ATTACHED_COORDINATOR_TOOL_NAMES,
    ...MUON_DELEGATE_CAPABILITY_TOOL_NAMES,
    ...MUON_CONTEXT_TOOL_NAMES,
    ...MUON_COORDINATION_TOOL_NAMES,
    // Observer-only names too: a tool this union forgets gets classified
    // `unknown` ("a harness mistake, not something you can work around") when
    // it is really `missing` — the one confusion this module must never make.
    ...MUON_OBSERVER_TOOL_NAMES,
  ]);
}

/**
 * Mirrors `MUON_MCP_TOOL_PREFIX` in packages/adapters. A profile spells a MUON
 * tool with the vendor's server prefix (`mcp__muon__code_query`); the
 * inventories here use the bare name. Restated rather than imported because
 * protocol must not depend on adapters.
 */
const MCP_SERVER_NAME = "muon";
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** `mcp__muon__code_query` → `code_query`; a bare name passes through. */
function bareToolName(rule: string): string {
  return rule.startsWith(MCP_TOOL_PREFIX)
    ? rule.slice(MCP_TOOL_PREFIX.length)
    : rule;
}

/**
 * Vendors whose compiled profile actually removes a MUON tool when
 * `deniedTools` names it. POSITIVE by construction (ADR-0022 rule 2): a vendor
 * added later honours nothing here until someone says it does, so a new lane
 * cannot silently start producing gap claims MUON cannot substantiate.
 *
 * Source of truth is `packages/adapters/src/profile-compiler.ts`:
 *   claude  → SDK `disallowedTools` + `--disallowedTools`   (honoured)
 *   codex   → `mcp_servers.muon.disabled_tools`             (honoured)
 *   cursor  → `.cursor/cli.json` `permissions.deny`         (honoured)
 *   opencode→ deniedTools is reported UNSUPPORTED; the permission table is
 *             hardcoded, so a denial reaches nothing                (ignored)
 *
 * An opencode lane that "denies" a MUON tool still holds it. Reporting a gap
 * there would be a warning that is simply false, which costs more credibility
 * than the silence it replaces.
 */
export const VENDORS_HONORING_MCP_DENIALS = [
  "claude",
  "codex",
  "cursor",
] as const;

/** Cursor spells a scoped MCP denial `Mcp(server)` or `Mcp(server:tool)`. */
const CURSOR_MCP_RULE = /^Mcp\(\s*([A-Za-z0-9_-]+)\s*(?::\s*([A-Za-z0-9_*-]+)\s*)?\)$/;

/**
 * Tools a lane profile takes AWAY. Only `deniedTools` is read, never
 * `allowedTools`: on this codebase `allowedTools` is a PRE-AUTHORIZATION list
 * (what runs without asking), not an exhaustive allowlist, so "absent from
 * allowedTools" means "must ask", not "cannot call". Treating absence as a
 * denial would report a gap on essentially every dispatch — and a warning that
 * fires always is a warning nobody reads.
 *
 * A BARE tool name (`code_query`) is deliberately NOT read as a MUON denial.
 * No vendor honours it as one: claude and codex both require the
 * `mcp__muon__` coordinate, and cursor requires the `Mcp(...)` form. Treating
 * a bare name as a denial would invent a gap on every one of them.
 */
function deniedToolNames(deniedTools: readonly string[] | undefined): {
  names: Set<string>;
  prefixes: string[];
  allMuonDenied: boolean;
} {
  const names = new Set<string>();
  const prefixes: string[] = [];
  let allMuonDenied = false;
  for (const rule of deniedTools ?? []) {
    const trimmed = rule.trim();
    if (trimmed === "") continue;

    const cursorRule = CURSOR_MCP_RULE.exec(trimmed);
    if (cursorRule) {
      if (cursorRule[1] !== MCP_SERVER_NAME) continue;
      const tool = cursorRule[2];
      // `Mcp(muon)` — the whole server — or `Mcp(muon:*)`.
      if (!tool || tool === "*") {
        allMuonDenied = true;
      } else if (tool.endsWith("*")) {
        prefixes.push(tool.slice(0, -1));
      } else {
        names.add(tool);
      }
      continue;
    }

    if (!trimmed.startsWith("mcp__")) continue;

    if (trimmed.endsWith("*")) {
      const stem = trimmed.slice(0, -1);
      // Anything that matches at or above the server coordinate takes the
      // whole server with it: `mcp__*`, `mcp__mu*`, `mcp__muon*`,
      // `mcp__muon__*`. This is the "excluded MCP entirely" spelling from the
      // field notes, and the one an earlier revision of this file missed.
      if (MCP_TOOL_PREFIX.startsWith(stem)) {
        allMuonDenied = true;
      } else if (stem.startsWith(MCP_TOOL_PREFIX)) {
        prefixes.push(stem.slice(MCP_TOOL_PREFIX.length));
      }
      // A wildcard under a DIFFERENT server denies nothing of ours.
      continue;
    }

    if (trimmed === `mcp__${MCP_SERVER_NAME}`) {
      allMuonDenied = true;
      continue;
    }
    if (trimmed.startsWith(MCP_TOOL_PREFIX)) {
      names.add(trimmed.slice(MCP_TOOL_PREFIX.length));
    }
  }
  return { names, prefixes, allMuonDenied };
}

/**
 * Compare what a harness says it needs against what this agent will hold.
 *
 * `unknown` is reported separately from `missing` because they need opposite
 * responses: a missing tool is a real capability gap the agent must work
 * around, while an unknown name is a mistake in the harness that no dispatch
 * can fix. Collapsing them would tell an agent to route around a typo.
 *
 * Two things can remove a tool, and both are checked: the capability tier
 * never granted it, or the resolved lane profile denied it. The second is the
 * one the field notes actually hit.
 */
export function toolCapabilityGap(
  requiredTools: readonly string[],
  capabilityMode: string | null | undefined,
  profile?: { deniedTools?: readonly string[]; vendor?: string | null }
): ToolCapabilityGap {
  const granted = new Set(grantedToolNames(capabilityMode));
  // A denial is only evidence of a gap on a vendor that HONOURS denials.
  // Reading opencode's ignored deniedTools would tell an agent it lacks a tool
  // it demonstrably holds.
  const honorsDenials = (VENDORS_HONORING_MCP_DENIALS as readonly string[]).includes(
    profile?.vendor ?? ""
  );
  const denied = honorsDenials
    ? deniedToolNames(profile?.deniedTools)
    : { names: new Set<string>(), prefixes: [], allMuonDenied: false };
  if (denied.allMuonDenied) {
    granted.clear();
  } else {
    for (const name of denied.names) {
      granted.delete(name);
    }
    for (const prefix of denied.prefixes) {
      for (const name of [...granted]) {
        if (name.startsWith(prefix)) granted.delete(name);
      }
    }
  }
  const known = everyKnownTool();
  const missing: string[] = [];
  const unknown: string[] = [];
  for (const tool of requiredTools) {
    // A harness may spell either way; compare on the bare name.
    const name = bareToolName(tool.trim());
    if (name === "") continue;
    if (!known.has(name)) {
      unknown.push(name);
    } else if (!granted.has(name)) {
      missing.push(name);
    }
  }
  return {
    missing,
    unknown,
    satisfied: missing.length === 0 && unknown.length === 0,
  };
}

/**
 * The line an agent reads. Names what it cannot reach and what that means for
 * its report — never an instruction to proceed regardless, and never a
 * suggestion that the missing tool can be obtained (it cannot, from here).
 */
export function describeToolGap(gap: ToolCapabilityGap): string | undefined {
  if (gap.satisfied) return undefined;
  const parts: string[] = [];
  if (gap.missing.length > 0) {
    parts.push(
      `this job's harness asks for ${gap.missing.join(", ")}, which this session does not hold`
    );
  }
  if (gap.unknown.length > 0) {
    parts.push(
      `it also names ${gap.unknown.join(", ")}, which are not MUON tools at all (a harness mistake, not something you can work around)`
    );
  }
  return parts.join("; ");
}

/**
 * The gap for one dispatch, computed against the profile the agent will
 * ACTUALLY run under.
 *
 * This exists as a named function rather than an expression at the call site
 * because the "which profile" decision is the part that was wrong first: an
 * earlier revision read the harness-overlaid profile and a comment claimed it
 * was already role-narrowed. It was not, and nothing tested it. A reviewer
 * caught it by reading the ordering in `execute.ts`.
 *
 * Role narrowing has to happen LAST in the runner (it is the final authority
 * reduction), so this recomputes it here off the same pure function purely to
 * read the resulting deny list, and discards the narrowed profile.
 */
export function dispatchToolGap(input: {
  requiredTools: readonly string[];
  capabilityMode: string | null | undefined;
  profile: LaneProfile;
  role?: AgentRole | undefined;
  vendor?: string | null;
}): ToolCapabilityGap {
  const effective = input.role
    ? narrowProfileForRole(input.profile, input.role)
    : input.profile;
  return toolCapabilityGap(input.requiredTools, input.capabilityMode, {
    deniedTools: effective.deniedTools,
    vendor: input.vendor,
  });
}
