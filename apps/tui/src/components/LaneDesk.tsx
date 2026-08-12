import { Box, Text } from "ink";
import type {
  AgentRecord,
  DispatchJobRecord,
  RecordedEvent,
  Task,
} from "@muon/client";
import {
  crewLivenessLabel,
  deriveCrewLiveness,
} from "@muon/client/crew-liveness";
import { hub } from "../lib/theme.js";
import { ZoneLabel } from "./chrome.js";
import { terminalSafe } from "@muon/client";

type Props = {
  agents: AgentRecord[];
  jobs: DispatchJobRecord[];
  tasks: Task[];
  events: RecordedEvent[];
  focused: boolean;
  selectedIndex: number;
  maxLanes?: number;
  now?: number;
};

function currentJob(
  agent: AgentRecord,
  jobs: DispatchJobRecord[]
): DispatchJobRecord | null {
  return (
    jobs.find((job) => job.id === agent.currentJobId) ??
    jobs.find((job) => job.agentId === agent.id) ??
    null
  );
}

function latestActivity(
  job: DispatchJobRecord | null,
  events: RecordedEvent[]
): string {
  if (job?.currentActivity) return job.currentActivity;
  const event = events
    .filter((candidate) => candidate.taskId === job?.taskId)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  return event ? terminalSafe(event.message) : "waiting for activity";
}

/** Five addressable crew seats: live state, current task, activity, and Stop. */
export function LaneDesk({
  agents,
  jobs,
  tasks,
  events,
  focused,
  selectedIndex,
  maxLanes = 5,
  now = Date.now(),
}: Props) {
  const start = Math.min(
    Math.max(0, selectedIndex - maxLanes + 1),
    Math.max(0, agents.length - maxLanes)
  );
  const visible = agents.slice(start, start + maxLanes);

  return (
    <Box flexDirection="column" flexGrow={1} minWidth={0}>
      <Box paddingX={1} justifyContent="space-between">
        <ZoneLabel text="CREW DESK" count={agents.length} focused={focused} />
        <Text dimColor>Enter watch · s stop lane · ! stop all</Text>
      </Box>
      {visible.length === 0 ? (
        <Box paddingX={1}>
          <Text dimColor>no crew seats — run: muon fleet set</Text>
        </Box>
      ) : (
        <Box flexDirection="row" flexGrow={1} minWidth={0}>
          {visible.map((agent, visibleIndex) => {
            const absoluteIndex = start + visibleIndex;
            const selected = focused && absoluteIndex === selectedIndex;
            const job = currentJob(agent, jobs);
            const liveness = job
              ? deriveCrewLiveness(
                  {
                    status: job.status,
                    exitCode: job.exitCode,
                    createdAt:
                      job.startedAt ?? job.createdAt ?? new Date(0).toISOString(),
                    lastProgressAt: job.lastProgressAt,
                    waitingApproval: job.waitingApproval,
                    result: job.result,
                  },
                  now
                )
              : null;
            const taskId = job?.taskId ?? agent.currentTaskId;
            const task = tasks.find((candidate) => candidate.id === taskId);
            const stoppable =
              job &&
              !job.interruptRequested &&
              (job.status === "queued" || job.status === "running");
            return (
              <Box
                key={agent.id}
                flexBasis={0}
                flexGrow={1}
                minWidth={0}
                flexDirection="column"
                paddingX={1}
                borderStyle="single"
                borderTop={false}
                borderBottom={false}
                borderRight={false}
                borderLeft={visibleIndex > 0}
                borderColor={selected ? hub.borderFocus : hub.border}
                borderDimColor={!selected}
              >
                <Text
                  bold={selected}
                  color={selected ? hub.focus : undefined}
                  wrap="truncate-end"
                >
                  {selected ? "› " : "  "}
                  {agent.name}
                </Text>
                <Text dimColor={!liveness?.attention} wrap="truncate-end">
                  {liveness
                    ? crewLivenessLabel(liveness.state)
                    : agent.status}
                </Text>
                <Text wrap="truncate-end">
                  {task?.title ?? (taskId ? `task ${taskId.slice(-8)}` : "unassigned")}
                </Text>
                <Text dimColor wrap="truncate-end">
                  {latestActivity(job, events)}
                </Text>
                <Text color={stoppable ? hub.warn : undefined} dimColor={!stoppable}>
                  {stoppable ? "s Stop this lane" : "no active run"}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
