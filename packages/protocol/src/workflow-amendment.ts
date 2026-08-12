import { z } from "zod";
import { isDangerousCodePoint } from "./evasion-corpus.js";
import { loopSpecSchema } from "./workflow.js";

/**
 * ADR-0045 — a running plan may gain a step, never change one.
 *
 * The contract, compressed from the ADR:
 *  - D1: an amendment APPENDS. There is no field here that names an existing
 *    step, no index, no order — the only shape is "these steps, after the
 *    ones already there".
 *  - D2: it is gated exactly as hard as apply — the same content-hash-bound,
 *    single-use, operator-approved gate (`amendWorkflowGateTag` in gate.ts).
 *  - D3: every authority-bearing field below is evaluated POSITIVELY at
 *    amendment time against the amending principal, never inherited from the
 *    original apply and never computed as "what the run had minus what runs".
 *  - D4: an amendment carries NEW STEPS AND NOTHING ELSE — stated as the
 *    closed list `WORKFLOW_AMENDMENT_STEP_FIELDS` below, so a field added to
 *    `workflowProposalStepSchema` next release does not silently become
 *    amendable. A drift-lock test pins the two together in both directions.
 *  - D5: only `running` and `paused` may be amended, as a POSITIVE list.
 *  - D6: `amendedBy` is derived from auth at the route, never from a payload —
 *    which is why there is deliberately no principal field in this module.
 *
 * No migration: an amendment lives on the Event spine (ADR-0043's shape), and
 * the appended steps land in the run's existing proposal JSON.
 */

// The event-kind names both sides must agree on; a restated literal drifts.
export const WORKFLOW_AMENDMENT_PROPOSED_EVENT_KIND =
  "workflow.amendment.proposed";
export const WORKFLOW_AMENDED_EVENT_KIND = "workflow.amended";

/**
 * D5 as a POSITIVE list. Never `ALL_STATUSES − {done, abandoned}`: a status
 * added next release would silently become amendable, which is the tier-by-
 * subtraction shape that has broken this repo more than once.
 *
 * `proposed` is absent on purpose — it is still editable through the existing
 * proposal-edit path, and offering two ways to change one thing is how the two
 * drift apart. `applied` is absent because the ADR names two statuses and only
 * two; a run that has been applied but has not started is not yet executing.
 */
export const WORKFLOW_AMENDABLE_STATUSES = ["running", "paused"] as const;
export type WorkflowAmendableStatus =
  (typeof WORKFLOW_AMENDABLE_STATUSES)[number];

export function isWorkflowAmendableStatus(
  status: string
): status is WorkflowAmendableStatus {
  return (WORKFLOW_AMENDABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * How many steps one amendment may append. A bound exists because the ADR's
 * rejected alternatives name the failure directly: "this is how a run grows
 * without bound while every individual step looks reasonable". Appending more
 * work than this is a new plan, and a new plan is a new proposal.
 */
export const MAX_AMENDMENT_STEPS = 8;

/**
 * Ceiling on an appended step's loop wall budget. `loop.maxWallMs` is spent as
 * a real dispatch wall (`apps/cli/src/commands/workflow.ts` uses it as the
 * dispatch wait), so it is a BUDGET, and D4 forbids an amendment from being a
 * budget raise wearing a plan's clothes. The schema that governs a proposal
 * leaves it unbounded; an amendment bounds it positively, at the same 30
 * minutes `backend/src/routes/schedules.ts` allows one root dispatch.
 */
export const MAX_AMENDMENT_LOOP_WALL_MS = 1_800_000;

/**
 * The ONLY failure policy MUON implements: `runWorkflowRun` escalates a failed
 * step to a human gate and pauses, unconditionally. A proposal may carry any
 * string here for historical reasons; an amendment may not name a policy that
 * does not exist, because a step that claims an unimplemented `onFail` reads
 * as governed and is not.
 */
export const WORKFLOW_AMENDMENT_ON_FAIL = ["escalate"] as const;

/**
 * The CLOSED list of fields an appended step may carry (D4).
 *
 * Written out here rather than derived from `workflowProposalStepSchema`,
 * because derivation is exactly what D4 forbids: a field added to a proposal
 * step next release must NOT become amendable by inheritance. The drift-lock
 * test asserts this list plus `WORKFLOW_STEP_FIELDS_NOT_AMENDABLE` covers the
 * proposal-step shape exactly, so a new field fails the build until someone
 * decides which side it belongs on.
 */
export const WORKFLOW_AMENDMENT_STEP_FIELDS = [
  "stepKey",
  "title",
  "brief",
  "role",
  "laneKey",
  "priority",
  "harnessKey",
  "loop",
  "gate",
  "handoffTo",
  "onFail",
] as const;

/**
 * Proposal-step fields an amendment deliberately may NOT carry, each with the
 * reason it was excluded. This is a DECLARATION, not a subtraction — the
 * amendable list above is the positive one, and this exists so the drift-lock
 * can prove every proposal-step field was considered.
 *
 *  - `parallel`: ADR-0045 defers parallel-group surgery ("the group validators
 *    treat a group as a unit, and amending one needs its own evidence").
 *    Excluding the field outright means an appended step can never perturb an
 *    existing group's contiguity, size, or ownership set.
 *  - `laneReason`: planner decoration — untrusted prose that renders on
 *    operator surfaces and carries no authority. An amendment states its lane
 *    positively in `laneKey`; it does not get to narrate one.
 */
export const WORKFLOW_STEP_FIELDS_NOT_AMENDABLE = [
  "parallel",
  "laneReason",
] as const;

/**
 * A step TITLE is rendered as one row of the gate the human decides — it is
 * quoted into the approval's `reason`. An interior newline there forges a
 * whole extra row with attacker-chosen content, which is the demonstrated
 * ADR-0043 finding, so the shared dangerous class (never a second hand-written
 * range) is refused outright. The BRIEF is instructions for an agent, never an
 * inbox row, and keeps its newlines.
 */
function carriesDangerous(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && isDangerousCodePoint(code)) return true;
  }
  return false;
}

