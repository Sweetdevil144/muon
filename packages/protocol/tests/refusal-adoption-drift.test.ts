import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REFUSAL_RULES, type RefusalRule } from "../src/refusal.js";

/**
 * ADR-0033 D5 — the enum and the enforcement sites are pinned to each other.
 *
 * Adoption is deliberately incremental: an un-migrated site keeps returning
 * today's message and the typed path is additive. What must NOT happen is the
 * enum drifting away from reality in either direction — a rule nobody produces
 * looks like coverage that does not exist, and a producer nobody declared is a
 * refusal no surface can render.
 *
 * So: every rule is either ADOPTED (a producer exists in the tree) or listed in
 * PENDING with the site that will produce it. Both lists are asserted against
 * what is actually in the source, so removing a producer or adding a rule
 * without deciding its status fails here.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Rules with a live producer today. */
const ADOPTED: RefusalRule[] = [
  "ship.review_blind",
  "ship.review_unavailable",
  "role.ceiling",
  "role.profile_exceeds",
  // ADR-0034's a2a wait route refuses an out-of-chat peer with this rule.
  "partition.mismatch",
  // ADR-0036 wired the delegation caps as typed refusals.
  "delegation.depth",
  "delegation.children",
  "delegation.descendants",
  // Round-3 #4: the client's a2aJson turns a version-skewed envelope into
  // this refusal instead of a generic parse error.
  "protocol.version_skew",
  // ADR-0045 D5: the workflow-amendment routes refuse a run whose status
  // cannot gain a step, naming the actual status and the lawful way forward.
  "workflow.not_amendable",
];

/** Rules declared ahead of their enforcement site, with where they belong. */
const PENDING: Record<Exclude<RefusalRule, (typeof ADOPTED)[number]>, string> = {
  "capability.tier": "backend capability middleware",
  "capability.job_mismatch": "backend exact-job capability check",
  "capability.expired": "backend capability lease check",
  "mcp.tool_not_in_tier": "packages/mcp tier inventory gate",
  "mcp.server_denied": "packages/mcp deny-first server composition",
  "budget.exhausted": "backend dispatch budget check",
  "preedit.impact_high": "packages/mcp preflight_edit fail-closed branch",
  "preedit.index_stale": "packages/mcp preflight_edit staleness branch",
};

/** Rule ids that appear in a `buildRefusal({ rule: "..." })` call in src. */
function producedRules(): Set<string> {
  let out = "";
  try {
    out = execFileSync(
      "grep",
      [
        "-rho",
        "--include=*.ts",
        "--include=*.tsx",
        "--exclude-dir=node_modules",
        "--exclude-dir=dist",
        "--exclude-dir=.muon",
        "--exclude-dir=tests",
        String.raw`rule: "[a-z]*\.[a-z_]*"`,
        join(REPO_ROOT, "packages"),
        join(REPO_ROOT, "apps"),
        join(REPO_ROOT, "backend", "src"),
      ],
      { encoding: "utf8" }
    );
  } catch {
    // grep exits non-zero when nothing matches; an empty set is a real answer.
  }
  const found = new Set<string>();
  for (const line of out.split("\n")) {
    const match = /rule: "([a-z]+\.[a-z_]+)"/.exec(line);
    if (match?.[1] && match[1] in REFUSAL_RULES) found.add(match[1]);
  }
  return found;
}

describe("ADR-0033 D5 — refusal adoption drift-lock", () => {
  const declared = Object.keys(REFUSAL_RULES) as RefusalRule[];

  it("classifies every declared rule as adopted or pending, exactly once", () => {
    for (const rule of declared) {
      const isAdopted = ADOPTED.includes(rule);
      const isPending = rule in PENDING;
      expect(
        isAdopted !== isPending,
        `${rule} must be in exactly one of ADOPTED / PENDING`
      ).toBe(true);
    }
    expect(ADOPTED.length + Object.keys(PENDING).length).toBe(declared.length);
  });

  it("every ADOPTED rule really has a producer in the tree", () => {
    // Catches a producer being deleted or renamed without updating this list —
    // otherwise the enum would advertise coverage that no longer exists.
    const produced = producedRules();
    for (const rule of ADOPTED) {
      expect(produced, `${rule} is listed ADOPTED but nothing produces it`).toContain(
        rule
      );
    }
  });

  it("every PENDING rule names the site that will produce it", () => {
    for (const [rule, site] of Object.entries(PENDING)) {
      expect(site.length, `${rule} has no destination site`).toBeGreaterThan(8);
    }
  });

  it("a rule that gained a producer is no longer listed PENDING", () => {
    // The other direction: when a site adopts a rule, this fails until the
    // lists are updated, so PENDING cannot quietly become a lie.
    const produced = producedRules();
    for (const rule of Object.keys(PENDING)) {
      expect(
        produced,
        `${rule} now has a producer — move it from PENDING to ADOPTED`
      ).not.toContain(rule);
    }
  });
});
