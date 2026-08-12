import { terminalSafe } from "@muon/client";
import { Box, Text } from "ink";
import type { DeskTab, DeskTabsState } from "../lib/desk-tabs.js";
import { hub } from "../lib/theme.js";

/**
 * ADR-0032 D2 — the center tab strip.
 *
 * Ordinals are shown because `1`-`9` switch tabs; without the number on screen
 * the binding is undiscoverable. A closable tab carries a `·` marker rather
 * than an `x` glyph: `x` is the close KEY, and putting it in the label reads as
 * a button in a surface that has no mouse.
 */
export function TabStrip({
  state,
  width,
  attention,
}: {
  state: DeskTabsState;
  width: number;
  /** Tab ids that want the operator — rendered warm so a backgrounded
   *  stream that went blocked is visible without switching to it. */
  attention?: ReadonlySet<string>;
}) {
  return (
    <Box width={width} overflow="hidden">
      {state.tabs.map((tab, index) => (
        <TabChip
          key={tab.id}
          tab={tab}
          ordinal={index + 1}
          active={tab.id === state.activeId}
          wants={attention?.has(tab.id) ?? false}
        />
      ))}
    </Box>
  );
}

function TabChip({
  tab,
  ordinal,
  active,
  wants,
}: {
  tab: DeskTab;
  ordinal: number;
  active: boolean;
  wants: boolean;
}) {
  const color = active ? hub.focus : wants ? hub.warn : undefined;
  return (
    <Box marginRight={1}>
      <Text color={color} dimColor={!active && !wants} bold={active}>
        {ordinal <= 9 ? `${ordinal} ` : "  "}
        {terminalSafe(tab.title)}
        {tab.closable ? " ·" : ""}
      </Text>
    </Box>
  );
}