/**
 * One appended step. `.strict()` so an unknown field is a 400 rather than a
 * silently-ignored one — the same posture as the blocking-question ask schema.
 */
export const workflowAmendmentStepSchema = z
  .object({
    stepKey: z.string().min(1).max(120),
    title: z
      .string()
      .min(3)
      .max(200)
      .refine((value) => !carriesDangerous(value), {
        message:
          "title must be one line of plain text: no control, bidi, or invisible format characters",
      }),
    brief: z.string().min(1).max(20_000),
    role: z.string().min(1).default("suggest"),
    laneKey: z.string().min(1).optional(),
    priority: z.enum(["low", "medium", "high"]).default("medium"),
    harnessKey: z.string().min(1).optional(),
    loop: loopSpecSchema
      .refine(
        (value) =>
          value.maxWallMs === undefined ||
          value.maxWallMs <= MAX_AMENDMENT_LOOP_WALL_MS,
        {
          message: `an appended step's loop budget may not exceed ${MAX_AMENDMENT_LOOP_WALL_MS}ms`,
        }
      )
      .optional(),
    gate: z.enum(["gate", "merge"]).optional(),
    handoffTo: z.string().min(1).optional(),
    onFail: z.enum(WORKFLOW_AMENDMENT_ON_FAIL).default("escalate"),
  })
  .strict();
export type WorkflowAmendmentStep = z.infer<typeof workflowAmendmentStepSchema>;

/**
 * The amendment CONTENT: new steps, and nothing else (D4). No budget field, no
 * status field, no reference to an existing step — the three things D4 names
 * are absent from the type, not validated away from it.
 */
export const workflowAmendmentSchema = z
  .object({
    steps: z
      .array(workflowAmendmentStepSchema)
      .min(1)
      .max(MAX_AMENDMENT_STEPS),
  })
  .strict();
export type WorkflowAmendment = z.infer<typeof workflowAmendmentSchema>;

export const workflowAmendmentStatusSchema = z.enum(["proposed", "applied"]);
export type WorkflowAmendmentStatus = z.infer<
  typeof workflowAmendmentStatusSchema
>;

/** The derived, delivered fact — folded from the event spine, never stored. */
export const workflowAmendmentRecordSchema = z
  .object({
    id: z.string().min(1),
    workflowRunId: z.string().min(1),
    steps: z.array(workflowAmendmentStepSchema).min(1),
    /** Content hash the gate binds. Server-computed on both sides. */
    stepsHash: z.string().min(1),
    status: workflowAmendmentStatusSchema,
    /** From auth (D6), never from a payload. */
    proposedBy: z.string().min(1),
    proposedAt: z.string().min(1),
    amendedBy: z.string().min(1).optional(),
    amendedAt: z.string().min(1).optional(),
  })
  .strict();
export type WorkflowAmendmentRecord = z.infer<
  typeof workflowAmendmentRecordSchema
>;

/**
 * How many amendment rows one spine read folds (two rows per amendment).
 *
 * The read must take the NEWEST window and fold it oldest→newest, never the
 * oldest window: truncating from the old end can drop an amendment's `applied`
 * row while keeping its `proposed` one, and the fold would then derive an
 * already-appended amendment as still pending — appendable twice. Truncating
 * from the new end loses ancient amendments entirely, which refuses rather
 * than re-appends. Same lesson, same direction, as ADR-0043's question spine.
 */
export const WORKFLOW_AMENDMENT_SPINE_WINDOW = 512;

/** The minimal event shape the fold needs — matches the Event spine. */
export type AmendmentSpineEvent = {
  readonly kind: string;
  readonly timestamp: string;
  readonly metadata: Record<string, unknown>;
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Fold the spine into amendment states. Fail-closed, same rules as ADR-0043's
 * question fold:
 *  - a malformed `workflow.amendment.proposed` row derives NOTHING (a corrupt
 *    amendment cannot half-exist and must never be gateable);
 *  - an `workflow.amended` row for an id no proposal established is ignored;
 *  - a second `workflow.amended` for one id is ignored — an amendment applies
 *    exactly once, so a replayed append can never be derived as legitimate.
 */
export function deriveWorkflowAmendments(
  events: readonly AmendmentSpineEvent[]
): WorkflowAmendmentRecord[] {
  const byId = new Map<string, WorkflowAmendmentRecord>();
  for (const event of events) {
    const meta = event.metadata ?? {};
    const id = str(meta.amendmentId);
    if (!id) continue;
    if (event.kind === WORKFLOW_AMENDMENT_PROPOSED_EVENT_KIND) {
      if (byId.has(id)) continue;
      const candidate = workflowAmendmentRecordSchema.safeParse({
        id,
        workflowRunId: str(meta.workflowRunId) ?? undefined,
        steps: meta.steps,
        stepsHash: str(meta.stepsHash) ?? undefined,
        status: "proposed",
        proposedBy: str(meta.proposedBy) ?? undefined,
        proposedAt: event.timestamp,
      });
      if (candidate.success) byId.set(id, candidate.data);
      continue;
    }
    if (event.kind === WORKFLOW_AMENDED_EVENT_KIND) {
      const open = byId.get(id);
      const amendedBy = str(meta.amendedBy);
      if (!open || open.status !== "proposed" || !amendedBy) continue;
      byId.set(id, {
        ...open,
        status: "applied",
        amendedBy,
        amendedAt: event.timestamp,
      });
    }
  }
  return [...byId.values()];
}
