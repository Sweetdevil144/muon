import { z } from "zod";

/**
 * Loop: a budgeted feedback cycle attached to a workflow step (VISION §4).
 * Budgets are hard caps; exhausting them never retries silently, it files a
 * `gate` approval so the human decides what happens next.
 */
export const loopKindSchema = z.enum([
  "check_repair",
  "critique_patch",
  "propose_revise",
]);
export type LoopKind = z.infer<typeof loopKindSchema>;

export const loopSpecSchema = z.object({
  kind: loopKindSchema.default("check_repair"),
  maxIterations: z.number().int().min(1).max(10).default(3),
  maxWallMs: z.number().int().positive().optional(),
  onExhaust: z.literal("escalate").default("escalate"),
});
export type LoopSpec = z.infer<typeof loopSpecSchema>;

export const evaluatorVerdictSchema = z.object({
  pass: z.boolean(),
  reason: z.string().min(1).max(500),
  fixHints: z.array(z.string().min(1).max(300)).max(10),
});
export type EvaluatorVerdict = z.infer<typeof evaluatorVerdictSchema>;

export const loopProgressSchema = z.object({
  iteration: z.number().int().min(1),
  shell: z.array(
    z.object({
      name: z.string().min(1),
      ok: z.boolean(),
      exitCode: z.number().int(),
      /**
       * Whether the command could observe the iteration's changed paths.
       * `uncovering` is a zero exit that proved nothing — `ok` stays true
       * because the command really did succeed; what it did not do is cover
       * the diff. Optional so pre-existing progress rows keep parsing.
       */
      coverage: z.enum(["covers", "uncovering", "unknown"]).optional(),
      /**
       * Set when the row is NOT a verdict about the change: `no-suite` (the
       * changed package declares no test script, so nothing ran there) or
       * `superseded` (a check that covered nothing, answered instead by the
       * checks derived from the changed files). `ok` stays true in both cases
       * because no command failed — this field is what stops a reader from
       * counting either one as a pass. Optional so older rows keep parsing.
       */
      skip: z.enum(["no-suite", "superseded"]).optional(),
    })
  ),
  evaluator: evaluatorVerdictSchema
    .extend({ laneKey: z.string().min(1) })
    .nullable(),
  repairSeed: z.string().max(4_000),
  degraded: z.string().min(1).max(300).optional(),
  updatedAt: z.string().datetime(),
});
export type LoopProgress = z.infer<typeof loopProgressSchema>;

export const loopRunStatusSchema = z.enum([
  "running",
  "passed",
  "escalated",
  "exhausted",
  "aborted",
]);
export type LoopRunStatus = z.infer<typeof loopRunStatusSchema>;

const ownedPathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) => {
      const normalized = value.replaceAll("\\", "/");
      const owned = normalized.replace(/^\.\/+/, "").replace(/\/+$/, "");
      return (
        owned.length > 0 &&
        !normalized.startsWith("/") &&
        !/^[A-Za-z]:\//.test(normalized) &&
        !normalized.split("/").includes("..") &&
        owned !== "."
      );
    },
    { message: "ownership paths must be relative workspace paths" }
  );

export const workflowParallelSchema = z.object({
  group: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i),
  independent: z.literal(true),
  paths: z.array(ownedPathSchema).min(1).max(16),
});
export type WorkflowParallel = z.infer<typeof workflowParallelSchema>;

type ParallelStepLike = {
  stepKey: string;
  role: string;
  gate?: "gate" | "merge";
  handoffTo?: string;
  parallel?: WorkflowParallel;
};

