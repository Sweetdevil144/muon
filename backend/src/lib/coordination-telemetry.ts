import type { Prisma } from "@prisma/client";
import { AGENT_PRINCIPAL } from "./auth.js";
import { prisma } from "./db.js";
import { buildEventAuditStamp, eventAuditData } from "./event-audit.js";

/**
 * A REFUSED CLAIM is an event (task #92's missing number).
 *
 * `/claims` already refuses a colliding claim and tells the caller who holds
 * the ground — but it recorded nothing, so the moment passed with the HTTP
 * response. That is the same shape as the delivery gap of task #99: the thing
 * the coordination layer exists to do was the thing nothing could prove
 * afterwards. "Two agents were given overlapping work and one re-planned" is
 * stance test T2, and it was unmeasurable BY CONSTRUCTION.
 *
 * COORDINATE-ONLY, like every other row on this spine: job ids, the contended
 * coordinate, the intents. No subject, no body, no note text — a refusal is
 * about ground, and the ground is a path.
 *
 * FIRE-AND-FORGET, and never able to fail a claim. A telemetry write that can
 * reject a claim would make the coordination layer less available than the
 * uncoordinated one it replaces; the ledger's answer to the caller has already
 * been decided by the time this runs.
 */
export const CLAIM_REFUSED_EVENT_KIND = "crew.claim_refused";

export type ClaimRefusalRecord = {
  /** The job that asked and did not get it. */
  jobId: string;
  chatId: string;
  /** The contended coordinate, as the requester spelled it. */
  coordinate: string;
  /** The job that holds the ground the requester must yield to. */
  heldByJobId: string;
  /**
   * The holder's CLAIM row — its identity, not just its job.
   *
   * Without it the dedup key cannot tell one collision from the next: a holder
   * that releases (or lets a claim lapse) and re-acquires the same coordinate
   * inside the window looks identical to the original, so a genuinely NEW
   * yield would be suppressed. The documented contract is "deduped while that
   * collision lasts"; the claim id is what makes "that collision" a thing.
   */
  heldClaimId: string;
  requestedIntent: string;
  heldIntent: string;
};

/**
 * One refusal per (job, coordinate, holder) — for as long as that collision
 * lasts.
 *
 * An agent that retries or polls a contended claim hits `/claims` repeatedly,
 * and each call recomputes the same blocker from the peer's live row. Recorded
 * per call, ONE collision became a growing count and an unbounded event
 * stream — and the number it inflates is the headline one, the only figure
 * that claims coordination changed somebody's plan. A retry is not a second
 * yield.
 *
 * In-process and best-effort by design: the Event table stays the durable
 * record, and a brain restart re-arming one extra row per live collision is
 * far cheaper than a query on every refused claim. Entries are dropped once
 * the collision is old enough to be a genuinely new event.
 */
const RECENT_REFUSALS = new Map<string, number>();
const REFUSAL_DEDUP_WINDOW_MS = 15 * 60_000;
/**
 * A HARD CEILING, because the time window alone does not bound this.
 *
 * The map is process-wide — every chat, every job, every coordinate — and its
 * sweep only runs when something is recorded. "A crew has a bounded number of
 * live collisions" is true per crew and says nothing about a brain serving
 * many; a burst of distinct collisions could accumulate one entry each for
 * fifteen minutes. Past this, the OLDEST entries go: dropping one means at
 * worst a duplicate row for a very old collision, which is the harmless
 * direction.
 */
const MAX_TRACKED_REFUSALS = 4_096;

function refusalIsFresh(key: string, nowMs: number): boolean {
  // Opportunistic sweep: this map only ever holds live collisions, and a crew
  // has a bounded number of those.
  for (const [seen, at] of RECENT_REFUSALS) {
    if (nowMs - at > REFUSAL_DEDUP_WINDOW_MS) RECENT_REFUSALS.delete(seen);
  }
  const previous = RECENT_REFUSALS.get(key);
  if (previous !== undefined && nowMs - previous <= REFUSAL_DEDUP_WINDOW_MS) {
    return false;
  }
  RECENT_REFUSALS.set(key, nowMs);
  if (RECENT_REFUSALS.size > MAX_TRACKED_REFUSALS) {
    // Map iteration is insertion-ordered, so this drops the oldest first.
    const excess = RECENT_REFUSALS.size - MAX_TRACKED_REFUSALS;
    let dropped = 0;
    for (const seen of RECENT_REFUSALS.keys()) {
      if (dropped >= excess) break;
      RECENT_REFUSALS.delete(seen);
      dropped += 1;
    }
  }
  return true;
}

/** Test seam: forget every deduped refusal. */
export function resetClaimRefusalDedup(): void {
  RECENT_REFUSALS.clear();
}

export function recordClaimRefused(entry: ClaimRefusalRecord): void {
  const key = `${entry.jobId}\u0000${entry.coordinate}\u0000${entry.heldClaimId}`;
  if (!refusalIsFresh(key, Date.now())) {
    return;
  }
  void Promise.resolve()
    .then(() => {
      const stamp = buildEventAuditStamp({ actor: AGENT_PRINCIPAL });
      return prisma.event.create({
        data: {
          laneId: "muon",
          taskId: entry.jobId,
          kind: CLAIM_REFUSED_EVENT_KIND,
          message: `claim refused on ${entry.coordinate}`,
          metadata: {
            jobId: entry.jobId,
            chatId: entry.chatId,
            coordinate: entry.coordinate,
            heldByJobId: entry.heldByJobId,
            requestedIntent: entry.requestedIntent,
            heldIntent: entry.heldIntent,
            // Coordinates and ids only — never a subject or a body.
          } as Prisma.InputJsonValue,
          ...eventAuditData(stamp),
        },
      });
    })
    .catch(() => undefined);
}
