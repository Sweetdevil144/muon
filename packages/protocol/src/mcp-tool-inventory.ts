export const MUON_CONTEXT_TOOL_NAMES = [
  "memory_search",
  "memory_recall",
  "memory_neighbors",
  "memory_explain",
  "memory_delete",
  "memory_clone",
  "memory_add",
  // ADR-0058. The grounding verb: check ONE note's claims against the repo
  // (anchor existence, staleness confrontation, impact agreement — a positive
  // list). Base tier like `memory_add`, whose authority class it shares: it
  // reads the graph, stamps provenance, and on mismatch PROPOSES — the
  // contradiction lands unconfirmed through the same gate as every agent
  // write. It can promote nothing.
  "memory_ground",
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
  // ADR-0053 §8. A deliberate widening of the base tier by three READS over the
  // repository's own markdown corpus. Every seat gets them because "what has
  // this repository already decided" is a question any agent has, and grepping
  // is the alternative. They carry no write verb, no new grant, and no side
  // effect; doc prose rides the standard trust envelope as DATA, and the docs
  // graph is deliberately NOT a brief slice or an ADR-0051 §1 institutional
  // source (a brief is text the agent cannot decline and has no envelope).
  "docs_query",
  "docs_context",
  "docs_impact",
  "capability_preflight",
  // Feature #10. Base tier on purpose: "who am I and what may I do" is the one
  // question every agent has, and an agent that cannot ask it guesses instead.
  // It reports the session's own coordinates and grant — it reads nothing and
  // can widen nothing.
  "whoami",
  // H5. Base tier for the same reason `whoami` is: "what is MUON waiting on the
  // human for" is a question any session beside a person needs to answer, and
  // guessing at it is worse than not answering. It returns COORDINATES — gate
  // ids and unconfirmed note ids in the caller's own partition — and carries no
  // decision verb: confirm and reject stay operator-tier, on operator surfaces.
  "review_queue",
] as const;

/**
 * A2A coordination (peer, horizontal). Every worker gets these — that is the
 * point: peers can only coordinate if the tools reach the workers, not just the
 * coordinator. Each is mission-bounded and carries no authority: sending a peer
 * message cannot approve, dispatch, or widen anything, and a file claim is
 * advisory. `crew_roles` is the READ side of role assignment; the write side
 * (`assign_roles`) lives in the control tier below.
 */
export const MUON_COORDINATION_TOOL_NAMES = [
  "publish_finding",
  "peer_message",
  "peer_inbox",
  // ADR-0034. Read-only and coordinate-only like the rest of this tier: it
  // returns a peer's lifecycle state or an arrival count, never message text,
  // and MUON clamps the wait to the caller's own budget.
  "peer_wait",
  "claim_files",
  "release_files",
  // ADR-0043. The typed escalation to a HUMAN when the crew cannot answer.
  // Powerless by construction: filing a question confers no authority, stops
  // no clock, extends no budget; the ask schema is strict and identity-free.
  "question_ask",
  "question_status",
  // ADR-0069 D2: the asker's OWN terminal verb — withdraw a question,
  // optionally recording that the disclosed memory pre-answer settled it
  // (typed reason + citations from that pre-answer). Self-scoped like the
  // rest of the family: only the asking job's questions, never a close of
  // anyone else's, never a human answer.
  "question_withdraw",
  "crew_roles",
] as const;

export const MUON_CONTROL_TOOL_NAMES = [
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
  // A14 / ADR-0045. The PROPOSE half of plan amendment, and only that half:
  // it records an inert draft and returns the gate tag a human approves.
  // Appending to a live run is gated exactly as hard as applying one, so
  // there is deliberately no `apply_amendment` here — and `apply_workflow`
  // stays in the attached coordinator's remainder for the same reason.
  "propose_amendment",
  "workflow_status",
  "ship",
  "check_approval",
] as const;

