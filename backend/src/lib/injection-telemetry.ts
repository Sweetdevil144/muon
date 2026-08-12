import type { Prisma } from "@prisma/client";
import { MEMORY_INJECTED_EVENT_KIND } from "@muon/client";
import { AGENT_PRINCIPAL, OPERATOR_PRINCIPAL } from "./auth.js";
import { prisma } from "./db.js";
import {
  buildEventAuditStamp,
  eventAuditData,
} from "./event-audit.js";

/**
 * Substrate §3.3 — coordinate-only ledger for path-triggered memory injection.
 *
 * Each row proves MUON delivered a standing note at an edit boundary for a given
 * job (noteId + jobId + anchor + gate tier). No prose. Dedup is "has this
 * (jobId, noteId) already been recorded?" — once-per-job, replayable from Event.
 *
 * The kind NAME lives in `@muon/client` (round-3 #15): the bundle collector
 * filters by it, and two restated literals drift. Re-exported here so this
 * module's importers are unchanged — same move as
 * `GRAPH_MIRROR_FAILED_EVENT_KIND` in `graph.ts`.
 */
export { MEMORY_INJECTED_EVENT_KIND };

export type InjectionRecord = {
  noteId: string;
  jobId: string;
  anchor: string;
  gateTier: "human_confirmed" | "crew_vouched" | "trust_floor";
  tier: string;
  /**
   * Slice 3 (delivery, 2026-08-11) — three optional fields so a DELIVERY is a
   * measurable event, not an inference:
   *
   * `reason` names the boundary that fired ("crew-finding-at-preedit");
   * `recipientJobId` names who received it (redundant with jobId today, kept
   * explicit so a future boundary that records on behalf of another job
   * cannot conflate the two); `contentHash` is the sha256 of the delivered
   * text, so a finding whose note was EDITED re-fires instead of being
   * deduped into silence — dedup is per (job, note, content), never per
   * (job, note) alone.
   *
   * Optional, because every pre-existing row lacks them and a record is a
   * record (never validate a stored record against a shape that grew).
   */
  reason?: string;
  contentHash?: string;
  recipientJobId?: string;
};

/** True when this job already received this note via path-triggered injection. */
/**
 * True when this job already received this note AT THIS CONTENT, FOR THIS
 * REASON.
 *
 * THE REASON IS PART OF THE KEY, and leaving it out was a real defect (task
 * #99, found because a test went flaky 3-in-8 instead of failing honestly).
 * Two different deliveries write to this same Event kind for the same
 * (job, note) pair: the pre-edit gate's path-triggered STANDING injection
 * (preedit.ts, via `injectionLedgerForJob` — no reason, no contentHash) and
 * slice 3's CREW-FINDING delivery. Keyed on (job, note, content) alone, the
 * standing row matched first — its absent hash reading as "already
 * delivered" — and silently suppressed the crew-finding record. Which row
 * landed first was a race, so delivery telemetry under-reported
 * intermittently, exactly when the system was busy.
 *
 * A delivery is therefore (job, note, content, reason). Within one reason the
 * legacy rule still holds: a row written before contentHash existed cannot
 * say what content it carried, so it matches on the note alone rather than
 * re-firing forever.
 */
export async function hasDeliveredContent(
  jobId: string,
  noteId: string,
  contentHash: string,
  reason?: string
): Promise<boolean> {
  if (!jobId || !noteId) {
    return false;
  }
  const rows = await prisma.event.findMany({
    where: {
      kind: MEMORY_INJECTED_EVENT_KIND,
      taskId: jobId,
    },
    select: { metadata: true },
    take: 256,
  });
  return rows.some((row) => {
    const meta = row.metadata as
      | { noteId?: unknown; contentHash?: unknown; reason?: unknown }
      | null;
    if (meta?.noteId !== noteId) return false;
    // Different reason ⇒ different delivery. A standing injection never
    // stands in for a crew finding (or the reverse).
    if ((meta.reason as string | undefined) !== reason) return false;
    return meta.contentHash === undefined || meta.contentHash === contentHash;
  });
}

export async function hasInjectedForJob(
  jobId: string,
  noteId: string
): Promise<boolean> {
  if (!jobId || !noteId) {
    return false;
  }
  // SQLite JSON path filters are uneven across Prisma versions — load the job's
  // injection rows (bounded) and compare the coordinate in JS.
  const rows = await prisma.event.findMany({
    where: {
      kind: MEMORY_INJECTED_EVENT_KIND,
      taskId: jobId,
    },
    select: { metadata: true },
    take: 256,
  });
  return rows.some((row) => {
    const meta = row.metadata as { noteId?: unknown } | null;
    return meta?.noteId === noteId;
  });
}

/**
 * Best-effort producer. Never throws to the gate; swallows all errors.
 * Uses `taskId = jobId` so the job coordinate is addressable without a new column.
 */
export function recordMemoryInjected(entry: InjectionRecord): void {
  void Promise.resolve()
    .then(() => {
      const actor =
        entry.tier === "operator" ? OPERATOR_PRINCIPAL : AGENT_PRINCIPAL;
      const stamp = buildEventAuditStamp({ actor });
      return prisma.event.create({
        data: {
          laneId: "muon",
          taskId: entry.jobId,
          kind: MEMORY_INJECTED_EVENT_KIND,
          message: `path-triggered injection: ${entry.noteId}`,
          metadata: {
            noteId: entry.noteId,
            jobId: entry.jobId,
            anchor: entry.anchor,
            gateTier: entry.gateTier,
            ...(entry.reason ? { reason: entry.reason } : {}),
            ...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
            ...(entry.recipientJobId
              ? { recipientJobId: entry.recipientJobId }
              : {}),
            // Counts/ids/hashes only — never note text.
          } as Prisma.InputJsonValue,
          ...eventAuditData(stamp),
        },
      });
    })
    .catch(() => undefined);
}

/** Build the preEditContext injectionLedger seam for a resolved job id. */
export function injectionLedgerForJob(
  jobId: string | undefined,
  tier: string
):
  | {
      jobId: string;
      alreadyInjected: (noteId: string) => Promise<boolean>;
      record: (entry: {
        noteId: string;
        anchor: string;
        gateTier: "human_confirmed" | "crew_vouched" | "trust_floor";
      }) => void;
    }
  | undefined {
  if (!jobId) {
    return undefined;
  }
  return {
    jobId,
    alreadyInjected: (noteId) => hasInjectedForJob(jobId, noteId),
    record: (entry) =>
      recordMemoryInjected({
        ...entry,
        jobId,
        tier,
      }),
  };
}
