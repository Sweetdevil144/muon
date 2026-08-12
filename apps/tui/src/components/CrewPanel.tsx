import { Box, Text } from "ink";
import {
  UNTRUSTED_PEER_HEADER,
  type CrewPanelLoad,
  type CrewCoordinationSection,
  type CrewRolesSection,
} from "../lib/crew-view.js";
import { hub, panelBorder } from "../lib/theme.js";

/**
 * CREW — role assignments + A2A coordination for the ONE selected chat.
 *
 * Read-only on purpose. There is no keystroke here that writes a role binding:
 * assignment stays with the orchestrator and `muon crew roles --assign`, so the
 * cockpit can show the decision and its provenance without becoming a second
 * place authority is granted.
 *
 * Every string this renders came out of `lib/crew-view.ts` already flattened to
 * printable one-line text. That is what keeps the UNTRUSTED header below able to
 * frame a peer body that is actively trying to repaint it.
 */

const ROLE_LIMIT = 8;
const LANE_LIMIT = 6;
const PARTICIPANT_LIMIT = 5;
const CONFLICT_LIMIT = 4;
/** Peer messages on screen at once; j/k scrolls the window. */
export const CREW_MESSAGE_WINDOW = 3;

type Props = {
  /** The ONE chat this panel is bound to. null = nothing selected yet. */
  chatId: string | null;
  /** null while the first load is still in flight. */
  load: CrewPanelLoad | null;
  busy?: boolean;
  /** First visible peer message (scroll offset). */
  messageIndex?: number;
};

function Omitted({ count, noun }: { count: number; noun: string }) {
  if (count <= 0) return null;
  return (
    <Text dimColor>
      {"  … "}
      {count} more {noun}
      {count === 1 ? "" : "s"} not shown
    </Text>
  );
}

function RolesSection({ roles }: { roles: CrewRolesSection }) {
  if (roles.status === "loading") {
    return <Text dimColor>ROLES · loading…</Text>;
  }
  if (roles.status === "error") {
    return (
      <>
        <Text color={hub.warn}>ROLES · unavailable</Text>
        <Text dimColor wrap="truncate-end">
          {"  "}
          {roles.reason}
        </Text>
      </>
    );
  }

  const visible = roles.rows.slice(0, ROLE_LIMIT);
  return (
    <>
      <Text>
        {roles.planStatus === "proposed" ? "PROPOSED ROLES" : "ROLES"} (
        {roles.rows.length})
        <Text dimColor>, MUON decides what each agent is FOR</Text>
      </Text>
      {/* A preview must never read as a commitment. The rows look identical
          either way, and this panel is read-only, so the distinction has to be
          stated in words rather than inferred. */}
      {roles.planStatus === "proposed" && roles.rows.length > 0 ? (
        <Text color={hub.warn} wrap="truncate-end">
          {"  "}not assigned yet — this is what MUON would assign when work is
          dispatched
        </Text>
      ) : null}
      {roles.rows.length === 0 ? (
        <Text dimColor>
          {"  "}no roles assigned yet — run: muon crew roles --assign
        </Text>
      ) : (
        visible.map((row) => (
          <Box key={`${row.role}:${row.vendor}`} flexDirection="column">
            <Text wrap="truncate-end">
              {"  "}
              {row.role.padEnd(13)}
              {row.vendor.padEnd(13)}
              {/* What this role may DO — the same authority `muon crew roles`
                  prints in its flags. Without it the panel named a role and
                  left the operator to remember whether it can write. No colour:
                  authority is a fact, not a success event and not a needs-you
                  signal, so the write/coordinate tiers simply read undimmed. */}
              <Text dimColor={row.authority === "read-only"}>
                {row.authority.padEnd(11)}
              </Text>
              <Text dimColor>fit </Text>
              {row.fit}{" "}
              <Text
                color={row.assignedBy === "human" ? hub.focus : undefined}
                dimColor={row.assignedBy !== "human"}
              >
                {row.assignedBy === "human" ? "operator-pinned" : "muon"}
              </Text>
              {row.blocked ? <Text color="red"> BLOCKED</Text> : null}
            </Text>
            <Text dimColor wrap="truncate-end">
              {"      "}
              {row.reason}
            </Text>
            {row.blocked ? (
              <Text color="red" wrap="truncate-end">
                {"      ! "}
                {row.blockedReason ??
                  "this lane cannot currently hold the role it was assigned"}
              </Text>
            ) : null}
          </Box>
        ))
      )}
      <Omitted count={roles.rows.length - visible.length} noun="role" />
      {roles.unfilled.length > 0 ? (
        <Text color={hub.warn} wrap="truncate-end">
          {"  Unfilled ("}
          {roles.unfilled.length}
          {"), no available lane can hold: "}
          {roles.unfilled.join(", ")}
        </Text>
      ) : null}
      <Text dimColor wrap="truncate-end">
        {"  Lanes ("}
        {roles.lanes.length}
        {"): "}
        {roles.lanes.length === 0
          ? "none ready — run: muon doctor"
          : roles.lanes
              .slice(0, LANE_LIMIT)
              .map((lane) => `${lane.vendor} ${lane.health}`)
              .join(" · ")}
      </Text>
    </>
  );
}

