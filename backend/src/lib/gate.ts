import { createHash } from "node:crypto";
import type { WorkflowAmendmentStep, WorkflowProposal } from "@muon/protocol";
import type { prisma } from "./db.js";

/**
 * Route-level gate redemption (ADR-0010 Part B / closes F3-F4).
 *
 * The human gate for the two "orchestrator gate" actions (`PUT /api/fleet`,
 * `POST /api/workflow-runs/:runId/apply`) used to live ONLY in the MCP tool
 * layer, so a bare agent-tier HTTP call to either route bypassed it. This is
 * the reusable primitive that moves the gate to the route: an agent-tier caller
 * MUST present a redeemed, tag-bound, operator-approved, single-use gate.
 *
 * It is ONE atomic guarded `updateMany` enriched with `kind` + the EXACT
 * `gateTag`, so VALIDATION and single-use CONSUME are ONE operation, no
 * read-then-consume TOCTOU, and no `reason LIKE %tag%` wildcard ambiguity (the
 * tag contains `_`, a SQL `LIKE` wildcard). It matches exactly one row iff the
 * approval:
 *   • exists and is a gate  (`kind == "gate"`),
 *   • was approved by the OPERATOR (`status == "approved"`, the approve PATCH
 *     is `requireOperator`, so an "approved" status provably reflects a human),
 *   • is un-consumed        (`consumedAt == null`, single-use),
 *   • is bound to THIS exact action+payload (`gateTag == expectedTag`).
 * A matched row is stamped `consumedAt` in the same statement, so a replay,
 * a wrong payload, a cross-kind id, or an unapproved gate all return `false`.
 *
 * `false` ⇒ the caller throws `app.httpErrors.forbidden(...)` before any write.
 */
export async function redeemGateAtRoute(
  db: typeof prisma,
  approvalId: string,
  expectedTag: string
): Promise<boolean> {
  const result = await db.approvalRequest.updateMany({
    where: {
      id: approvalId,
      kind: "gate",
      status: "approved",
      consumedAt: null,
      gateTag: expectedTag,
    },
    data: { consumedAt: new Date() },
  });
  return result.count === 1;
}

/**
 * The fixed-order projection of ONE step that both content hashes digest.
 *
 * Shared so the apply gate and the amendment gate cannot drift into hashing
 * different fields — a step that binds under one verb and floats under the
 * other is a bait-and-switch waiting to be found.
 *
 * `loop` IS in the digest, and that is a DECISION (ADR-0045 flags it): a loop
 * spec carries `maxIterations` and `maxWallMs`, and `maxWallMs` is spent as a
 * real dispatch wall (`apps/cli/src/commands/workflow.ts` passes it straight
 * through as the dispatch wait). Omitting it — which this function did until
 * ADR-0045 — meant a BUDGET could be altered after a human approved the gate
 * without changing the hash the gate is bound to. The alternative ADR-0045
 * offered was to refuse any appended step carrying `loop`, and that was
 * rejected because D3 names "loop budget" among the fields an amendment must
 * evaluate positively, i.e. it expects loops on appended steps; a hash that
 * covers the field is what makes evaluating it mean something. Every caller
 * recomputes this server-side from stored content on BOTH sides of the gate,
 * so the widened digest needs no migration; the only casualty is a gate filed
 * before this change, which now fails closed and needs re-approval.
 */
function digestStep(step: {
  stepKey: string;
  title: string;
  brief: string;
  priority: string;
  role: string;
  laneKey?: string;
  harnessKey?: string;
  loop?: unknown;
  gate?: string;
  handoffTo?: string;
  onFail: string;
  parallel?: unknown;
}) {
  return {
    stepKey: step.stepKey,
    title: step.title,
    brief: step.brief,
    priority: step.priority,
    role: step.role,
    laneKey: step.laneKey ?? null,
    harnessKey: step.harnessKey ?? null,
    loop: step.loop ?? null,
    gate: step.gate ?? null,
    handoffTo: step.handoffTo ?? null,
    onFail: step.onFail,
    parallel: step.parallel ?? null,
  };
}

/**
 * Content hash of a workflow proposal (review F-2). The apply gate binds the
 * proposal CONTENT, not just the runId, so a proposal edited AFTER the human
 * approved (the `PATCH /api/workflow-runs/:id` proposal edit is not operator-
 * gated) no longer matches the enforced tag → 403. Computed SERVER-SIDE from the
 * current proposal both when the gate is filed and again at apply time.
 *
 * Deterministic: an explicit fixed-order projection (not raw key order) over the
 * fields that become tasks / drive routing, JSON-serialized (which escapes any
 * field content so values can't be crafted to blur field boundaries), sha256,
 * truncated to 128 bits, far beyond an in-app agent's ability to collide.
 */
export function hashProposal(proposal: WorkflowProposal): string {
  const digest = {
    summary: proposal.summary,
    templateKey: proposal.templateKey ?? null,
    steps: proposal.steps.map(digestStep),
  };
  return createHash("sha256").update(JSON.stringify(digest)).digest("hex").slice(0, 32);
}

/**
 * Content hash of the steps ONE amendment appends (ADR-0045 D2). The amend
 * gate binds this, so an amendment whose steps changed between the human
 * reading them and the route appending them no longer matches → 403, exactly
 * as an edited proposal no longer matches its apply gate.
 *
 * Same projection, same serialization, same truncation as `hashProposal` — the
 * amendment is gated exactly as hard as an apply, including how its content is
 * bound.
 */
export function hashAmendmentSteps(
  steps: readonly WorkflowAmendmentStep[]
): string {
  const digest = { steps: steps.map(digestStep) };
  return createHash("sha256").update(JSON.stringify(digest)).digest("hex").slice(0, 32);
}
