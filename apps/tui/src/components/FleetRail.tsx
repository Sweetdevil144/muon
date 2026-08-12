import { terminalSafe } from "@muon/client";
import { Box, Text } from "ink";
import type { AgentRecord, DispatchJobRecord } from "@muon/client";
import {
  crewLivenessLabel,
  deriveCrewLiveness,
  type CrewLiveness,
} from "@muon/client/crew-liveness";
import { hub } from "../lib/theme.js";
import { ZoneLabel } from "./chrome.js";

type Props = {
  agents: AgentRecord[];
  /**
   * Wave 4.2 parity: active dispatch jobs, so each fleet row derives the SAME
   * crew-liveness state as the desktop crew tree (a silent child lights amber
   * before it dies). Absent → rows fall back to the plain agent-status glyph.
   */
  jobs?: DispatchJobRecord[];
  focused: boolean;
  selectedIndex: number;
  maxRows?: number;
  /** Compact height profile drops the hint row. */
  compact?: boolean;
  /** Injectable clock so the launching→stalled transition is deterministic in tests. */
  now?: number;
};

const STATUS_GLYPHS: Record<string, string> = {
  idle: "○",
  working: "●",
  offline: "·",
};

/** One glyph per live crew state — mirrors the desktop dot's semantics. */
const LIVENESS_GLYPHS: Record<CrewLiveness, string> = {
  queued: "○",
  launching: "◐",
  live: "●",
  progressing: "●",
  stalled: "▲",
  "waiting-approval": "◆",
  "budget-low": "▲",
  done: "✓",
  "needs-attention": "✗",
};

/** Attention states carry a tone; calm states render plain (dim by default). */
function livenessColor(state: CrewLiveness): string | undefined {
  if (state === "needs-attention") return "red";
  if (
    state === "stalled" ||
    state === "waiting-approval" ||
    state === "budget-low"
  ) {
    return hub.warn;
  }
  return undefined;
}

function jobForAgent(
  agent: AgentRecord,
  jobs: DispatchJobRecord[]
): DispatchJobRecord | null {
  // Prefer the agent's CURRENT job precisely; fall back to the agentId match
  // only when currentJobId resolves nothing — an un-prioritized match could
  // bind a reused slot to a STALE/terminal job and misreport its live state.
  return (
    jobs.find((job) => job.id === agent.currentJobId) ??
    jobs.find((job) => job.agentId === agent.id) ??
    null
  );
}

/**
 * The crew: one row per fleet instance. Enter opens its live stream; b opens
 * the active mission's per-descendant budget breakdown (S9 TUI parity,
 * read-only — see MissionBudgetOverlay). Each row shows the shared crew-liveness
 * state so a stalled/failing agent is visible here before it dies (Wave 4.2).
 */
export function FleetRail({
  agents,
  jobs = [],
  focused,
  selectedIndex,
  maxRows = 9,
  compact = false,
  now,
}: Props) {
  const clock = now ?? Date.now();
  return (
    <Box flexDirection="column" paddingX={1}>
      <ZoneLabel text="FLEET" count={agents.length} focused={focused} />
      {agents.length === 0 ? (
        <Text dimColor>no agents yet — run: muon fleet set</Text>
      ) : (
        agents.slice(0, maxRows).map((agent, index) => {
          const selected = focused && index === selectedIndex;
          const job = jobForAgent(agent, jobs);
          // A job-bound row derives the shared liveness state; an idle/unbound
          // agent keeps the plain status glyph (no job → no liveness to show).
          const liveness = job
            ? deriveCrewLiveness(
                {
                  status: job.status,
                  exitCode: job.exitCode,
                  // Launch instant (matches the runner watchdog), not enqueue.
                  createdAt:
                    job.startedAt ?? job.createdAt ?? new Date(0).toISOString(),
                  lastProgressAt: job.lastProgressAt,
                  waitingApproval: job.waitingApproval,
                  result: job.result,
                },
                clock
              )
            : null;
          const glyph = liveness
            ? LIVENESS_GLYPHS[liveness.state]
            : (STATUS_GLYPHS[agent.status] ?? "·");
          const glyphColor = liveness
            ? livenessColor(liveness.state)
            : undefined;
          return (
            <Text
              key={agent.id}
              wrap="truncate"
              color={selected ? hub.focus : undefined}
              bold={selected}
            >
              {selected ? "› " : "  "}
              <Text color={glyphColor}>{glyph}</Text> {terminalSafe(agent.name)}
              {liveness ? (
                <Text color={liveness.attention ? glyphColor : undefined} dimColor={!liveness.attention}>
                  {" "}
                  {crewLivenessLabel(liveness.state)}
                </Text>
              ) : null}
              {agent.currentTaskId ? (
                <Text dimColor> · task {agent.currentTaskId.slice(-8)}</Text>
              ) : null}
            </Text>
          );
        })
      )}
      {compact ? null : (
        <Text dimColor>Enter: watch live stream · b: mission budget</Text>
      )}
    </Box>
  );
}