function CoordinationSection({
  coordination,
  messageIndex,
}: {
  coordination: CrewCoordinationSection;
  messageIndex: number;
}) {
  if (coordination.status === "loading") {
    return <Text dimColor>COORDINATION · loading…</Text>;
  }
  if (coordination.status === "unavailable") {
    // Honest one-liner, never a blank panel: no mission yet, route absent, or
    // the operator read refused.
    return (
      <>
        <Text color={hub.warn}>COORDINATION · unavailable</Text>
        <Text dimColor wrap="truncate-end">
          {"  "}
          {coordination.reason}
        </Text>
      </>
    );
  }

  const participants = coordination.participants.slice(0, PARTICIPANT_LIMIT);
  const conflicts = coordination.conflicts.slice(0, CONFLICT_LIMIT);
  const start = Math.min(
    Math.max(0, messageIndex),
    Math.max(0, coordination.messages.length - CREW_MESSAGE_WINDOW)
  );
  const messages = coordination.messages.slice(
    start,
    start + CREW_MESSAGE_WINDOW
  );

  return (
    <>
      <Text>
        COORDINATION
        <Text dimColor> · mission {coordination.missionId}</Text>
      </Text>

      <Text dimColor>
        {"  Participants ("}
        {coordination.participants.length}
        {")"}
      </Text>
      {coordination.participants.length === 0 ? (
        <Text dimColor>{"    none on this mission"}</Text>
      ) : (
        participants.map((participant) => (
          <Text key={participant.jobId} wrap="truncate-end">
            {"    "}
            {participant.role.padEnd(13)}
            {participant.vendor.padEnd(13)}
            {participant.status.padEnd(10)}
            <Text dimColor>claims </Text>
            {participant.claimedPaths}
            <Text dimColor> unread </Text>
            {participant.unreadMessages}
            <Text dimColor>
              {" "}
              [job {participant.jobId}]
              {participant.name ? ` ${participant.name}` : ""}
            </Text>
          </Text>
        ))
      )}
      <Omitted
        count={coordination.participants.length - participants.length}
        noun="participant"
      />

      {coordination.conflicts.length === 0 ? (
        <Text dimColor>{"  Open claim conflicts (0)"}</Text>
      ) : (
        <>
          <Text color={hub.warn} wrap="truncate-end">
            {"  Open claim conflicts ("}
            {coordination.conflicts.length}
            {"), advisory — MUON does not lock files"}
          </Text>
          {conflicts.map((conflict, index) => (
            <Text
              key={`${conflict.path}:${conflict.jobId}:${index}`}
              color={hub.warn}
              wrap="truncate-end"
            >
              {"    ! "}
              {conflict.path}
              <Text dimColor>
                {" held by "}
                {conflict.heldBy} [job {conflict.jobId}]
                {conflict.name ? ` ${conflict.name}` : ""} until{" "}
                {conflict.expiresAt}
              </Text>
            </Text>
          ))}
          <Omitted
            count={coordination.conflicts.length - conflicts.length}
            noun="conflict"
          />
        </>
      )}

      <Text dimColor>
        {"  Peer messages ("}
        {coordination.messages.length}
        {" of "}
        {coordination.messageCount}
        {")"}
      </Text>
      {/* The framing IS the control. Everything under it was flattened to
          printable one-line text before it got here, so a body carrying ANSI or
          a bare CR cannot repaint this label. */}
      <Text color={hub.warn}>
        {"  "}
        {UNTRUSTED_PEER_HEADER}
      </Text>
      {coordination.messages.length === 0 ? (
        <Text dimColor>{"    none"}</Text>
      ) : (
        messages.map((message) => (
          <Box key={message.id} flexDirection="column">
            <Text wrap="truncate-end">
              {"    │ "}
              <Text dimColor>[{message.kind}] </Text>
              {message.from}
              <Text dimColor> → {message.to}: </Text>
              {message.subject}
            </Text>
            <Text wrap="truncate-end" dimColor>
              {"    │   "}
              {message.body}
            </Text>
            {message.refs.length > 0 ? (
              <Text wrap="truncate-end" dimColor>
                {"    │   refs: "}
                {message.refs.join(", ")}
              </Text>
            ) : null}
          </Box>
        ))
      )}
      {coordination.messages.length > CREW_MESSAGE_WINDOW ? (
        <Text dimColor>
          {"    showing "}
          {start + 1}
          {"–"}
          {start + messages.length}
          {" of "}
          {coordination.messages.length}
          {" · j/k scrolls"}
        </Text>
      ) : null}
    </>
  );
}

export function CrewPanel({ chatId, load, busy, messageIndex = 0 }: Props) {
  return (
    <Box
      flexDirection="column"
      borderStyle={panelBorder}
      borderColor={hub.border}
      borderDimColor
      paddingX={1}
      width="86%"
    >
      <Text bold>
        CREW
        {chatId ? ` · chat ${chatId}` : ""}
        {busy ? " · refreshing…" : ""}
      </Text>

      {chatId === null ? (
        // Every crew surface is bound to ONE chat, so with none selected this
        // fails closed with the way forward rather than showing another chat's
        // crew or an empty frame.
        <>
          <Text dimColor>No chat is selected in this folder yet.</Text>
          <Text dimColor>
            Crew roles and coordination are always scoped to exactly one chat.
          </Text>
          <Text dimColor>
            Press Esc, then / and tell the crew what to do to start that chat.
          </Text>
        </>
      ) : load === null ? (
        <Text dimColor>loading roles and coordination…</Text>
      ) : (
        <>
          <RolesSection roles={load.roles} />
          <Box height={1} />
          <CoordinationSection
            coordination={load.coordination}
            messageIndex={messageIndex}
          />
        </>
      )}

      <Text dimColor>
        read-only · assign with `muon crew roles --assign`, never from here
      </Text>
      <Text dimColor>r refresh · j/k scroll messages · Esc close</Text>
    </Box>
  );
}
