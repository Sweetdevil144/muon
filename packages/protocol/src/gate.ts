// ── Orchestrator gate tags (ADR-0010 Part B) ────────────────────────────────
//
// A "gate" binds ONE human approval to ONE specific action + payload. The tag
// (e.g. `[gate:set_fleet claude-code=2,codex=0,cursor=0]`) is filed with the
// approval when the orchestrator requests it, and redemption, now at the ROUTE
// (backend/src/lib/gate.ts), requires the SAME tag. So a `command`/`merge`
// approval, or a fleet gate for different counts, cannot authorize this action
// (closes cross-kind reuse + payload bait-and-switch).
//
// These helpers are PURE and live here so the FILER and the REDEEMER compute a
// byte-identical tag from the same source, a canonicalization drift would
// wrongly 403 a legitimate agent-tier apply.
//
// INFORMED CONSENT (review F-1): the human must approve EXACTLY what is enforced.
// `POST /api/approvals` therefore DERIVES the stored/displayed `reason` from the
// enforced binding via `describeGateTag`, and re-canonicalizes the stored
// `gateTag` from the parsed payload, never trusting agent free-text. For an
// apply gate the server additionally binds the proposal CONTENT hash at file
// time (review F-2), so a post-approval proposal edit no longer matches.

/** The canonical tag string a gate is bound to. */
export function gateTag(action: string, payload: string): string {
  return `[gate:${action} ${payload}]`;
}

/**
 * Deterministic serialization of a fleet-resize payload: EVERY vendor actually
 * being set, in sorted order (`undefined` counts are omitted), so the SAME
 * requested resize always yields the SAME tag on both sides of the gate.
 *
 * The vendor list is derived from the PAYLOAD, never from a hardcoded allowlist.
 * A fixed list is a bounded surface that silently stops covering the payload the
 * moment the fleet learns a new vendor: the omitted count would ride along
 * unbound, so an approval for `claude-code=1` would also authorize an
 * unmentioned `opencode=3`. Sorting keeps the historical order byte-identical
 * (claude-code, codex, cursor) while making the binding total.
 */
export function canonicalCounts(counts: Record<string, number | undefined>): string {
  return Object.keys(counts)
    .filter((vendor) => counts[vendor] !== undefined)
    .sort()
    .map((vendor) => `${vendor}=${counts[vendor]}`)
    .join(",");
}

/** The gate tag that authorizes `PUT /api/fleet` for exactly these counts. */
export function fleetGateTag(counts: Record<string, number | undefined>): string {
  return gateTag("set_fleet", canonicalCounts(counts));
}

/**
 * The gate tag that authorizes `POST /api/workflow-runs/:runId/apply`.
 *
 * Two forms:
 *  • filing REQUEST (no hash), `[gate:apply_workflow runId=<id>]`, what the
 *    orchestrator tool sends; the server parses the runId and ENRICHES it.
 *  • enforced CANONICAL (with proposal hash), `[gate:apply_workflow runId=<id>
 *    proposal=<hash>]`, what the server stores and the apply route redeems,
 *    binding the gate to the proposal CONTENT so a post-approval edit 403s.
 */
export function applyWorkflowGateTag(runId: string, proposalHash?: string): string {
  return gateTag(
    "apply_workflow",
    proposalHash === undefined
      ? `runId=${runId}`
      : `runId=${runId} proposal=${proposalHash}`
  );
}

/**
 * The gate tag that authorizes
 * `POST /api/workflow-runs/:runId/amendments/:amendmentId/apply` (ADR-0045 D2).
 *
 * Deliberately the SAME shape as the apply gate, because ADR-0045 D2 says an
 * amendment is gated exactly as hard as an apply: the tempting shortcut is
 * "the run is already applied, so adding to it inherits that approval", and it
 * does not — that reasoning lets an agent that earned one approval keep
 * spending it.
 *
 * Two forms, mirroring `applyWorkflowGateTag`:
 *  • filing REQUEST (no hash), `[gate:amend_workflow runId=<id>
 *    amendment=<id>]`, what a filer sends; the server ENRICHES it.
 *  • enforced CANONICAL (with the appended-steps hash),
 *    `[gate:amend_workflow runId=<id> amendment=<id> steps=<hash>]`, what the
 *    server stores and the amend route redeems, so an amendment whose steps
 *    changed after the human read them no longer matches.
 */
export function amendWorkflowGateTag(
  runId: string,
  amendmentId: string,
  stepsHash?: string
): string {
  return gateTag(
    "amend_workflow",
    stepsHash === undefined
      ? `runId=${runId} amendment=${amendmentId}`
      : `runId=${runId} amendment=${amendmentId} steps=${stepsHash}`
  );
}

/**
 * The gate tag that authorizes a one-shot FULL-AUTO vendor action via
 * `POST /api/dispatch` (ADR-0013 #52 v2). Full-auto lets the vendor run without
 * its own prompts, so, like a fleet resize or a workflow apply, an agent-tier
 * caller must present an operator-approved, single-use gate before it dispatches.
 * The gate binds the EXACT vendor + action, so an approval for one can't
 * authorize another. Deterministic (full-auto carries no free args), so the
 * approvals filer and the dispatch route compute a byte-identical tag.
 */
