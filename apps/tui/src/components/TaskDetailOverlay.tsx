import { Box, Text } from "ink";
import {
  buildAuditTrail,
  type LaneSession,
  type MemoryNote,
  type RecordedEvent,
  type TaskDetail, terminalSafe } from "@muon/client";
import { latestTakeOver } from "../lib/take-over.js";
import { hub, panelBorder } from "../lib/theme.js";

type Props = {
  detail: TaskDetail;
  events: RecordedEvent[];
  memory: MemoryNote[];
  sessions: LaneSession[];
};

/** Interactive `muon report`: the full task record from the brain. */
export function TaskDetailOverlay({ detail, events, memory, sessions }: Props) {
  const takeOver = latestTakeOver(sessions);
  // P0.4 parity: `approval.auto` rows use the SAME "Auto-approved a
  // policy-bound action" headline the desktop audit trail renders, via the
  // shared client mapping — never a locally duplicated copy of that string.
  // Every other kind keeps its raw `event.kind` label, unaffected.
  const audit = buildAuditTrail(events);

  return (
    <Box
      flexDirection="column"
      borderStyle={panelBorder}
      borderColor={hub.border}
      borderDimColor
      paddingX={1}
      width="90%"
    >
      <Text bold>
        {detail.id}, {terminalSafe(detail.title)} [{detail.status}/{detail.priority}]
      </Text>
      <Text dimColor>{terminalSafe(detail.description).slice(0, 100)}</Text>

      <Text dimColor>Assignments</Text>
      {detail.assignments.length === 0 ? (
        <Text dimColor>none</Text>
      ) : (
        detail.assignments.slice(0, 4).map((assignment) => (
          <Text key={assignment.id}>
            {"  "}
            {assignment.lane?.name ?? "?"} · {assignment.state} ·{" "}
            {terminalSafe(assignment.summary).slice(0, 48)}
          </Text>
        ))
      )}

      <Text dimColor>Timeline (last 6)</Text>
      {events.length === 0 ? (
        <Text dimColor>no events</Text>
      ) : (
        events.slice(-6).map((event) => {
          const label =
            event.kind === "approval.auto"
              ? (audit.find((entry) => entry.id === event.id)?.headline ??
                event.kind)
              : event.kind;
          return (
            <Text key={event.id} wrap="truncate">
              {"  "}
              {event.timestamp.slice(11, 19)} {label}{" "}
              {terminalSafe(event.message).slice(0, 56)}
            </Text>
          );
        })
      )}

      <Text dimColor>Handoffs</Text>
      {detail.handoffs.length === 0 ? (
        <Text dimColor>none</Text>
      ) : (
        detail.handoffs.slice(0, 3).map((handoff) => (
          <Text key={handoff.id}>
            {"  "}
            {handoff.fromLane?.key ?? "?"}→{handoff.toLane?.key ?? "?"} ·{" "}
            {handoff.status} · {terminalSafe(handoff.packetTitle).slice(0, 44)}
          </Text>
        ))
      )}

      <Text dimColor>Approvals</Text>
      {detail.approvals.length === 0 ? (
        <Text dimColor>none</Text>
      ) : (
        detail.approvals.slice(0, 4).map((approval) => (
          <Text key={approval.id}>
            {"  "}
            {approval.kind} · {approval.status} · {terminalSafe(approval.reason).slice(0, 48)}
          </Text>
        ))
      )}

      <Text dimColor>Memory (graph recall)</Text>
      {memory.length === 0 ? (
        <Text dimColor>none</Text>
      ) : (
        memory.slice(0, 4).map((note) => (
          <Text key={note.id} wrap="truncate">
            {"  "}[{note.kind}
            {note.stale ? "·stale" : ""}] {terminalSafe(note.text).slice(0, 60)}
          </Text>
        ))
      )}

      {takeOver ? (
        <Text>take over: {terminalSafe(takeOver.command)}</Text>
      ) : (
        <Text dimColor>take over: no resumable session yet</Text>
      )}
      <Text dimColor>Esc close</Text>
    </Box>
  );
}
