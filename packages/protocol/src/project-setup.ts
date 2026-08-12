import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Declarative per-project setup / teardown / run (ROADMAP T5).
 *
 * Every non-user layer is arbitrary command execution sourced from the checkout
 * and MUST NOT run without operator confirmation bound to the full lifecycle
 * plan. A filename such as `project.local.json` is not a trust boundary: a
 * repository can commit it or remove its ignore rule.
 *
 * Priority when resolving an effective plan:
 *   user override → worktree → project (+ local-merge layer)
 *
 * The conventionally local merge layer concatenates
 * `.muon/project.local.json` onto the project document field-by-field. MUON
 * still treats that file as untrusted unless the operator overrides it from
 * the data directory.
 */

/** One shell-free command step — same argv shape as {@link harnessCheckSchema}. */
export const projectSetupStepSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
});
export type ProjectSetupStep = z.infer<typeof projectSetupStepSchema>;

/** Optional command lists on a single config layer. Omitted fields inherit. */
export const projectSetupLayerSchema = z
  .object({
    setup: z.array(projectSetupStepSchema).optional(),
    teardown: z.array(projectSetupStepSchema).optional(),
    run: z.array(projectSetupStepSchema).optional(),
  })
  .strict();
export type ProjectSetupLayer = z.infer<typeof projectSetupLayerSchema>;

export const PROJECT_SETUP_VERSION = 1 as const;

/** Repo-committed document at `.muon/project.json`. */
export const projectSetupDocumentSchema = z
  .object({
    version: z.literal(PROJECT_SETUP_VERSION),
  })
  .merge(projectSetupLayerSchema)
  .strict();
export type ProjectSetupDocument = z.infer<typeof projectSetupDocumentSchema>;

/** Conventionally gitignored local merge at `.muon/project.local.json`. */
export const projectSetupLocalDocumentSchema = projectSetupDocumentSchema;
export type ProjectSetupLocalDocument = z.infer<
  typeof projectSetupLocalDocumentSchema
>;

/** Per-worktree layer at `.muon/worktree.json` inside the task worktree. */
export const worktreeSetupDocumentSchema = z
  .object({
    version: z.literal(PROJECT_SETUP_VERSION),
  })
  .merge(projectSetupLayerSchema)
  .strict();
export type WorktreeSetupDocument = z.infer<typeof worktreeSetupDocumentSchema>;

/** Operator override in the MUON data dir (never repo-committed). */
export const userProjectSetupOverrideSchema = z
  .object({
    version: z.literal(PROJECT_SETUP_VERSION),
  })
  .merge(projectSetupLayerSchema)
  .strict();
export type UserProjectSetupOverride = z.infer<
  typeof userProjectSetupOverrideSchema
>;

/** Which layer supplied a resolved command list. */
export const projectSetupSourceSchema = z.enum([
  "project",
  "local",
  "worktree",
  "user",
]);
export type ProjectSetupSource = z.infer<typeof projectSetupSourceSchema>;

export type ResolvedProjectSetupPlan = {
  setup: ProjectSetupStep[];
  teardown: ProjectSetupStep[];
  run: ProjectSetupStep[];
  /** Steps that came from the repo-committed project document only. */
  repoCommittedSetup: ProjectSetupStep[];
  /** Effective non-user commands covered by operator confirmation. */
  confirmationBound: ProjectSetupLifecyclePlan;
  /** Per-field provenance for operator surfaces. */
  sources: {
    setup: ProjectSetupSource;
    teardown: ProjectSetupSource;
    run: ProjectSetupSource;
  };
};

export type ProjectSetupLifecyclePlan = {
  setup: ProjectSetupStep[];
  teardown: ProjectSetupStep[];
  run: ProjectSetupStep[];
};

export type ProjectSetupConfirmationRecord = {
  version: typeof PROJECT_SETUP_VERSION;
  /** sha256 hex of the complete effective non-user lifecycle plan. */
  setupHash: string;
  confirmedAt: string;
};

export type ProjectSetupConfirmationRequest = {
  /** Historical field name; hashes the complete `confirmationBound` payload. */
  setupHash: string;
  /** @deprecated Use `confirmationBound.setup`. */
  repoSetup: ProjectSetupStep[];
  /** @deprecated Use `effective.setup`. */
  effectiveSetup: ProjectSetupStep[];
  /** Every non-user command awaiting operator confirmation. */
  confirmationBound: ProjectSetupLifecyclePlan;
  /** Complete effective lifecycle after user overrides are applied. */
  effective: ProjectSetupLifecyclePlan;
};

const EMPTY_LAYER: Required<
  Pick<ResolvedProjectSetupPlan, "setup" | "teardown" | "run">
> = {
  setup: [],
  teardown: [],
  run: [],
};

function concatLayers(
  base: ProjectSetupStep[],
  extra: ProjectSetupStep[] | undefined
): ProjectSetupStep[] {
  if (!extra || extra.length === 0) return [...base];
  return [...base, ...extra];
}

function pickField(
  field: keyof Pick<ProjectSetupLayer, "setup" | "teardown" | "run">,
  projectMerged: Required<Pick<ProjectSetupLayer, "setup" | "teardown" | "run">>,
  local: ProjectSetupLayer,
  worktree: ProjectSetupLayer | undefined,
  user: ProjectSetupLayer | undefined
): { steps: ProjectSetupStep[]; source: ProjectSetupSource } {
  if (user && user[field] !== undefined) {
    return { steps: user[field] ?? [], source: "user" };
  }
  if (worktree && worktree[field] !== undefined) {
    return { steps: worktree[field] ?? [], source: "worktree" };
  }
  const steps = projectMerged[field] ?? [];
  const source: ProjectSetupSource =
    (local[field]?.length ?? 0) > 0 ? "local" : "project";
  return { steps, source };
}