export function dispatchActionGateTag(vendor: string, action: string): string {
  return gateTag("dispatch_action", `vendor=${vendor} action=${action}`);
}

/**
 * The gate tag that authorizes a delegation-budget RAISE via
 * `PATCH /api/dispatch/:jobId/budget` (S9). Raising the fleet-scaled descendant
 * pool is an OPERATOR act; an agent-tier caller (the orchestrator, after it hits
 * a budget 409) must present an operator-approved, single-use gate before the
 * route raises the pool, exactly like a fleet resize. The gate binds the EXACT
 * root jobId + the EXACT new pool (ms), so an approval for one job/amount cannot
 * authorize another, and a post-approval retry for a larger raise re-gates.
 * Deterministic, so the approvals filer and the dispatch route compute a
 * byte-identical tag.
 */
export function budgetRaiseGateTag(jobId: string, maxDescendantWallMs: number): string {
  return gateTag("raise_budget", `jobId=${jobId} pool=${maxDescendantWallMs}`);
}

/** Structured view of a parsed gate tag (server uses it to enrich + describe). */
export type ParsedGate =
  | { action: "set_fleet"; counts: Record<string, number> }
  | { action: "apply_workflow"; runId: string; proposalHash?: string }
  | {
      action: "amend_workflow";
      runId: string;
      amendmentId: string;
      stepsHash?: string;
    }
  | { action: "dispatch_action"; vendor: string; verb: string }
  | { action: "raise_budget"; jobId: string; poolMs: number }
  | { action: "other" };

/**
 * Parse a `[gate:<action> <payload>]` tag into structured form, or null when it
 * is not a well-formed gate tag. Total + dependency-free so both the filer-side
 * enrichment and the human-facing description share one grammar.
 */
export function parseGateTag(tag: string): ParsedGate | null {
  const match = /^\[gate:(\S+) (.+)\]$/.exec(tag);
  if (!match) {
    return null;
  }
  const [, action, payload] = match;
  if (action === "set_fleet") {
    const counts: Record<string, number> = {};
    for (const part of payload.split(",")) {
      const [vendor, value] = part.split("=");
      const parsed = Number(value);
      if (vendor && value !== undefined && value !== "" && Number.isFinite(parsed)) {
        counts[vendor] = parsed;
      }
    }
    return { action: "set_fleet", counts };
  }
  if (action === "apply_workflow") {
    const runMatch = /^runId=(\S+?)(?: proposal=(\S+))?$/.exec(payload);
    if (!runMatch) {
      return { action: "other" };
    }
    return {
      action: "apply_workflow",
      runId: runMatch[1],
      proposalHash: runMatch[2],
    };
  }
  if (action === "amend_workflow") {
    const amendMatch =
      /^runId=(\S+?) amendment=(\S+?)(?: steps=(\S+))?$/.exec(payload);
    if (!amendMatch) {
      return { action: "other" };
    }
    return {
      action: "amend_workflow",
      runId: amendMatch[1],
      amendmentId: amendMatch[2],
      stepsHash: amendMatch[3],
    };
  }
  if (action === "dispatch_action") {
    const m = /^vendor=(\S+) action=(\S+)$/.exec(payload);
    if (!m) {
      return { action: "other" };
    }
    return { action: "dispatch_action", vendor: m[1], verb: m[2] };
  }
  if (action === "raise_budget") {
    const m = /^jobId=(\S+) pool=(\d+)$/.exec(payload);
    if (!m) {
      return { action: "other" };
    }
    return { action: "raise_budget", jobId: m[1], poolMs: Number(m[2]) };
  }
  return { action: "other" };
}

/**
 * Human-readable subject of a gate, DERIVED from the enforced tag, this is what
 * the operator sees in the inbox (F-1), so they approve exactly what the route
 * enforces. For set_fleet it is complete from the tag; for apply_workflow it
 * renders the structural subject ("Apply workflow run <id>") which the server
 * augments with the (hash-bound) proposal summary at file time.
 */
export function describeGateTag(tag: string): string {
  const parsed = parseGateTag(tag);
  if (!parsed) {
    return tag;
  }
  if (parsed.action === "set_fleet") {
    // Same completeness rule as `canonicalCounts`: the human must SEE every
    // count the tag binds, so this renders what the tag says rather than what a
    // hardcoded vendor list expects it to say.
    const detail = Object.keys(parsed.counts)
      .sort()
      .map((vendor) => `${vendor}=${parsed.counts[vendor]}`)
      .join(", ");
    return detail ? `Set fleet → ${detail}` : "Set fleet (no change)";
  }
  if (parsed.action === "apply_workflow") {
    return `Apply workflow run ${parsed.runId}`;
  }
  if (parsed.action === "amend_workflow") {
    // Structural subject only, like apply's: the approvals route augments it
    // with the (hash-bound) appended step titles at file time, so the human
    // reads the steps rather than a digest.
    return `Append steps to workflow run ${parsed.runId} (amendment ${parsed.amendmentId})`;
  }
  if (parsed.action === "dispatch_action") {
    return `Run '${parsed.verb}' full-auto (one-shot) on ${parsed.vendor}`;
  }
  if (parsed.action === "raise_budget") {
    return `Raise delegation budget for job ${parsed.jobId} to ${parsed.poolMs} ms`;
  }
  return tag;
}
