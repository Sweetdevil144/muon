import { buildOnboardingState } from "./onboarding.js";
import type {
  DispatchJobRecord,
  DispatchKind,
  Task,
  TaskPriority,
  VendorReadiness,
} from "./types.js";

/**
 * P6, the guided FIRST TASK (quickstart).
 *
 * A brand-new user who has just connected a vendor still has to INVENT a task
 * before they can watch MUON's loop run. That is the last gap in the
 * install → onboard → first task → see-the-moat journey. This module closes it:
 * once ≥1 vendor is ready, it seeds ONE tiny, SAFE, self-contained sample task
 * into the user's chosen workspace and dispatches it, so the fresh user watches
 * the full loop (dispatch → agent works → memory captured → hero context) without
 * having to think of something to build.
 *
 * SAFETY INVARIANTS, the sample is:
 *   - STRICTLY READ-ONLY: the brief asks the agent to SUMMARIZE the repository's
 *     top-level structure and report it back — it creates, edits, moves, and
 *     deletes NOTHING. The first task must never write to the user's repo (BUG 1),
 *     so there is nothing to litter, nothing to clean up, and no way it can damage
 *     an existing file.
 *   - WORKSPACE-SCOPED: it runs in the folder the user picked, which the backend
 *     validates against the P3-B allowlist on both task-create and dispatch.
 *   - OPT-IN ONLY: nothing here runs on merely choosing/opening a directory —
 *     it is seeded solely by the explicit "Run your first task" action.
 *   - VENDOR-TOKEN-FREE: quickstart only reads readiness booleans and drives the
 *     user's already-connected vendor CLI. It never sees, stores, or forwards a
 *     vendor token (same trust discipline as P2b onboarding).
 *
 * Pure + structurally-typed so all three surfaces (CLI `quickstart`, the desktop
 * "Run your first task" button, a TUI affordance) share ONE truth and it tests
 * deterministically against a mock client (no real dispatch, no real vendor CLI).
 */

/**
 * Stable, durable marker prefixing every quickstart-seeded task title. Cleanup
 * ({@link ./quickstart-cleanup.ts}) matches lingering quickstart work on this
 * prefix, so it survives copy changes to the sample title AND still matches a
 * task seeded by an OLDER build (e.g. the pre-BUG-1 "…add a greet() helper"
 * sample). Keep every quickstart title starting with this exact string.
 */
export const QUICKSTART_TASK_MARKER = "MUON quickstart:";

/** The sample task the quickstart seeds — tiny, safe, and strictly READ-ONLY. */
export const QUICKSTART_SAMPLE = {
  title: `${QUICKSTART_TASK_MARKER} summarize this repository's structure`,
  description:
    "A tiny, safe first task so you can watch MUON's whole loop run end to end: " +
    "dispatch → the agent works → memory is captured → the pre-edit hero surfaces it. " +
    "It is strictly READ-ONLY — the agent summarizes your repository's top-level " +
    "structure and writes nothing, so it can never create, edit, or delete a single " +
    "file you already have.",
  /**
   * The brief handed to the dispatched agent. Deliberately READ-ONLY: it reports
   * a summary and never writes to the workspace, so the first task always leaves
   * the repository exactly as it found it (BUG 1).
   */
  brief:
    "Summarize this repository's top-level structure and report it back in your " +
    "final message: list the top-level files and folders and briefly note what each " +
    "area appears to be for. This is a strictly READ-ONLY task — do NOT create, " +
    "edit, move, or delete any file, and do NOT run anything that changes the " +
    "workspace. Leave the repository exactly as you found it.",
  priority: "low" as TaskPriority,
} as const;

/** The minimal client surface the quickstart needs, trivially mockable in tests. */
export type QuickstartClient = {
  createTask(input: {
    title: string;
    description: string;
    priority: TaskPriority;
    workspacePath?: string;
  }): Promise<Task>;
  enqueueDispatch(input: {
    kind?: DispatchKind;
    vendor: string;
    taskId: string;
    brief: string;
    workspacePath?: string;
    dispatchedBy?: string;
    harnessKey?: string;
  }): Promise<DispatchJobRecord>;
};

/**
 * The first READY vendor to dispatch the sample to (stable onboarding order),
 * or `null` when nothing is connected yet. Reuses the P2b state machine so
 * "ready" means the exact same thing everywhere (installed AND authenticated).
 */
export function pickQuickstartVendor(
  readiness: VendorReadiness[] | null | undefined
): string | null {
  return buildOnboardingState(readiness).readyVendors[0] ?? null;
}

export type QuickstartOutcome =
  | { ok: true; vendor: string; task: Task; job: DispatchJobRecord }
  /** No vendor is ready, the caller routes to onboarding (never a dead-end). */
  | { ok: false; reason: "no-vendor-ready" };

/**
 * Seed the sample task into `workspacePath` and dispatch it to a ready vendor.
 * When no vendor is ready it returns `{ ok:false, reason:"no-vendor-ready" }` so
 * the caller can route the user to onboarding instead of dead-ending.
 *
 * Never runs anything destructive: the brief is READ-ONLY and the workspace is
 * the user's chosen folder (backend-validated against the P3-B allowlist).
 */
export async function seedQuickstartTask(
  client: QuickstartClient,
  opts: {
    workspacePath: string;
    readiness?: VendorReadiness[] | null;
    /** Force a specific ready vendor; otherwise the first ready one is chosen. */
    vendor?: string;
  }
): Promise<QuickstartOutcome> {
  const vendor = opts.vendor ?? pickQuickstartVendor(opts.readiness);
  if (!vendor) {
    return { ok: false, reason: "no-vendor-ready" };
  }

  const task = await client.createTask({
    title: QUICKSTART_SAMPLE.title,
    description: QUICKSTART_SAMPLE.description,
    priority: QUICKSTART_SAMPLE.priority,
    workspacePath: opts.workspacePath,
  });

  const job = await client.enqueueDispatch({
    // ONESHOT + the read-only RESEARCH harness: the first task summarizes and
    // exits — it physically CANNOT create/edit a file (research withholds the
    // edit tools + a read-only sandbox), so it never triggers a spurious
    // "approve muon-test.ts" gate, and oneshot lands on the chat faster than a
    // steerable interactive session. (BUG 1: the first task never writes.)
    kind: "oneshot",
    harnessKey: "research",
    vendor,
    taskId: task.id,
    brief: QUICKSTART_SAMPLE.brief,
    workspacePath: opts.workspacePath,
    // Provenance only; the backend derives the real dispatcher from the auth
    // tier (an operator surface → "human:*"), so this can never forge a tier.
    dispatchedBy: "human:quickstart",
  });

  return { ok: true, vendor, task, job };
}
