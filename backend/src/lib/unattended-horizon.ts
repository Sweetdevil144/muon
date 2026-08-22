import {
  ATTACHED_COORDINATOR_CAPABILITY_MODE,
  clampUnattendedHorizon,
  describeHorizonReap,
  evaluateUnattendedHorizon,
  UNATTENDED_HORIZON_DEFAULT_MS,
} from "@muon/protocol";
import { prisma } from "./db.js";
import { terminalizeJobLineage } from "./attached-coordinator.js";
// Attendance is a LEAF module (see its header): the auth hook imports it
// directly and must never reach this file's dependency tree.
import {
  daemonAttachState,
  hydrateAttendance,
  hydratePreviousSessionEnd,
  previousSessionEnd,
} from "./surface-attendance.js";

/**
 * ADR-0040 D3 + D3a — the bound on a daemon nobody returns to.
 *
 * ENABLED 2026-08-08, after the first attempt was built, reviewed, and
 * disabled without ever running. That attempt defined attendance as "an
 * operator-tier request arrived recently", which would have reaped a live
 * human at an attached terminal and could never have fired on the desktop.
 * D3a replaces it: attendance is ASSERTED by a surface with real evidence of a
 * person (`surface-attendance.ts`), never inferred from ambient traffic.
 *
 * Four properties this file is responsible for, each of which was a defect:
 *
 *  1. An attached coordinator is FENCED OUT. That session already has a
 *     liveness mechanism — its own short lease, swept by ADR-0028 §4 — and two
 *     liveness models governing one job is how one of them rots.
 *  2. A young root gets GRACE. Expiry is a property of the DAEMON, so without
 *     grace a mission dispatched into an already-expired daemon would be
 *     killed seconds after starting.
 *  3. The clock SURVIVES A RESTART (hydrated at boot, persisted on change).
 *     Process memory alone made a daemon that restarts hourly immortal.
 *  4. The horizon is WRITABLE, not just readable. A value only a hand-edit of
 *     SQLite can change is not configuration.
 */

/** Operator-configurable, read AND written (see `setConfiguredHorizonMs`). */
export const UNATTENDED_HORIZON_SETTING_KEY = "unattended.horizonMs";

/** Persisted so the clock survives a brain restart (D3a.4). */
export const LAST_ATTENDED_SETTING_KEY = "unattended.lastAttendedAt";

/** ADR-0085 D1: the digest boundary survives a restart the same way.
 *  NAMED RESIDUAL (review): this module owned attendance persistence
 *  before 0085 (LAST_ATTENDED_SETTING_KEY above), so the boundary key
 *  follows the existing seam; an attendance-store extraction is the
 *  module family's own refactor, taken when a third presence-derived
 *  consumer appears — not as a side effect of the digest. */
export const PREVIOUS_SESSION_SETTING_KEY = "unattended.previousSessionEndedAt";

/**
 * WRITE the horizon. Clamped on the way in, so an out-of-range value is
 * stored as the value that will actually be honoured rather than as a number
 * the reader silently disagrees with.
 */
export async function setConfiguredHorizonMs(requestedMs: number): Promise<number> {
  const clamped = clampUnattendedHorizon(requestedMs);
  await prisma.operatorSetting.upsert({
    where: { key: UNATTENDED_HORIZON_SETTING_KEY },
    create: { key: UNATTENDED_HORIZON_SETTING_KEY, value: String(clamped) },
    update: { value: String(clamped) },
  });
  return clamped;
}

/** Load the persisted attendance stamp into the leaf module. Boot-time only. */
export async function hydrateAttendanceFromStore(): Promise<void> {
  try {
    const row = await prisma.operatorSetting.findUnique({
      where: { key: LAST_ATTENDED_SETTING_KEY },
    });
    if (row) hydrateAttendance(Number(row.value));
    const boundary = await prisma.operatorSetting.findUnique({
      where: { key: PREVIOUS_SESSION_SETTING_KEY },
    });
    if (boundary) hydratePreviousSessionEnd(Number(boundary.value));
  } catch {
    // An unreadable stamp means "we do not know when anyone was last here",
    // and the safe reading of that is the conservative one: leave it null so
    // the daemon ages from process start.
  }
}

/**
 * Persist the attendance stamp.
 *
 * Throttled by the caller (the route only calls this when the in-memory clock
 * actually moved), so a focused desktop window ticking every 30s does not
 * write the database every tick.
 */
export async function persistAttendance(atMs: number): Promise<void> {
  // ADR-0085: the boundary persists WITH the stamp, in one transaction
  // (review finding: two independently swallowed upserts let a restart
  // hydrate the new stamp without its rolled boundary — the pair IS the
  // session boundary, so it lands atomically or not at all). Same failure
  // posture as before: a failed persist costs restart-durability, not
  // correctness — the in-memory state already moved.
  const boundary = previousSessionEnd();
  await prisma
    .$transaction([
      prisma.operatorSetting.upsert({
        where: { key: LAST_ATTENDED_SETTING_KEY },
        create: { key: LAST_ATTENDED_SETTING_KEY, value: String(atMs) },
        update: { value: String(atMs) },
      }),
      ...(boundary !== null
        ? [
            prisma.operatorSetting.upsert({
              where: { key: PREVIOUS_SESSION_SETTING_KEY },
              create: {
                key: PREVIOUS_SESSION_SETTING_KEY,
                value: String(boundary),
              },
              update: { value: String(boundary) },
            }),
          ]
        : []),
    ])
    .catch(() => {
      // See above: durability cost only, loudness lives with the sweep.
    });
}