function validateParallelGroups(
  steps: ParallelStepLike[],
  ctx: z.RefinementCtx
): void {
  const groups = new Map<
    string,
    { indices: number[]; steps: ParallelStepLike[] }
  >();

  steps.forEach((step, index) => {
    if (!step.parallel) {
      return;
    }
    const group = groups.get(step.parallel.group) ?? { indices: [], steps: [] };
    group.indices.push(index);
    group.steps.push(step);
    groups.set(step.parallel.group, group);

    if (step.role === "human") {
      ctx.addIssue({
        code: "custom",
        path: [index, "parallel"],
        message: "parallel groups cannot contain human steps",
      });
    }
    if (step.gate) {
      ctx.addIssue({
        code: "custom",
        path: [index, "parallel"],
        message: "parallel steps use the group fan-out gate, not per-step gates",
      });
    }
    if (step.handoffTo) {
      ctx.addIssue({
        code: "custom",
        path: [index, "parallel"],
        message: "parallel steps cannot declare handoffs inside the group",
      });
    }
  });

  for (const [groupName, group] of groups) {
    if (group.steps.length < 2 || group.steps.length > 3) {
      ctx.addIssue({
        code: "custom",
        message: `parallel group '${groupName}' must contain 2-3 steps`,
      });
    }
    const contiguous = group.indices.every(
      (index, offset) => index === group.indices[0]! + offset
    );
    if (!contiguous) {
      ctx.addIssue({
        code: "custom",
        message: `parallel group '${groupName}' steps must be contiguous`,
      });
    }
  }
}

/**
 * One step of a declared workflow. `role` is a lane key, "human", or
 * "suggest" (routing recommends, the human decides at apply time).
 * A step gate is a human checkpoint: the run pauses until the approval in
 * the MUON inbox is decided, fail closed, like every other gate.
 */
export const workflowStepSchema = z.object({
  stepKey: z.string().min(1),
  title: z.string().min(3),
  briefTemplate: z.string().min(1),
  role: z.string().min(1).default("suggest"),
  harnessKey: z.string().min(1).optional(),
  loop: loopSpecSchema.optional(),
  gate: z.enum(["gate", "merge"]).optional(),
  handoffTo: z.string().min(1).optional(),
  onFail: z.string().min(1).default("escalate"),
  parallel: workflowParallelSchema.optional(),
});
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

export const workflowDefinitionSchema = z
  .object({
    steps: z.array(workflowStepSchema).min(1),
  })
  .superRefine((value, ctx) => {
    const keys = new Set<string>();
    for (const step of value.steps) {
      if (keys.has(step.stepKey)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate stepKey '${step.stepKey}'`,
        });
      }
      keys.add(step.stepKey);
    }
    for (const step of value.steps) {
      if (step.handoffTo && !keys.has(step.handoffTo)) {
        ctx.addIssue({
          code: "custom",
          message: `handoffTo '${step.handoffTo}' does not match any stepKey`,
        });
      }
    }
    validateParallelGroups(value.steps, ctx);
  });
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

/**
 * A materialized, human-editable plan step: the brief is resolved (template
 * placeholders filled, memory slice noted) and a lane may be suggested with
 * a human-readable routing reason. Nothing dispatches until a human applies.
 */
export const workflowProposalStepSchema = z.object({
  stepKey: z.string().min(1),
  title: z.string().min(3),
  brief: z.string().min(1),
  role: z.string().min(1).default("suggest"),
  laneKey: z.string().min(1).optional(),
  laneReason: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  harnessKey: z.string().min(1).optional(),
  loop: loopSpecSchema.optional(),
  gate: z.enum(["gate", "merge"]).optional(),
  handoffTo: z.string().min(1).optional(),
  onFail: z.string().min(1).default("escalate"),
  parallel: workflowParallelSchema.optional(),
});
export type WorkflowProposalStep = z.infer<typeof workflowProposalStepSchema>;

export const workflowProposalSchema = z
  .object({
    summary: z.string().min(3),
    templateKey: z.string().min(1).optional(),
    steps: z.array(workflowProposalStepSchema).min(1),
  })
  .superRefine((value, ctx) => validateParallelGroups(value.steps, ctx));
export type WorkflowProposal = z.infer<typeof workflowProposalSchema>;

export const workflowRunStatusSchema = z.enum([
  "proposed",
  "applied",
  "running",
  "paused",
  "done",
  "abandoned",
]);
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;
