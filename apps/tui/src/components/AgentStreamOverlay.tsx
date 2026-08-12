import { Box, Text } from "ink";
import type { AgentRecord, StreamChunk } from "@muon/client";
import { hub, panelBorder } from "../lib/theme.js";
import { terminalSafeBlock } from "@muon/client";

type Props = {
  agent: AgentRecord;
  chunks: StreamChunk[];
};

/** Full-screen live stream of one sub-agent, the "watch it think" view. */
export function AgentStreamOverlay({ agent, chunks }: Props) {
  const visible = chunks.slice(-24);
  return (
    <Box
      flexDirection="column"
      borderStyle={panelBorder}
      borderColor={hub.border}
      borderDimColor
      paddingX={1}
      width="90%"
    >
      <Box justifyContent="space-between">
        <Text bold>
          {agent.name}, {agent.status}
          {agent.currentTaskId ? ` · task ${agent.currentTaskId}` : ""}
        </Text>
        <Text dimColor>Esc close</Text>
      </Box>
      {visible.length === 0 ? (
        <Text dimColor>
          no stream yet, output appears the moment this agent works
        </Text>
      ) : (
        visible.map((chunk) => (
          <Text
            key={chunk.seq}
            wrap="wrap"
            bold={chunk.kind === "milestone"}
          >
            {terminalSafeBlock(chunk.content)}
          </Text>
        ))
      )}
    </Box>
  );
}
