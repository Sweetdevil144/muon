import type { ReviewThreadDigest } from "../../shared/ipc.js";

/**
 * H1 — the bound review thread, projected for the dock strip.
 *
 * The strip's whole claim is "here is the DELTA, and here are the ids that
 * prove it". So this module counts and names; it never summarises. Two rules
 * it exists to keep:
 *
 *  1. IDS ARE THE EVIDENCE. Packet ids, gate ids and question ids travel to
 *     the screen unchanged. Nothing here reads packet prose, and nothing may
 *     start to — a paraphrase of what an agent claimed is not evidence that it
 *     happened, and the digest route deliberately does not even send the text.
 *  2. "CANNOT TELL" IS NOT "FINE" (H2). The route reports three states, not
 *     two: a packet that SAYS degraded, one that says it is not, and one whose
 *     degraded flag could not be read at all (legacy row, malformed body). The
 *     third is counted and named separately — never folded into the clean
 *     count, because a packet nobody can vouch for that looks like an empty
 *     inbox is the exact failure H1 and H2 both name, and never folded into the
 *     degraded count either, because that would brand every legacy row a
 *     failure it never declared.
 *  3. WHAT IS STILL BLOCKING IS THE ROUTE'S CALL, NOT THIS MODULE'S. Each row
 *     carries `standing` — the route's own answer to "does the cursor hold
 *     this?" — and `stillBlocking` counts exactly those. This module used to
 *     re-derive the answer, and drifted: it counted every unverifiable packet
 *     as blocking while the route's cursor quietly retired them, so the strip
 *     promised a blocker "Mark reviewed" had already cleared. One classifier,
 *     server-side. The `degraded !== false` fallback below is only for a
 *     backend older than the field, and it is a conservative FLOOR of the
 *     route's rule, not a copy of it: the route also knows whether an earlier
 *     packet on that task read CLEAN, which is what settles a wrap that
 *     declared nothing. So the fallback can hold one row the current route has
 *     already settled; it never releases one the route holds.
 */

