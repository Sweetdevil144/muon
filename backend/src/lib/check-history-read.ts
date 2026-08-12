import { prisma } from "./db.js";
import {
  boundHistory,
  CHECK_HISTORY_WINDOW,
  checkRunOutcomeSchema,
  classifyFlakiness,
  describeFlakiness,
  type CheckRun,
} from "@muon/protocol";

/**
 * ADR-0037 — reading a check's history.
 *
 * No new table. Check outcomes already persist on `DispatchJob.packetJson`
 * (the typed v2 handoff packet carries `checks: HandoffCheck[]`), and that row
 * also carries `workspacePath` — so the history this feature needs is a READ
 * of what MUON already records, not a second copy of it. A parallel store
 * would be one more thing to keep in step with the packet, and the packet is
 * the thing the operator actually reads.
 *
 * The partition rule is the one that matters (ADR-0037 D5): history is keyed
 * `(workspacePath, check name)`, so one repository's `npm test` record can
 * never speak for another's. Same reasoning as ADR-0026 for memory — an
 * unfenced read here would report repo B's flakiness as evidence about repo A.
 */

/** How many recent terminal jobs to scan. Bounded so a long-lived workspace
 *  does not turn every packet build into a growing query. */
const JOB_SCAN_LIMIT = 60;

type PacketShape = {
  checks?: unknown;
};

/**
 * Pull the recent check runs for one workspace, grouped by check name.
 *
 * Everything here is defensive: `packetJson` is stored JSON, and a malformed
 * or legacy row must yield no history rather than throw inside a packet build.
 * A history that cannot be read is a history not shown — never a failed job.
 */
export type CheckHistory = {
  readonly byName: ReadonlyMap<string, CheckRun[]>;
  /**
   * True when the job scan hit its own limit, so older runs exist that were
   * never read. A verdict built on a truncated scan may report a failure it
   * saw, but must not report `stable` (ADR-0037 D2).
   */
  readonly truncated: boolean;
};

export async function readCheckHistory(
  workspacePath: string | null | undefined,
  options?: { limit?: number; window?: number }
): Promise<CheckHistory> {
  const byName = new Map<string, CheckRun[]>();
  if (!workspacePath) return { byName, truncated: false };

  let rows: {
    packetJson: unknown;
    endedAt: Date | null;
    createdAt: Date;
    workspacePath: string | null;
  }[] = [];
  try {
    rows = await prisma.dispatchJob.findMany({
      // Terminal jobs only. Without this, 60 queued/running jobs with no
      // packet consume the whole scan budget and every check in the workspace
      // silently reads `insufficient-evidence` — which an agent can cause on
      // purpose with cheap dispatches, erasing a `consistently-failing` label
      // from the operator's screen.
      where: {
        workspacePath,
        status: { in: ["done", "failed", "interrupted"] },
      },
      orderBy: { createdAt: "desc" },
      take: options?.limit ?? JOB_SCAN_LIMIT,
      // `workspacePath` is selected and stamped onto each run FROM THE ROW.
      // It used to be copied from the function argument, which made the fence
      // assertion in the tests true by construction — it would have passed with
      // the WHERE clause removed entirely. Found by adversarial review.
      select: {
        packetJson: true,
        endedAt: true,
        createdAt: true,
        workspacePath: true,
      },
    });
  } catch {
    return { byName, truncated: false };
  }

  // Oldest first, so `boundHistory`'s tail-keeping means "most recent".
  for (const row of [...rows].reverse()) {
    // Filtered here rather than in the WHERE: Prisma's Json-null filtering is
    // its own dialect, and a row without a packet is cheap to skip.
    const packet = row.packetJson as PacketShape | null;
    if (!packet || typeof packet !== "object") continue;
    const checks = packet.checks;
    if (!Array.isArray(checks)) continue;
    const at = (row.endedAt ?? row.createdAt).toISOString();
    for (const entry of checks) {
      if (!entry || typeof entry !== "object") continue;
      const name = (entry as { name?: unknown }).name;
      const outcome = checkRunOutcomeSchema.safeParse(
        (entry as { outcome?: unknown }).outcome
      );
      if (typeof name !== "string" || name === "" || !outcome.success) continue;
      const list = byName.get(name) ?? [];
      list.push({
        name,
        workspacePath: row.workspacePath ?? workspacePath,
        outcome: outcome.data,
        at,
      });
      byName.set(name, list);
    }
  }

  const window = options?.window ?? CHECK_HISTORY_WINDOW;
  for (const [name, runs] of byName) {
    byName.set(name, boundHistory(runs, window));
  }
  // The scan filled its budget, so there are older jobs it did not read. A
  // check that appears in only a minority of jobs (e2e, matrix, release) is
  // exactly the case this protects: without it, three recent passes read as
  // "stable" while three older failures sat outside the scan.
  const limit = options?.limit ?? JOB_SCAN_LIMIT;
  return { byName, truncated: rows.length >= limit };
}

