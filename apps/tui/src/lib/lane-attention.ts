// ADR-0032 D3/D4 — binding the pure attention model to real fleet records.
//
// `attention.ts` folds liveness → display state; this module answers the
// question one step earlier: what IS this agent's liveness, given the jobs on
// the wire. It exists so the rail, the tab strip and the NEEDS YOU scalar all
// read one derivation. Three call sites computing "is this lane blocked" three
// ways is exactly how a rail ends up disagreeing with its own badge.

import type { AgentRecord, DispatchJobRecord } from "@muon/client";
import {
  deriveCrewLiveness,
  type CrewLiveness,
} from "@muon/client/crew-liveness";
import { resolveAttentionState, type AttentionState } from "./attention.js";

/**
 * The agent's current job.
 *
 * `currentJobId` is preferred and the `agentId` match is only a fallback,
 * because an un-prioritised match can bind a reused fleet slot to a STALE
 * terminal job and misreport the lane as finished. Same rule the rail already
 * used; lifted here so it is stated once.
 */
export function jobForAgent(
  agent: AgentRecord,
  jobs: readonly DispatchJobRecord[]
): DispatchJobRecord | null {
  return (
    jobs.find((job) => job.id === agent.currentJobId) ??
    jobs.find((job) => job.agentId === agent.id) ??
    null
  );
}

/** Liveness for one agent, or null when no job is bound (nothing to report). */
export function livenessForAgent(
  agent: AgentRecord,
  jobs: readonly DispatchJobRecord[],
  now?: number
): CrewLiveness | null {
  const job = jobForAgent(agent, jobs);
  if (!job) return null;
  return deriveCrewLiveness(
    {
      status: job.status,
      exitCode: job.exitCode,
      // The launch instant, matching the runner's watchdog — not the enqueue
      // time, which would inflate the age by queue-wait and delay the amber.
      createdAt: job.startedAt ?? job.createdAt ?? new Date(0).toISOString(),
      lastProgressAt: job.lastProgressAt,
      waitingApproval: job.waitingApproval,
      result: job.result,
    },
    now ?? Date.now()
  ).state;
}

/** One lane's display state, with the operator's seen-marks applied. */
export function attentionForAgent(
  agent: AgentRecord,
  jobs: readonly DispatchJobRecord[],
  seenLanes: Readonly<Record<string, string>>,
  now?: number
): AttentionState {
  const liveness = livenessForAgent(agent, jobs, now);
  // A lane counts as "seen" only while the mark matches its CURRENT job: when a
  // lane starts new work, the old acknowledgement must not carry over and mute
  // the new result.
  const job = jobForAgent(agent, jobs);
  const seen = Boolean(job && seenLanes[agent.id] === job.id);
  return resolveAttentionState(liveness, seen);
}

/** Every lane's state, keyed by agent id. */
export function attentionByAgent(
  agents: readonly AgentRecord[],
  jobs: readonly DispatchJobRecord[],
  seenLanes: Readonly<Record<string, string>>,
  now?: number
): Record<string, AttentionState> {
  const out: Record<string, AttentionState> = {};
  for (const agent of agents) {
    out[agent.id] = attentionForAgent(agent, jobs, seenLanes, now);
  }
  return out;
}

/**
 * Mark a lane seen against the job it is currently showing. A no-op when the
 * lane has no job, so an empty slot cannot accumulate a stale acknowledgement.
 */
export function markLaneSeen(
  seenLanes: Readonly<Record<string, string>>,
  agent: AgentRecord,
  jobs: readonly DispatchJobRecord[]
): Record<string, string> {
  const job = jobForAgent(agent, jobs);
  if (!job) return { ...seenLanes };
  return { ...seenLanes, [agent.id]: job.id };
}
