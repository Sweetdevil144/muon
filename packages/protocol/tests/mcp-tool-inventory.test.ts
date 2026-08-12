import { describe, expect, it } from "vitest";
import {
  MUON_ATTACHED_COORDINATOR_CONTROL_REMAINDER,
  MUON_ATTACHED_COORDINATOR_CONTROL_TOOL_NAMES,
  MUON_ATTACHED_COORDINATOR_TOOL_NAMES,
  MUON_CONTEXT_TOOL_NAMES,
  MUON_CONTROL_TOOL_NAMES,
  MUON_COORDINATION_TOOL_NAMES,
  MUON_DELEGATE_CAPABILITY_TOOL_NAMES,
  MUON_DELEGATE_TOOL_NAMES,
  MUON_OBSERVER_TOOL_NAMES,
  MUON_ORCHESTRATOR_TOOL_NAMES,
} from "../src/index.js";

describe("canonical MUON MCP tool inventory", () => {
  it("keeps context tools in their exact canonical order", () => {
    expect(MUON_CONTEXT_TOOL_NAMES).toEqual([
      "memory_search",
      "memory_recall",
      "memory_neighbors",
      "memory_explain",
      "memory_delete",
      "memory_clone",
      "memory_add",
      "memory_preedit",
      "impact_memory",
      "preflight_edit",
      "task_context",
      "handoff_read",
      "code_query",
      "code_context",
      "code_impact",
      "repo_map",
      "review_diff",
      "data_boundaries",
      "flow_scope",
      "capability_preflight",
      "whoami",
    ]);
  });

  it("keeps the A2A coordination tier in its exact canonical order", () => {
    expect(MUON_COORDINATION_TOOL_NAMES).toEqual([
      "publish_finding",
      "peer_message",
      "peer_inbox",
      "peer_wait",
      "claim_files",
      "release_files",
      // ADR-0043: ask-a-human + read the answer. Deliberate widening of the
      // worker tier by two POWERLESS tools (no authority, no clock, no
      // budget) — updated here consciously, which is this pin's whole job.
      "question_ask",
      "question_status",
      "crew_roles",
    ]);
  });

  it("keeps control tools in their exact canonical order", () => {
    expect(MUON_CONTROL_TOOL_NAMES).toEqual([
      "assign_roles",
      "fleet_status",
      "set_fleet",
      "create_task",
      "list_tasks",
      "dispatch",
      "read_stream",
      "dispatch_status",
      "budget_status",
      "raise_budget",
      "steer",
      "interrupt",
      "propose_workflow",
      "apply_workflow",
      "workflow_status",
      "ship",
      "check_approval",
    ]);
  });

  it("gives every worker the coordination tier without any control tool", () => {
    // A delegated child may coordinate horizontally, but the grant must stay
    // strictly context + coordination + delegate — never a control verb.
    expect(MUON_DELEGATE_CAPABILITY_TOOL_NAMES).toEqual([
      ...MUON_CONTEXT_TOOL_NAMES,
      ...MUON_COORDINATION_TOOL_NAMES,
      ...MUON_DELEGATE_TOOL_NAMES,
    ]);
    expect(
      MUON_DELEGATE_CAPABILITY_TOOL_NAMES.some((name) =>
        MUON_CONTROL_TOOL_NAMES.includes(
          name as (typeof MUON_CONTROL_TOOL_NAMES)[number]
        )
      )
    ).toBe(false);
    // The write side of role assignment stays control-tier; only the read side
    // reaches a worker.
    expect(MUON_COORDINATION_TOOL_NAMES).toContain("crew_roles");
    expect(MUON_COORDINATION_TOOL_NAMES).not.toContain("assign_roles");
    expect(MUON_CONTROL_TOOL_NAMES).toContain("assign_roles");
  });

  it("combines 47 unique exact identifiers without broad or wildcard entries", () => {
    expect(MUON_ORCHESTRATOR_TOOL_NAMES).toEqual([
      ...MUON_CONTEXT_TOOL_NAMES,
      ...MUON_COORDINATION_TOOL_NAMES,
      ...MUON_CONTROL_TOOL_NAMES,
    ]);
    expect(MUON_CONTEXT_TOOL_NAMES).toHaveLength(21);
    // 9 = 6 + ADR-0043's question_ask/question_status + publish_finding (deliberate widening).
    expect(MUON_COORDINATION_TOOL_NAMES).toHaveLength(9);
    expect(MUON_CONTROL_TOOL_NAMES).toHaveLength(17);
    expect(MUON_ORCHESTRATOR_TOOL_NAMES).toHaveLength(47);
    expect(new Set(MUON_ORCHESTRATOR_TOOL_NAMES).size).toBe(47);
    expect(
      MUON_ORCHESTRATOR_TOOL_NAMES.every((name) =>
        /^[a-z][a-z0-9_]*$/.test(name)
      )
    ).toBe(true);
    expect(
      MUON_ORCHESTRATOR_TOOL_NAMES.some(
        (name) => name.includes("*") || name === "muon" || name === "mcp__muon"
      )
    ).toBe(false);
  });
});

