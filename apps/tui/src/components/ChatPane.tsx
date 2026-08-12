import { Box, Text } from "ink";
import { hub } from "../lib/theme.js";
import { ZoneLabel } from "./chrome.js";
import { terminalSafeBlock } from "@muon/client";

export type ChatMessage = {
  role: "you" | "muon" | "status";
  text: string;
};

type Props = {
  messages: ChatMessage[];
  streamingText: string;
  busy: boolean;
  workspace: string;
  maxRows?: number;
};

/**
 * The conversation with the super-orchestrator, the TUI's main pane.
 * History comes from the chat's stream chunks; the in-flight reply streams
 * live underneath.
 */
export function ChatPane({
  messages,
  streamingText,
  busy,
  workspace,
  maxRows = 18,
}: Props) {
  const visible = messages.slice(-maxRows);
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box>
        <Box flexShrink={0} marginRight={1}>
          <ZoneLabel text="ORCHESTRATOR" />
        </Box>
        <Box flexGrow={1} justifyContent="flex-end" overflow="hidden">
          <Text dimColor wrap="truncate">
            {workspace}
          </Text>
        </Box>
      </Box>
      {visible.length === 0 && !streamingText ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            Tell the crew what to do, press / and type, like talking to
            Claude.
          </Text>
          <Text dimColor>
            The orchestrator creates tasks, dispatches your fleet, watches
            their streams, and files gates. You approve (a/r in the inbox).
          </Text>
        </Box>
      ) : (
        visible.map((message, index) =>
          message.role === "you" ? (
            <Text key={`${index}-${message.text.slice(0, 12)}`} wrap="wrap">
              you <Text color={hub.focus}>❯</Text> {terminalSafeBlock(message.text)}
            </Text>
          ) : (
            <Text
              key={`${index}-${message.text.slice(0, 12)}`}
              wrap="wrap"
              dimColor={message.role === "status"}
            >
              {terminalSafeBlock(message.text)}
            </Text>
          )
        )
      )}
      {streamingText ? <Text wrap="wrap">{terminalSafeBlock(streamingText)}</Text> : null}
      {busy ? <Text dimColor>muon is orchestrating…</Text> : null}
    </Box>
  );
}
