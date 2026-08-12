import type { PreEditActivity } from "@muon/graph";
import {
  coordinationPartitionReady,
  dispatchJobPartitionWhere,
  type CoordinationPartition,
} from "./coordination-partition.js";
import type { prisma as PrismaClient } from "./db.js";

/**
 * KG-7 (ADR-0014 §6) — the LIVE cross-agent activity reader (the "present tense"
 * the pre-edit hero lacks). It derives, from truth the ledger ALREADY holds, which
 * OTHER live lane is currently working on the edit target's symbol/module:
 *
 *   1. the atomic "who is running what" state — `DispatchJob(status='running')`,
 *      which the runner claim/release spine maintains and self-corrects on crash
 *      (`reclaimDispatchJobs`), so a crashed lane can't leak a false "live";
 *   2. the append-only `Event` log, which carries `metadata.modules` (and, KG-7,
 *      `metadata.symbols`) declaring what each running task is touching.
 *
 * It is a PASSIVE read composition over append-only truth — no new write actor, no
 * new trust class, no network. When there is no reader, no running job, or no
 * anchor intersection, it returns `[]` and the hero degrades to exactly today's
 * output (reversibility by construction).
 *
 * COORDINATES, NEVER CONTENT — the load-bearing invariant. Both queries SELECT
 * ONLY the non-content-bearing coordinate columns:
 *   - DispatchJob → { id, vendor, taskId, dispatchedBy }  (NEVER `brief`)
 *   - Event       → { metadata, timestamp, laneId }       (NEVER `message`)
 * and the emitted `PreEditActivity` carries only lane/vendor/task/job IDs, the
 * shared anchor, a fixed `kind` enum, `at`, and `state`. No `Event.message`,
 * `DispatchJob.brief`, `Task.title/description`, or any note/free-form text is ever
 * read into — let alone surfaced through — this channel. This mirrors the
 * `pendingProposals` omission discipline: untrusted, agent-authored signal reaches
 * an agent as STRUCTURE only, and a side-channel audit test pins it.
 */

/** How many recent events per running task the reader scans for an anchor touch.
 *  Bounded so a chatty task can't amplify the read (the live set is already tiny —
 *  ≤ fleet-cap × vendors running jobs). */
const EVENT_SCAN = 25;

/** Coerce an unknown JSON value into a clean string[] (drops non-strings/empties).
 *  Event.metadata is free-form JSON; we read only its coordinate arrays. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0
      )
    : [];
}

/**
 * Build the pre-edit activity reader closure the hero calls (`PreEditOptions
 * .activityReader`). Given the query anchors (the edit target's exact symbols +
 * its modules) and the caller's own ids to exclude, it returns one
 * `PreEditActivity` per running peer job that is touching one of those anchors —
 * preferring a SYMBOL match (finer, `kind:"editing"`) over a MODULE match
 * (`kind:"running"`), anchored at the most-recent touching event.
 */