/**
 * The configured horizon, clamped.
 *
 * An unreadable setting resolves to the DEFAULT rather than to the maximum —
 * the protocol module's rule, restated here only because the failure path
 * (a database read that throws) is this function's own.
 */
export async function readConfiguredHorizonMs(): Promise<number> {
  try {
    const row = await prisma.operatorSetting.findUnique({
      where: { key: UNATTENDED_HORIZON_SETTING_KEY },
    });
    if (!row) return UNATTENDED_HORIZON_DEFAULT_MS;
    return clampUnattendedHorizon(Number(row.value));
  } catch {
    return UNATTENDED_HORIZON_DEFAULT_MS;
  }
}

export type HorizonSweepOutcome = {
  readonly verdict: "not-applicable" | "within" | "expired";
  readonly reaped: string[];
};

/**
 * One bounded sweep. Safe on an interval or in a test.
 *
 * Reaps only ROOT jobs that are still running: descendants are interrupted by
 * the shared body through their own terminal path, which is the accounting
 * this must not duplicate.
 */
export async function sweepUnattendedHorizon(
  now = new Date()
): Promise<HorizonSweepOutcome> {
  const horizonMs = await readConfiguredHorizonMs();
  const verdict = evaluateUnattendedHorizon(
    daemonAttachState(now.getTime()),
    horizonMs,
    now.getTime()
  );
  if (verdict.kind !== "expired") {
    return { verdict: verdict.kind, reaped: [] };
  }

  const reason = describeHorizonReap({
    unattendedMs: verdict.unattendedMs,
    horizonMs: verdict.horizonMs,
  });
  // GRACE + FENCE, both load-bearing (D3a).
  //
  // `startedAt` older than the grace window: expiry is a property of the
  // DAEMON, not of the work, so a mission dispatched into an already-expired
  // daemon must not be killed seconds after it starts.
  //
  // `capabilityMode` not the attached-coordinator one: that session is a human
  // at a terminal, governed by its OWN lease sweep (ADR-0028 §4). Reaping it
  // here is the exact defect that kept this module disabled.
  const graceCutoff = new Date(now.getTime() - HORIZON_NEW_ROOT_GRACE_MS);
  const roots = await prisma.dispatchJob.findMany({
    where: {
      parentJobId: null,
      status: "running",
      createdAt: { lt: graceCutoff },
      NOT: { capabilityMode: ATTACHED_COORDINATOR_CAPABILITY_MODE },
    },
    select: { id: true, taskId: true },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  const reaped: string[] = [];
  for (const root of roots) {
    // The QUERY above is the fence (attached-coordinator roots are excluded),
    // so this call is explicitly unfenced by design rather than by omission —
    // `{ unfenced: true }` is greppable and an omission would not compile.
    if (
      !(await terminalizeJobLineage(root.id, reason, now, { unfenced: true }))
    ) {
      continue;
    }
    reaped.push(root.id);
    // Audited PER REAPED JOB, against that job's own task. D5 says the reason
    // must be visible on re-attach, and a surface re-attaches to a TASK — an
    // event filed against the daemon in general is a fact nobody is looking
    // at. "MUON ended this because nobody came back" is also a different kind
    // from a failure, so it gets its own.
    await prisma.event
      .create({
        data: {
          laneId: "muon",
          taskId: root.taskId,
          kind: "daemon.horizon_expired",
          message: reason,
          metadata: {
            unattendedMs: verdict.unattendedMs,
            horizonMs: verdict.horizonMs,
            jobId: root.id,
          },
        },
      })
      .catch(() => {
        /* the reap already happened; an unaudited reap is still a reap */
      });
  }
  return { verdict: "expired", reaped };
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Default cadence. Far below the horizon, so expiry is noticed promptly
 *  without the sweep itself being a load. */
export const HORIZON_SWEEP_INTERVAL_MS = 60_000;

/**
 * A root younger than this is never reaped, however long the daemon has been
 * unattended. Comfortably longer than one sweep interval so a job cannot be
 * born into the very tick that kills it.
 */
export const HORIZON_NEW_ROOT_GRACE_MS = 10 * 60_000;

/** Idempotent, and unref'd so it never keeps the process alive on its own —
 *  the same shape as the attached-coordinator sweep. */
export function startUnattendedHorizonSweep(
  intervalMs = HORIZON_SWEEP_INTERVAL_MS
): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void sweepUnattendedHorizon().catch((error) => {
      console.error(
        `unattended horizon sweep failed: ${
          error instanceof Error ? error.message : error
        }`
      );
    });
  }, intervalMs);
  sweepTimer.unref?.();
}

export function stopUnattendedHorizonSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