export type ReviewDigestSummary = {
  /** Nothing appeared, changed, or is blocking. */
  empty: boolean;
  /** "never", or how long ago the cursor was stamped. */
  sinceLabel: string;
  /** True when this principal has never marked the thread reviewed. */
  neverLooked: boolean;
  /** Wrap packets in the digest (new since the cursor + standing blockers). */
  packets: number;
  /** …of which are NEW since the cursor (the informational delta). */
  newPackets: number;
  /** …of which declared their OWN evidence missing (`degraded.flag`). */
  degradedPackets: number;
  /** …whose degraded flag could not be read at all, so nothing was checked. */
  unknownPackets: number;
  /**
   * …that the cursor cannot clear: the task's CURRENT packet, which nothing
   * readable on that task vouches for — it declared itself degraded, it carried
   * a degraded flag MUON could not read, or it declared nothing at all on a task
   * with no clean reading behind it. Only a packet that READS clean retires one.
   */
  standingPackets: number;
  /** Gates in the digest (appeared/decided since the cursor + still pending). */
  gateChanges: number;
  /** …of which are NEW since the cursor. */
  newGates: number;
  /** …still awaiting a decision — standing, cursor-independent. */
  pendingGates: number;
  /** Blocking questions open on this thread right now. */
  openQuestions: number;
  /**
   * The cursor cannot clear these: standing packets (the task's current wrap,
   * with nothing readable on that task vouching for it), pending gates, open
   * questions. Mark reviewed clears only the delta.
   */
  stillBlocking: number;
  /** The digest's server-read timestamp, echoed back on advance so the
   *  render→click window is not consumed unseen. Absent on an older backend. */
  digestAt?: string;
  packetIds: string[];
  gateIds: string[];
  questionIds: string[];
  /** The brain hit its own row bound; the delta shown is a floor, not a total. */
  truncated: boolean;
  /** The one line the strip leads with. */
  headline: string;
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * "4m ago" / "3h ago" / "2d ago" — the same ladder as `freshnessLabel`
 * (lib/lane-status), kept in this module because it answers a different
 * question (a cursor, not a probe) and must not inherit that one's
 * probe-state vocabulary.
 */
export function lookedAgoLabel(
  lastLookedAt: string | null,
  now: number = Date.now()
): string {
  if (!lastLookedAt) return "never";
  const stamped = Date.parse(lastLookedAt);
  if (Number.isNaN(stamped)) return "unknown";
  const age = Math.max(0, now - stamped);
  if (age < 60_000) return "just now";
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
  return `${Math.floor(age / 86_400_000)}d ago`;
}

export function summarizeReviewDigest(
  digest: ReviewThreadDigest,
  now: number = Date.now()
): ReviewDigestSummary {
  const packets = digest.handoffs.length;
  // `newSinceLook` absent (older backend) → the row IS the delta, the old
  // all-delta semantics — treat as new rather than inventing a blocker.
  const newPackets = digest.handoffs.filter(
    (row) => row.newSinceLook !== false
  ).length;
  const degradedPackets = digest.handoffs.filter(
    (row) => row.degraded === true
  ).length;
  // `null` = the route could not read this row's flag. NOT counted as degraded
  // (it never declared anything) and NOT counted as clean (nothing was checked).
  const unknownPackets = digest.handoffs.filter(
    (row) => row.degraded === null
  ).length;
  // The route's own verdict. `standing` absent (older backend) → the floor of
  // its rule: anything but a packet that DECLARED itself clean is held. Held is
  // the safe side of that guess — the route may have settled one more row (a
  // wrap that declared nothing, on a task whose earlier packet read clean), and
  // only the route can know that.
  const isStanding = (row: (typeof digest.handoffs)[number]): boolean =>
    row.standing ?? row.degraded !== false;
  const standingRows = digest.handoffs.filter(isStanding);
  // Partitioned EXHAUSTIVELY on the unreadable flag, so the "Still blocking"
  // sentence and `stillBlocking` can never disagree about a row: every standing
  // packet is named, and one MUON cannot read is named as such rather than
  // being quietly dropped from the copy while it is counted.
  const standingUnverifiable = standingRows.filter(
    (row) => row.degraded === null
  ).length;
  const standingDegraded = standingRows.length - standingUnverifiable;
  const gateChanges = digest.approvals.length;
  const newGates = digest.approvals.filter(
    (row) => row.newSinceLook !== false
  ).length;
  const pendingGates = digest.approvals.filter(
    (row) => row.status === "pending"
  ).length;
  const openQuestions = digest.openQuestionIds.length;
  // The cursor clears only the delta; these persist until repaired, decided,
  // or answered — which is exactly why Mark reviewed cannot fake a clear desk.
  // Counted off `standing`, NOT off every degraded row in the digest: a
  // degraded packet a later clean wrap already superseded rides the delta and
  // is history, so counting it here would invent a blocker.
  const stillBlocking =
    standingRows.length + pendingGates + openQuestions;
  const newCount = newPackets + newGates;
  const empty = packets === 0 && gateChanges === 0 && openQuestions === 0;
  const sinceLabel = lookedAgoLabel(digest.lastLookedAt, now);

  const deltaParts = [
    plural(newPackets, "packet"),
    plural(newGates, "gate change"),
  ];
  const blockingParts = [
    ...(standingDegraded > 0
      ? [plural(standingDegraded, "degraded packet")]
      : []),
    ...(standingUnverifiable > 0
      ? [plural(standingUnverifiable, "unverifiable packet")]
      : []),
    ...(pendingGates > 0 ? [plural(pendingGates, "pending gate")] : []),
    ...(openQuestions > 0 ? [plural(openQuestions, "open question")] : []),
  ];

  const headline = empty
    ? "Nothing new since you last looked, and nothing blocking."
    : [
        newCount > 0
          ? `Since you last looked (${sinceLabel}): ${deltaParts.join(", ")}.`
          : `Nothing new since you last looked (${sinceLabel}).`,
        ...(blockingParts.length > 0
          ? [`Still blocking: ${blockingParts.join(", ")}.`]
          : []),
      ].join(" ");

  return {
    empty,
    sinceLabel,
    neverLooked: digest.lastLookedAt === null,
    packets,
    newPackets,
    degradedPackets,
    unknownPackets,
    standingPackets: standingRows.length,
    gateChanges,
    newGates,
    pendingGates,
    openQuestions,
    stillBlocking,
    ...(digest.digestAt ? { digestAt: digest.digestAt } : {}),
    packetIds: digest.handoffs.map((row) => row.id),
    gateIds: digest.approvals.map((row) => row.id),
    questionIds: [...digest.openQuestionIds],
    truncated: digest.truncated,
    headline,
  };
}
