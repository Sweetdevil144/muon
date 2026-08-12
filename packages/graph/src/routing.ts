import type { LaneOutcomeStats, LaneSuggestion } from "./types.js";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

/**
 * Evidence-based lane ranking (ROADMAP Phase 8). Pure scoring over outcome
 * history so it is unit-testable without a graph database. The result is a
 * recommendation with a human-readable reason, never an auto-assignment.
 */
export function rankLanes(stats: LaneOutcomeStats[]): LaneSuggestion[] {
  const suggestions = stats.map((lane) => {
    const completionRate =
      lane.assignments > 0 ? lane.completions / lane.assignments : 0;

    let score = 0;
    score += lane.completions * 2;
    score += completionRate * 3;
    score -= lane.blocked;
    // Module familiarity: lanes that already worked in the task's code area
    // are more likely to succeed there.
    score += (lane.familiarModules ?? 0) * 1.5;
    // Topic overlap: capped so a chatty lane cannot outrank real outcomes.
    score += Math.min(lane.topicMatches ?? 0, 4) * 0.75;
    // Recency decay: activity older than a week counts less.
    if (lane.lastActivityAt) {
      const ageDays =
        (Date.now() - new Date(lane.lastActivityAt).getTime()) /
        (24 * 60 * 60 * 1000);
      if (Number.isFinite(ageDays) && ageDays > 7) {
        score -= Math.min(1, (ageDays - 7) / 30);
      }
    }
    // Prefer lanes with a track record over completely idle ones, but keep
    // idle lanes visible so new lanes still get work.
    if (lane.assignments === 0) {
      score += 0.5;
    }

    const reasonParts: string[] = [];
    if (lane.assignments === 0) {
      reasonParts.push("no history yet");
    } else {
      reasonParts.push(
        `${lane.completions}/${lane.assignments} assignments completed`
      );
      if (lane.blocked > 0) {
        reasonParts.push(`${lane.blocked} blocked`);
      }
      if (lane.averageDurationMs !== null) {
        reasonParts.push(`avg ${formatDuration(lane.averageDurationMs)}`);
      }
    }
    if ((lane.familiarModules ?? 0) > 0) {
      reasonParts.push(`knows ${lane.familiarModules} of this task's modules`);
    }
    if ((lane.topicMatches ?? 0) > 0) {
      reasonParts.push(`${lane.topicMatches} memory topic(s) match the request`);
    }

    return {
      laneId: lane.laneId,
      laneKey: lane.laneKey,
      laneName: lane.laneName,
      score: Number(score.toFixed(3)),
      reason: reasonParts.join(", "),
    };
  });

  return suggestions.sort(
    (a, b) => b.score - a.score || a.laneName.localeCompare(b.laneName)
  );
}
