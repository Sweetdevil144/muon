import { BEATS, LANE_ROLES, LIVE_NODE_ID, RUN_END } from "./script";
import type { AgentLane, Decision, Frame, LaneState } from "./types";

const AGENT_LANES: readonly AgentLane[] = ["Claude Code", "Codex", "Cursor", "OpenCode"];

/** Pure: same t + same decision always produce the same frame. */
export function frameAt(tMs: number, decision: Decision | null): Frame {
  const t = Math.max(0, Math.min(RUN_END, tMs));
  const beats = BEATS.filter((b) => b.t <= t);
  const seen = new Set(beats.map((b) => b.lane));

  const lanes: LaneState[] = AGENT_LANES.map((lane) => {
    const meta = LANE_ROLES[lane]!;
    const last = [...beats].reverse().find((b) => b.lane === lane);
    const dispatched = seen.has(lane);
    return {
      lane,
      role: meta.role,
      subtitle: meta.subtitle,
      tone: meta.tone,
      active: dispatched && t < RUN_END,
      status: !dispatched ? "Waiting for dispatch" : (last?.tool ?? "dispatch"),
    };
  });

  const degraded = t >= 14400 && t < 17200;
  const reviewBlind = t >= 18600;

  return {
    tMs: t,
    beats,
    lanes,
    halted: t >= RUN_END && decision === null,
    landDisabled: degraded || reviewBlind,
    degraded,
    reviewBlind,
    memoryPulseId: t >= 8800 && t <= 10400 ? LIVE_NODE_ID : null,
  };
}
