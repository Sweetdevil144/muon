import { Box, Text } from "ink";
import { hub } from "../lib/theme.js";
import { COMMAND_BAR_PLACEHOLDER } from "../lib/command-bar.js";

type Props = {
  value: string;
  focused: boolean;
  busy: boolean;
  workspace: string;
};

/**
 * The persistent prompt, MUON's front door. Focus with `/` or `i`, type an
 * instruction, Enter proposes a workflow the human then applies. Renders as
 * the bottom instrument edge: a single top hairline, no box.
 */
export function CommandBar({ value, focused, busy, workspace }: Props) {
  return (
    <Box
      borderStyle="single"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderDimColor
      paddingX={1}
      justifyContent="space-between"
    >
      <Box flexGrow={1}>
        <Text color={focused ? hub.focus : undefined} bold={focused}>
          {"❯ "}
        </Text>
        {busy ? (
          <Text dimColor>thinking…</Text>
        ) : value ? (
          <Text wrap="truncate">
            {value}
            {focused ? <Text color={hub.focus}>▌</Text> : null}
          </Text>
        ) : (
          <Text dimColor wrap="truncate">
            {focused ? "" : "press / to instruct the crew, "}
            {COMMAND_BAR_PLACEHOLDER}
          </Text>
        )}
      </Box>
      <Text dimColor wrap="truncate">
        {" "}
        {workspace}
      </Text>
    </Box>
  );
}