// ── ADR-0028 Tier C: the attached (external, non-hermetic) coordinator ──────
//
// Tier C is Tier A (context + coordination) plus Tier B (observer) plus
// exactly seven control verbs, stated POSITIVELY (ADR-0022 rule 2) in
// `MUON_ATTACHED_COORDINATOR_CONTROL_TOOL_NAMES`. This block pins:
//   1. `MUON_ATTACHED_COORDINATOR_TOOL_NAMES` is exactly that union, in order.
//   2. The control verbs an attached coordinator does NOT get — computed as
//      the remainder of `MUON_CONTROL_TOOL_NAMES` after removing both the
//      attached-control set AND the observer set (the observer overlap —
//      fleet_status, list_tasks, read_stream, dispatch_status, budget_status,
//      workflow_status, check_approval — already reaches Tier C through Tier
//      B, so it is not part of "what Tier C lacks") — equals EXACTLY the
//      three verbs ADR-0028 §2 names absent: set_fleet, raise_budget,
//      apply_workflow.
//   3. A synthetic drift check: a control tool array that grew one new,
//      unclassified verb changes the computed remainder (proving the
//      invariant is a real conformance gate, not a vacuously-true assertion
//      against two arrays that happen to already agree).
describe("ADR-0028 Tier C: the attached coordinator", () => {
  /** The observer overlap: control verbs Tier C already holds via Tier B. */
  function controlToolsRemainingAfterAttachedGrant(
    controlToolNames: readonly string[]
  ): string[] {
    const granted = new Set<string>([
      ...MUON_ATTACHED_COORDINATOR_CONTROL_TOOL_NAMES,
      ...MUON_OBSERVER_TOOL_NAMES,
    ]);
    return controlToolNames.filter((name) => !granted.has(name));
  }

  it("MUON_ATTACHED_COORDINATOR_TOOL_NAMES is exactly Tier A + Tier B + the 7 control tools, in order", () => {
    expect(MUON_ATTACHED_COORDINATOR_TOOL_NAMES).toEqual([
      ...MUON_CONTEXT_TOOL_NAMES,
      ...MUON_COORDINATION_TOOL_NAMES,
      ...MUON_OBSERVER_TOOL_NAMES,
      ...MUON_ATTACHED_COORDINATOR_CONTROL_TOOL_NAMES,
    ]);
    expect(MUON_ATTACHED_COORDINATOR_CONTROL_TOOL_NAMES).toEqual([
      "create_task",
      "dispatch",
      "steer",
      "interrupt",
      "ship",
      "assign_roles",
      "propose_workflow",
    ]);
    // `crew_roles` intentionally repeats (it lives in both the base
    // coordination tier and the observer tier by design — see
    // MUON_OBSERVER_TOOL_NAMES's doc comment), so the union is not
    // duplicate-free; assert the *set* of names instead of exact length.
    expect(new Set(MUON_ATTACHED_COORDINATOR_TOOL_NAMES)).toEqual(
      new Set([
        ...MUON_CONTEXT_TOOL_NAMES,
        ...MUON_COORDINATION_TOOL_NAMES,
        ...MUON_OBSERVER_TOOL_NAMES,
        ...MUON_ATTACHED_COORDINATOR_CONTROL_TOOL_NAMES,
      ])
    );
  });

  it("the control remainder (what Tier C does NOT get) is exactly set_fleet, raise_budget, apply_workflow", () => {
    const remainder = controlToolsRemainingAfterAttachedGrant(
      MUON_CONTROL_TOOL_NAMES
    );
    expect(remainder).toEqual([...MUON_ATTACHED_COORDINATOR_CONTROL_REMAINDER]);
    expect(remainder).toEqual(["set_fleet", "raise_budget", "apply_workflow"]);
    // Never empty: an attached coordinator must always lack at least one
    // control verb, or Tier C would be indistinguishable from Tier
    // orchestrator (the ADR-0028 §2 boundary this whole test exists to hold).
    expect(remainder.length).toBeGreaterThan(0);
  });

  it("every attached-control verb and every remainder verb is a real, distinct MUON_CONTROL_TOOL_NAMES member", () => {
    for (const name of MUON_ATTACHED_COORDINATOR_CONTROL_TOOL_NAMES) {
      expect(MUON_CONTROL_TOOL_NAMES).toContain(name);
    }
    for (const name of MUON_ATTACHED_COORDINATOR_CONTROL_REMAINDER) {
      expect(MUON_CONTROL_TOOL_NAMES).toContain(name);
    }
    // Disjoint: nothing is simultaneously granted-by-name AND named absent.
    const grantedByName = new Set(MUON_ATTACHED_COORDINATOR_CONTROL_TOOL_NAMES);
    for (const name of MUON_ATTACHED_COORDINATOR_CONTROL_REMAINDER) {
      expect(grantedByName.has(name)).toBe(false);
    }
  });

  it("synthetic: a new, unclassified control verb changes the computed remainder", () => {
    // Proves the remainder computation is a live conformance gate rather than
    // two hand-maintained arrays that merely happen to agree today. If a future
    // PR appends a new control tool name to MUON_CONTROL_TOOL_NAMES without
    // deciding whether an attached coordinator may hold it (by adding it to
    // MUON_ATTACHED_COORDINATOR_CONTROL_TOOL_NAMES, or leaving it to fall into
    // the remainder), THIS shape of assertion — re-run against the real arrays
    // in CI — is what fails and names the undecided verb.
    const hypotheticalControlNames = [
      ...MUON_CONTROL_TOOL_NAMES,
      "delete_universe",
    ];
    const hypotheticalRemainder = controlToolsRemainingAfterAttachedGrant(
      hypotheticalControlNames
    );
    expect(hypotheticalRemainder).not.toEqual([
      ...MUON_ATTACHED_COORDINATOR_CONTROL_REMAINDER,
    ]);
    expect(hypotheticalRemainder).toContain("delete_universe");
    // ...and the REAL arrays (unchanged) still hold the exact invariant, so
    // this is demonstrably a property of the computation, not of the fixture.
    expect(
      controlToolsRemainingAfterAttachedGrant(MUON_CONTROL_TOOL_NAMES)
    ).toEqual([...MUON_ATTACHED_COORDINATOR_CONTROL_REMAINDER]);
  });

  it("leaves MUON_ORCHESTRATOR_TOOL_NAMES, MUON_OBSERVER_TOOL_NAMES, and the delegate inventories unchanged in membership", () => {
    // Tier C additions are ADDITIVE — a new positive list — never a mutation of
    // an existing tier's membership or order.
    expect(MUON_ORCHESTRATOR_TOOL_NAMES).toEqual([
      ...MUON_CONTEXT_TOOL_NAMES,
      ...MUON_COORDINATION_TOOL_NAMES,
      ...MUON_CONTROL_TOOL_NAMES,
    ]);
    expect(MUON_OBSERVER_TOOL_NAMES).toEqual([
      "fleet_status",
      "list_tasks",
      "dispatch_status",
      "read_stream",
      "budget_status",
      "workflow_status",
      "crew_roles",
      "check_approval",
    ]);
    expect(MUON_DELEGATE_CAPABILITY_TOOL_NAMES).toEqual([
      ...MUON_CONTEXT_TOOL_NAMES,
      ...MUON_COORDINATION_TOOL_NAMES,
      ...MUON_DELEGATE_TOOL_NAMES,
    ]);
  });
});
