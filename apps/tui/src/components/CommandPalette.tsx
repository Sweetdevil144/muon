import { Box, Text } from "ink";
import { describePaletteCommand } from "../lib/command-visibility.js";
import type { PaletteCommand } from "../lib/palette.js";
import { chipColor, hub, panelBorder } from "../lib/theme.js";
import { Rule } from "./chrome.js";

type Props = {
  query: string;
  results: PaletteCommand[];
  selectedIndex: number;
};

export function CommandPalette({ query, results, selectedIndex }: Props) {
  const visibleResults = results.slice(0, 8);
  const selectedCommand =
    visibleResults[Math.min(selectedIndex, Math.max(visibleResults.length - 1, 0))];
  const details = selectedCommand
    ? describePaletteCommand(selectedCommand)
    : null;

  return (
    <Box
      flexDirection="column"
      borderStyle={panelBorder}
      borderColor={hub.border}
      borderDimColor
      paddingX={1}
      width="80%"
    >
      <Text bold>Command palette</Text>
      <Text>
        {">"} {query}
        <Text dimColor>_</Text>
      </Text>
      {results.length === 0 ? (
        <Text dimColor>No matches — keep typing, or Esc to close</Text>
      ) : (
        visibleResults.map((command, index) => {
          const marker = index === selectedIndex ? "›" : " ";
          const selected = index === selectedIndex;
          // A vendor action carries a badge (claude/codex/cursor) + a
          // parity/gate chip (clean / needs-work / gated). Cockpit commands
          // render exactly as before.
          const suffix = command.vendor ? "" : command.enabled ? "" : " (soon)";
          const chipTone = chipColor(command.chip);
          return (
            <Box key={command.id}>
              <Text
                color={selected ? hub.focus : undefined}
                bold={selected}
                dimColor={!command.enabled}
              >
                {marker} {command.label}
                {suffix}
              </Text>
              {command.badge ? (
                <Text dimColor> [{command.badge}]</Text>
              ) : null}
              {command.chip ? (
                <Text color={chipTone} dimColor={chipTone === undefined}>
                  {" "}
                  · {command.chip}
                </Text>
              ) : null}
              {command.vendor && !command.enabled ? (
                <Text dimColor> · not ready</Text>
              ) : null}
            </Box>
          );
        })
      )}
      {details ? (
        <Box flexDirection="column" marginTop={1}>
          <Rule width={40} />
          <Text dimColor>Review before running</Text>
          <Text>
            <Text dimColor>Effect: </Text>
            {details.effect}
          </Text>
          <Text>
            <Text dimColor>Scope: </Text>
            {details.scope}
          </Text>
          <Text>
            <Text dimColor>Authority: </Text>
            {details.authority}
          </Text>
          {details.channel ? (
            <Text>
              <Text dimColor>Channel: </Text>
              {details.channel}
            </Text>
          ) : null}
          {details.gate ? (
            <Text>
              <Text dimColor>Gate: </Text>
              {details.gate}
            </Text>
          ) : null}
          {details.argument ? (
            <Text>
              <Text dimColor>Argument: </Text>
              {details.argument}
            </Text>
          ) : null}
          <Text>
            <Text dimColor>Invoke: </Text>
            {details.invocation}
          </Text>
          <Text dimColor>{details.availability}</Text>
        </Box>
      ) : null}
      <Text dimColor>Ctrl+K toggle · ↑↓ select · Enter run · Esc close</Text>
    </Box>
  );
}