/**
 * A lookup closure for `annotateChecks`.
 *
 * Returns an empty history for an unknown name, which classifies as
 * `insufficient-evidence` — the safe default. A check MUON has never seen
 * before must not read as `stable`.
 */
export function historyLookup(
  history: ReadonlyMap<string, CheckRun[]>
): (name: string) => readonly CheckRun[] {
  return (name: string) => history.get(name) ?? [];
}

/**
 * Annotate the checks inside stored handoff packets with their flakiness.
 *
 * Read-time derivation (ADR-0037): the packet keeps exactly what the run
 * observed and the history is computed beside it, so a figure never goes stale
 * in storage. `outcome` is untouched — a failed check stays failed, which is
 * the entire contract.
 *
 * Best-effort throughout: an unreadable history yields un-annotated packets
 * rather than a failed task read.
 */
/**
 * Strip any `flakiness` / `flakinessNote` a stored packet claims.
 *
 * `packetJson` is AGENT-PRODUCED UNTRUSTED DATA, and a forged annotation is
 * byte-identical in shape to a MUON-computed one — no consumer could tell them
 * apart. So the annotator is authoritative on EVERY path, including the early
 * returns where no history is available: a check leaves this module either with
 * MUON's own annotation or with none at all, never with the packet's.
 */
function stripClaimedFlakiness(check: Record<string, unknown>): Record<string, unknown> {
  if (!("flakiness" in check) && !("flakinessNote" in check)) return check;
  const { flakiness: _f, flakinessNote: _n, ...rest } = check;
  return rest;
}

function sanitizePacketChecks(packetJson: unknown): unknown {
  const packet = packetJson as { checks?: unknown } | null;
  if (!packet || typeof packet !== "object" || !Array.isArray(packet.checks)) {
    return packetJson;
  }
  return {
    ...packet,
    checks: packet.checks.map((entry) =>
      entry && typeof entry === "object"
        ? stripClaimedFlakiness(entry as Record<string, unknown>)
        : entry
    ),
  };
}

/**
 * Annotate the checks inside stored handoff packets with their flakiness.
 *
 * Read-time derivation (ADR-0037): the packet keeps exactly what the run
 * observed and the history is computed beside it, so a figure never goes stale
 * in storage. `outcome` is untouched — a failed check stays failed, which is
 * the entire contract.
 *
 * LENGTH-PRESERVING (ADR-0037 D4). Entries this module cannot annotate are
 * passed through unchanged rather than filtered out: an earlier version used
 * `.filter()` and made the result the replacement array, which silently DELETED
 * malformed entries — including their `outcome: "failed"`. That is worse than
 * the downgrade D1 forbids, and the ADR's own rejected-alternatives list names
 * it. Found by adversarial review.
 *
 * Best-effort throughout: an unreadable history yields packets with any claimed
 * annotation stripped, rather than a failed task read.
 */
export async function annotateHandoffChecks<
  T extends { packetJson: unknown },
>(handoffs: readonly T[], workspacePath: string | null | undefined): Promise<T[]> {
  if (handoffs.length === 0) return [...handoffs];

  let history: CheckHistory;
  try {
    history = await readCheckHistory(workspacePath);
  } catch {
    history = { byName: new Map(), truncated: false };
  }
  const lookup = historyLookup(history.byName);

  return handoffs.map((handoff) => {
    const packet = handoff.packetJson as { checks?: unknown } | null;
    if (!packet || typeof packet !== "object" || !Array.isArray(packet.checks)) {
      // Nothing to annotate, but a forged annotation must still not survive.
      return { ...handoff, packetJson: sanitizePacketChecks(handoff.packetJson) };
    }
    return {
      ...handoff,
      packetJson: {
        ...packet,
        checks: packet.checks.map((entry) => {
          if (!entry || typeof entry !== "object") return entry;
          const clean = stripClaimedFlakiness(entry as Record<string, unknown>);
          const name = (clean as { name?: unknown }).name;
          if (typeof name !== "string" || name === "") {
            // Unannotatable, but KEPT — its outcome is still evidence.
            return clean;
          }
          const flakiness = classifyFlakiness(
            lookup(name),
            CHECK_HISTORY_WINDOW,
            history.truncated
          );
          return {
            ...clean,
            flakiness,
            flakinessNote: describeFlakiness(flakiness),
          };
        }),
      },
    };
  });
}
