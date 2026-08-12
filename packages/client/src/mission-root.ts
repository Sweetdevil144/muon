import {
  buildDispatchForest,
  type DispatchTreeNode,
} from "./dispatch-view.js";
import type { DispatchJobRecord } from "./types.js";

/**
 * WHICH MISSION IS THIS CHAT SHOWING? — the one rule, for every surface.
 *
 * `GET /api/a2a/coordination` and `GET /api/a2a/messages` are addressed by
 * (chatId, missionId), and a mission is one ROOT DISPATCH LINEAGE. A chat holds
 * many roots: MUON's orchestrator turn ends the moment it has handed the work
 * out, the governed children it dispatched keep running long after, and the next
 * thing the human says opens a NEW root in the same chat.
 *
 * Every surface used to pick that root by "newest wins" — the desktop sorted
 * roots by their own status then `createdAt`, while the TUI and the CLI took
 * `jobs[jobs.length - 1].rootJobId ?? id`. On a real run that answered with a
 * childless follow-up turn while two children were visibly working: the org
 * chart said "no dispatch yet" on every lane, drew no dispatch edge, and the
 * coordination read was addressed to a mission with no peer traffic ("no peer
 * messages on this mission yet" under four real envelopes).
 *
 * So the mission is the root that owns the WORK, ranked over its WHOLE SUBTREE
 * (highest key first, each key beats every key below it):
 *
 *   1. a child is RUNNING — a crew that is actually executing wins, whatever
 *      else is newer. This is the founder's case: MUON's own turn had ended.
 *   2. else the root itself is live — running, or queued and still fresh: the
 *      turn under way beats a finished turn's leftovers.
 *   3. else a child is QUEUED AND FRESH — crew dispatched, not yet launched.
 *      Freshness is the whole point: a child claimed hours ago and never
 *      launched is a corpse, and one corpse must not hold this panel against
 *      the turn the human just started. (A RUNNING child is never aged out —
 *      a long quiet build is real work, and a runner that died mid-run leaves a
 *      stuck `running` row that the operator NEEDS to see, flagged amber by the
 *      crew-liveness machine.)
 *   4. else it dispatched someone at all — a finished crew is worth more than an
 *      empty turn that merely happens to be newer.
 *   5. else the root's own createdAt — the NEWEST MISSION.
 *   6. else its id, so the answer is never a coin flip.
 *
 * Key 5 is deliberately the ROOT's creation time and not the latest activity
 * anywhere in the subtree. Two missions whose crews are both emitting progress
 * would otherwise change places on every poll, and this id addresses the A2A
 * reads: the chart, the transcript and the "no peer messages on this mission"
 * claim would each flip between refreshes. `createdAt` on a root never moves, so
 * the winner cannot either.
 *
 * PURE — including the clock. `now` is a parameter (defaulted only at the outer
 * boundary) so the freshness horizon is testable and two surfaces evaluating the
 * same rows at the same instant cannot disagree.
 *
 * Browser-safe (no node:, no I/O): the desktop renderer, the Ink cockpit and the
 * CLI all import this exact function rather than keeping three copies in sync —
 * which is how they drifted apart in the first place.
 */

/**
 * How long a QUEUED row still counts as live crew. Comfortably longer than any
 * healthy claim-to-launch gap (the runner's own no-first-output watchdog fires
 * at ~90s), short enough that an abandoned claim releases the panel.
 */
export const MISSION_QUEUE_HORIZON_MS = 10 * 60_000;

const EPOCH = new Date(0).toISOString();

export type MissionRootChoice = {
  /** The id a mission-scoped read is addressed by: (chatId, missionId). */
  missionId: string;
  /**
   * The dispatch tree the chart draws. `null` only for a job carrying no
   * lineage at all — a legacy or pre-chat row. Today every chat-bound dispatch
   * is created with a capability mode (`orchestrator` for a chat root,
   * `delegate` for its children), so a chat's mission always has a tree; the
   * null case exists so an old row still resolves to an addressable mission
   * instead of erasing the chat's coordination entirely.
   */
  root: DispatchTreeNode | null;
};

type Candidate = MissionRootChoice & {
  /** Ordered, highest-first preference keys — see the module comment. */
  keys: readonly number[];
  /** The ROOT's creation time. Immutable, which is what makes this poll-stable. */
  startedMissionAt: string;
  tiebreak: string;
};