/**
 * Merge project config with its conventionally local companion, then apply
 * worktree and user overrides in priority order. Only the user layer is a
 * trusted source; all other effective commands are confirmation-bound.
 */
export function resolveProjectSetupPlan(input: {
  project?: ProjectSetupLayer;
  local?: ProjectSetupLayer;
  worktree?: ProjectSetupLayer;
  user?: ProjectSetupLayer;
}): ResolvedProjectSetupPlan {
  const project = input.project ?? {};
  const local = input.local ?? {};
  const projectMerged = {
    setup: concatLayers(project.setup ?? [], local.setup),
    teardown: concatLayers(project.teardown ?? [], local.teardown),
    run: concatLayers(project.run ?? [], local.run),
  };

  const setupPick = pickField("setup", projectMerged, local, input.worktree, input.user);
  const teardownPick = pickField(
    "teardown",
    projectMerged,
    local,
    input.worktree,
    input.user
  );
  const runPick = pickField("run", projectMerged, local, input.worktree, input.user);

  const repoCommittedSetup = project.setup ?? [];
  const confirmationBound: ProjectSetupLifecyclePlan = {
    setup: setupPick.source === "user" ? [] : setupPick.steps,
    teardown: teardownPick.source === "user" ? [] : teardownPick.steps,
    run: runPick.source === "user" ? [] : runPick.steps,
  };

  return {
    setup: setupPick.steps,
    teardown: teardownPick.steps,
    run: runPick.steps,
    repoCommittedSetup,
    confirmationBound,
    sources: {
      setup: setupPick.source,
      teardown: teardownPick.source,
      run: runPick.source,
    },
  };
}

/** Canonical content hash for repo-committed setup confirmation binding. */
export function projectSetupContentHash(steps: ProjectSetupStep[]): string {
  const canonical = JSON.stringify(
    steps.map((step) => ({
      command: step.command,
      args: step.args ?? [],
    }))
  );
  return createHash("sha256").update(canonical).digest("hex");
}

/** Canonical content hash for the full non-user lifecycle confirmation payload. */
export function projectSetupPlanContentHash(
  plan: ProjectSetupLifecyclePlan
): string {
  const canonical = JSON.stringify({
    setup: canonicalSteps(plan.setup),
    teardown: canonicalSteps(plan.teardown),
    run: canonicalSteps(plan.run),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalSteps(steps: ProjectSetupStep[]): Array<{
  command: string;
  args: string[];
}> {
  return steps.map((step) => ({
    command: step.command,
    args: step.args ?? [],
  }));
}

function lifecycleHasCommands(plan: ProjectSetupLifecyclePlan): boolean {
  return plan.setup.length + plan.teardown.length + plan.run.length > 0;
}

/** Whether the supplied command payload has a fresh operator confirmation. */
export function projectSetupConfirmationMatches(input: {
  /** Preferred full-plan binding. */
  confirmationBound?: ProjectSetupLifecyclePlan;
  /** Compatibility for callers validating the original setup-only records. */
  repoCommittedSetup?: ProjectSetupStep[];
  record?: ProjectSetupConfirmationRecord;
}): boolean {
  const confirmationBound = input.confirmationBound;
  const repoCommittedSetup = input.repoCommittedSetup ?? [];
  const requiresConfirmation = confirmationBound
    ? lifecycleHasCommands(confirmationBound)
    : repoCommittedSetup.length > 0;
  if (!requiresConfirmation) {
    return true;
  }
  if (!input.record) {
    return false;
  }
  const expectedHash = confirmationBound
    ? projectSetupPlanContentHash(confirmationBound)
    : projectSetupContentHash(repoCommittedSetup);
  return input.record.setupHash === expectedHash;
}

/** Build the confirmation payload for all effective non-user lifecycle commands. */
export function projectSetupConfirmationRequest(
  plan: ResolvedProjectSetupPlan
): ProjectSetupConfirmationRequest | undefined {
  if (!lifecycleHasCommands(plan.confirmationBound)) {
    return undefined;
  }
  return {
    setupHash: projectSetupPlanContentHash(plan.confirmationBound),
    repoSetup: plan.confirmationBound.setup,
    effectiveSetup: plan.setup,
    confirmationBound: plan.confirmationBound,
    effective: {
      setup: plan.setup,
      teardown: plan.teardown,
      run: plan.run,
    },
  };
}

/** Parse unknown JSON as a project setup document; absent/invalid → undefined. */
export function parseProjectSetupDocument(
  raw: unknown
): ProjectSetupDocument | undefined {
  const parsed = projectSetupDocumentSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function parseProjectSetupLocalDocument(
  raw: unknown
): ProjectSetupLocalDocument | undefined {
  const parsed = projectSetupLocalDocumentSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function parseWorktreeSetupDocument(
  raw: unknown
): WorktreeSetupDocument | undefined {
  const parsed = worktreeSetupDocumentSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function parseUserProjectSetupOverride(
  raw: unknown
): UserProjectSetupOverride | undefined {
  const parsed = userProjectSetupOverrideSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function parseProjectSetupConfirmationRecord(
  raw: unknown
): ProjectSetupConfirmationRecord | undefined {
  const schema = z
    .object({
      version: z.literal(PROJECT_SETUP_VERSION),
      setupHash: z.string().min(1),
      confirmedAt: z.string().min(1),
    })
    .strict();
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** File names for each declarative layer (relative to repo or worktree root). */
export const PROJECT_SETUP_PATHS = {
  project: ".muon/project.json",
  local: ".muon/project.local.json",
  worktree: ".muon/worktree.json",
} as const;

export { EMPTY_LAYER };