export function readLiveActivity(
  prisma: typeof PrismaClient,
  partition?: CoordinationPartition | null
) {
  return async (
    anchors: { symbols: string[]; modules: string[] },
    exclude?: { taskId?: string; jobId?: string }
  ): Promise<PreEditActivity[]> => {
    // Substrate §3.1: no workspace → empty, never a global scan.
    if (!coordinationPartitionReady(partition)) {
      return [];
    }
    const symbolSet = new Set(anchors.symbols);
    const moduleSet = new Set(anchors.modules);
    // No anchors to join against → no possible collision → today's hero exactly.
    if (symbolSet.size === 0 && moduleSet.size === 0) {
      return [];
    }

    // 1. The present tense: currently-running jobs, coordinate columns ONLY, with
    //    the caller's own job/task excluded so a lane never reports ITSELF (#5).
    //    Workspace (+ chat) sit in the candidate query — never a post-filter.
    const jobs = await prisma.dispatchJob.findMany({
      where: {
        status: "running",
        ...dispatchJobPartitionWhere(partition),
        ...(exclude?.taskId ? { taskId: { not: exclude.taskId } } : {}),
        ...(exclude?.jobId ? { id: { not: exclude.jobId } } : {}),
      },
      // Belt-and-suspenders bound on the fan-out N (the live set is already tiny —
      // ≤ fleet-cap × vendors — but a crash-stale `running` row or a dispatch flood
      // must not amplify this read, matching EVENT_SCAN / MAX_ANCHOR_MODULES).
      take: 64,
      // COORDINATES ONLY — note the deliberate absence of `brief`.
      select: { id: true, vendor: true, taskId: true },
    });
    if (jobs.length === 0) {
      return [];
    }

    const out: PreEditActivity[] = [];
    const seen = new Set<string>();
    for (const job of jobs) {
      // 2. What is this running task touching? Its recent events carry it. SELECT
      //    coordinate columns ONLY — never `message` (the free-form field).
      const events = await prisma.event.findMany({
        where: { taskId: job.taskId },
        orderBy: { timestamp: "desc" },
        take: EVENT_SCAN,
        select: { metadata: true, timestamp: true, laneId: true },
      });

      // 3. Intersect with the query anchors. Prefer a SYMBOL match (the finest,
      //    ADR-0012 anchor) at the most-recent touching event; else a MODULE match.
      let matched:
        | {
            anchor: string;
            anchorKind: "symbol" | "module";
            at: Date;
            laneId: string;
          }
        | undefined;
      if (symbolSet.size > 0) {
        for (const ev of events) {
          const meta = ev.metadata as { symbols?: unknown } | null;
          const hit = stringArray(meta?.symbols).find((s) => symbolSet.has(s));
          if (hit) {
            matched = {
              anchor: hit,
              anchorKind: "symbol",
              at: ev.timestamp,
              laneId: ev.laneId,
            };
            break;
          }
        }
      }
      if (!matched && moduleSet.size > 0) {
        for (const ev of events) {
          const meta = ev.metadata as {
            modules?: unknown;
            intentModules?: unknown;
          } | null;
          const hit = [
            ...stringArray(meta?.modules),
            ...stringArray(meta?.intentModules),
          ].find((m) => moduleSet.has(m));
          if (hit) {
            matched = {
              anchor: hit,
              anchorKind: "module",
              at: ev.timestamp,
              laneId: ev.laneId,
            };
            break;
          }
        }
      }
      if (!matched) {
        continue;
      }

      // Dedupe on (job, anchor) so one running job on one anchor emits once.
      const key = `${job.id}:${matched.anchor}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({
        laneId: matched.laneId,
        vendor: job.vendor,
        taskId: job.taskId,
        jobId: job.id,
        // A declared symbol touch is "editing"; a module-only touch is "running".
        kind: matched.anchorKind === "symbol" ? "editing" : "running",
        anchor: matched.anchor,
        anchorKind: matched.anchorKind,
        at: matched.at.toISOString(),
        state: "live",
      });
    }
    return out;
  };
}

/**
 * KG-8 (ADR-0014) — the bounded RECENT-activity window. A peer touch older than
 * this (relative to now) is not "recent" and is excluded from the read. 24h: long
 * enough to catch "another lane worked here yesterday", short enough that the
 * surface stays about CURRENT collision risk rather than archaeology. A named
 * constant so the freshness cutoff is one tunable knob (ADR-0014 §7 / KG-11).
 */
export const RECENT_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The single graph capability the recent leg needs — the KG-8 read. Narrowed to
 *  one method so a test can inject a fake, and so the reader can NEVER reach for a
 *  content-bearing graph method (the recent projection has no content column). */
export type ActivityGraph = {
  recentActivityOn(
    anchors: { symbols: string[]; modules: string[] },
    sinceIso: string,
    exclude?: { taskId?: string; jobId?: string },
    /** Substrate §3.1: task ids already inside the workspace/chat partition. */
    allowedTaskIds?: readonly string[] | null
  ): Promise<PreEditActivity[]>;
};

/**
 * KG-8 (ADR-0014) — the FUSED cross-agent activity reader the hero calls: LIVE
 * (KG-7, present tense — running `DispatchJob`s over the Event log) PLUS RECENT
 * (KG-8, past tense — the rebuildable `ACTED_ON` projection within a bounded
 * window), on ONE coordinate-only channel. Keeps the SAME `activityReader`
 * injection signature `(anchors, exclude) => PreEditActivity[]` so `preEditContext`'s
 * activity block is unchanged; the graph is threaded in HERE (the route wires
 * `getGraph()`), not into the hero.
 *
 * DEDUP (#4): a task that is LIVE on an anchor must not ALSO appear recent for the
 * same (task, anchor) — live wins. COORDINATES, NEVER CONTENT: both legs select
 * only allowlisted coordinate columns. DEGRADE: the recent leg is wrapped so a
 * missing/throwing graph read never 500s the gate — it falls back to live-only (or
 * []); no new network. Self-exclusion applies to BOTH legs.
 */
export function readActivity(
  prisma: typeof PrismaClient,
  graph: ActivityGraph,
  opts?: { now?: () => number; partition?: CoordinationPartition | null }
) {
  const partition = opts?.partition;
  const live = readLiveActivity(prisma, partition);
  const clock = opts?.now ?? (() => Date.now());
  return async (
    anchors: { symbols: string[]; modules: string[] },
    exclude?: { taskId?: string; jobId?: string }
  ): Promise<PreEditActivity[]> => {
    if (!coordinationPartitionReady(partition)) {
      return [];
    }
    // LIVE (KG-7) — the present tense, partition already in the query.
    const liveRows = await live(anchors, exclude);

    // RECENT (KG-8) — the past tense, over a bounded window floor (an ms-UTC-Z
    // instant, lexicographically comparable to the stored `at`). Wrapped in
    // try/catch (not just `.catch`) so a SYNCHRONOUS throw also degrades — a graph
    // error can NEVER 500 the gate; it falls back to live-only.
    let recentRows: PreEditActivity[] = [];
    try {
      const sinceIso = new Date(clock() - RECENT_ACTIVITY_WINDOW_MS).toISOString();
      // Resolve allowed task ids from the ledger partition BEFORE the Cypher
      // walk so the recent leg never post-filters foreign workspace rows.
      let allowedTaskIds: string[] | null = null;
      if (partition && !partition.allowGlobal) {
        const scoped = await prisma.dispatchJob.findMany({
          where: dispatchJobPartitionWhere(partition),
          select: { taskId: true },
          distinct: ["taskId"],
          take: 500,
        });
        allowedTaskIds = scoped.map((row) => row.taskId);
        if (allowedTaskIds.length === 0) {
          return liveRows;
        }
      }
      recentRows = await graph.recentActivityOn(
        anchors,
        sinceIso,
        exclude,
        allowedTaskIds
      );
    } catch {
      recentRows = [];
    }

    // DEDUP live vs recent (#4): live wins. `taskId` is present on both legs (a
    // recent row's `jobId` may be "" when no DispatchJob claim-state was known), so
    // key on (taskId, anchor) — a job live on an anchor is never also emitted recent
    // for that same anchor. A NUL joiner keeps the key unambiguous.
    const liveKeys = new Set(
      liveRows.map((row) => `${row.taskId} ${row.anchor}`)
    );
    const dedupedRecent = recentRows.filter(
      (row) => !liveKeys.has(`${row.taskId} ${row.anchor}`)
    );

    // preedit.ts orders the fused channel (live before recent, then `at` DESC).
    return [...liveRows, ...dedupedRecent];
  };
}