/** Options every entry point takes, so the clock is never ambient. */
export type MissionRootOptions = {
  /** Evaluation instant for the queued-row freshness horizon. */
  now?: number;
};

function subtree(node: DispatchTreeNode): DispatchTreeNode[] {
  return [node, ...node.children.flatMap(subtree)];
}

/**
 * The freshest signal a job carries: progress beats launch beats enqueue.
 * Used ONLY to age out a queued claim — never to order two live missions.
 */
function activityOf(node: {
  createdAt?: string | null;
  startedAt?: string | null;
  lastProgressAt?: string | null;
}): string {
  return node.lastProgressAt ?? node.startedAt ?? node.createdAt ?? EPOCH;
}

/**
 * A CLAIMED row that has not launched, and has not been heard from inside the
 * horizon, is a corpse: nothing will move it, and it must not speak for a
 * mission. Unparseable/absent timestamps read as stale for the same reason —
 * a row that cannot say when it was claimed cannot claim to be current.
 */
function queuedAndFresh(
  node: { status: string; createdAt?: string | null; startedAt?: string | null; lastProgressAt?: string | null },
  now: number
): boolean {
  if (node.status !== "queued") return false;
  const at = Date.parse(activityOf(node));
  return Number.isFinite(at) && now - at <= MISSION_QUEUE_HORIZON_MS;
}

/** Running, or a queued claim still inside the horizon. */
function isLive(
  node: { status: string; createdAt?: string | null; startedAt?: string | null; lastProgressAt?: string | null },
  now: number
): boolean {
  return node.status === "running" || queuedAndFresh(node, now);
}

function rankLineageRoot(root: DispatchTreeNode, now: number): Candidate {
  const descendants = subtree(root).filter((node) => node.id !== root.id);
  return {
    // `rootJobId` is the job's own id for a true root, and the REAL mission id
    // for a node the forest had to promote because its parent was missing from
    // this page — which is the id the route matches on either way.
    missionId: root.rootJobId,
    root,
    keys: [
      descendants.some((node) => node.status === "running") ? 1 : 0,
      isLive(root, now) ? 1 : 0,
      descendants.some((node) => queuedAndFresh(node, now)) ? 1 : 0,
      descendants.length > 0 ? 1 : 0,
    ],
    startedMissionAt: root.createdAt,
    tiebreak: root.id,
  };
}

/** A row with no lineage at all is still a mission — of exactly one job. */
function rankSoloJob(job: DispatchJobRecord, now: number): Candidate {
  return {
    missionId: job.rootJobId ?? job.id,
    root: null,
    keys: [0, isLive(job, now) ? 1 : 0, 0, 0],
    startedMissionAt: job.createdAt ?? EPOCH,
    tiebreak: job.id,
  };
}

function bestFirst(left: Candidate, right: Candidate): number {
  for (let index = 0; index < left.keys.length; index += 1) {
    const delta = (right.keys[index] ?? 0) - (left.keys[index] ?? 0);
    if (delta !== 0) return delta;
  }
  const newer = right.startedMissionAt.localeCompare(left.startedMissionAt);
  return newer !== 0 ? newer : right.tiebreak.localeCompare(left.tiebreak);
}

/**
 * The mission a chat's crew surfaces should be showing, with the tree to draw
 * it from. Null only when the chat has never dispatched anything — not an
 * error, just a fact each surface states plainly.
 */
export function selectMissionRoot(
  jobs: readonly DispatchJobRecord[],
  options: MissionRootOptions = {}
): MissionRootChoice | null {
  const now = options.now ?? Date.now();
  const forest = buildDispatchForest([...jobs]);
  const candidates = forest.roots.map((root) => rankLineageRoot(root, now));
  const withLineage = new Set(
    forest.roots.flatMap((root) => subtree(root).map((node) => node.id))
  );
  for (const job of jobs) {
    if (!withLineage.has(job.id)) {
      candidates.push(rankSoloJob(job, now));
    }
  }
  candidates.sort(bestFirst);
  const best = candidates[0];
  return best ? { missionId: best.missionId, root: best.root } : null;
}

/** The mission id alone — what a (chatId, missionId) read is addressed by. */
export function selectMissionRootId(
  jobs: readonly DispatchJobRecord[],
  options: MissionRootOptions = {}
): string | null {
  return selectMissionRoot(jobs, options)?.missionId ?? null;
}