/**
 * Tier B for a coding-agent CLI the human launched themselves. This is a
 * POSITIVE inventory, never `MUON_CONTROL_TOOL_NAMES - writers`: adding a new
 * control verb must not silently grant it to an attached process. Every member
 * is read-only; `crew_roles` is repeated deliberately even though it also lives
 * in the base coordination tier, because this constant is the complete review
 * boundary for observer authority.
 */
export const MUON_OBSERVER_TOOL_NAMES = [
  "fleet_status",
  "list_tasks",
  "dispatch_status",
  "read_stream",
  "budget_status",
  "workflow_status",
  "crew_roles",
  "check_approval",
] as const;

/**
 * ADR-0028 Tier C authority additions. Positive by construction: filtering the
 * full control implementation through this list cannot inherit a future verb.
 */
export const MUON_ATTACHED_COORDINATOR_CONTROL_TOOL_NAMES = [
  "create_task",
  "dispatch",
  "steer",
  "interrupt",
  "ship",
  "assign_roles",
  "propose_workflow",
  // A14. Granted for the SAME reason `propose_workflow` is: proposing changes
  // nothing. `apply_workflow` remains in the remainder below, and no amendment
  // APPLY verb exists at any tier — the human approves the amendment gate.
  "propose_amendment",
] as const;

/** Control verbs intentionally unavailable to an attached coordinator. */
export const MUON_ATTACHED_COORDINATOR_CONTROL_REMAINDER = [
  "set_fleet",
  "raise_budget",
  "apply_workflow",
] as const;

export const MUON_ATTACHED_COORDINATOR_TOOL_NAMES = [
  ...MUON_CONTEXT_TOOL_NAMES,
  ...MUON_COORDINATION_TOOL_NAMES,
  ...MUON_OBSERVER_TOOL_NAMES,
  ...MUON_ATTACHED_COORDINATOR_CONTROL_TOOL_NAMES,
] as const;

export const MUON_ORCHESTRATOR_TOOL_NAMES = [
  ...MUON_CONTEXT_TOOL_NAMES,
  ...MUON_COORDINATION_TOOL_NAMES,
  ...MUON_CONTROL_TOOL_NAMES,
] as const;

// HISTORICAL NOTE (kept because the reasoning still explains the shape above):
// an earlier revision unioned a bounded set of NATIVE file tools
// (exactly Read/Write/Edit — never a wildcard, never Bash/network) into the
// coordinator's grant, because the coordinator holds only the AGENT token and
// no operator watches its approval inbox, so a gated native Write could only
// ever time out and fail closed. That union was since REMOVED: the runner now
// grants the coordinator exactly the MUON MCP inventory and nothing else
// (see `capabilityMode === "orchestrator"` in packages/runner/src/execute.ts),
// and the over-capability assertion there refuses launch if any later step
// re-widens it. Do not re-add native tools here without revisiting that
// assertion — it is the backstop that has caught this class of leak before.

export const MUON_DELEGATE_TOOL_NAMES = ["delegate"] as const;

/**
 * The VENDOR-NATIVE file tools an edit-authority delegate is granted, and the
 * complete list of them (ADR-0048). A positive, named list — never derived —
 * for the same reason every tier above is: a derived set silently reclassifies
 * whatever is added next.
 *
 * Deliberately absent: `Bash` (a delegate has no approver to put a command to,
 * and host-side checks are refused for edit delegates precisely because they
 * would execute agent-authored code ungated), and every fan-out tool (governed
 * fan-out is `mcp__muon__dispatch`, a lane run with a job id).
 *
 * The write BOUNDARY is the task worktree: these names are preauthorized with
 * the child's cwd set to its isolated worktree, and the vendor's own
 * permission model treats paths outside cwd as requiring further permission
 * nobody is there to grant.
 */
export const MUON_DELEGATE_EDIT_TOOL_NAMES = ["Edit", "Write"] as const;

export const MUON_DELEGATE_CAPABILITY_TOOL_NAMES = [
  ...MUON_CONTEXT_TOOL_NAMES,
  ...MUON_COORDINATION_TOOL_NAMES,
  ...MUON_DELEGATE_TOOL_NAMES,
] as const;
