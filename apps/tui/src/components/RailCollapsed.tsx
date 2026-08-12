import { Box, Text } from "ink";
import type { AttentionState } from "../lib/attention.js";
import { attentionPriority } from "../lib/attention.js";
import { hub } from "../lib/theme.js";

/**
 * ADR-0032 D1 — the rail, collapsed.
 *
 * While a center panel is open the rail keeps its job (is anything on fire?)
 * but gives up its width, so a detail panel gets room to render without
 * truncating. It is still MOUNTED — the invariant is that the operator never
 * loses sight of the crew, not that the crew always gets 26 columns.
 *
 * The reference TUI does the same thing with `render_sidebar_collapsed`; the difference is
 * what survives the collapse. Here it is the attention glyphs, because that is
 * the one signal that must not wait for the panel to close.
 */

const GLYPHS: Record<AttentionState, string> = {
  blocked: "◆",
  failed: "✗",
  warning: "▲",
  done: "✓",
  working: "●",
  idle: "○",
  unknown: "·",
};

function toneOf(state: AttentionState): string | undefined {
  if (state === "blocked") return hub.warn;
  if (state === "failed") return "red";
  if (state === "warning") return hub.warn;
  if (state === "done") return hub.accent;
  return undefined;
}

export function RailCollapsed({
  states,
  taskCount,
  width,
}: {
  /** One entry per lane, in rail order. */
  states: readonly AttentionState[];
  taskCount: number;
  width: number;
}) {
  // Most-demanding first: in three columns, the blocked lane must be one of
  // the ones that survives the clip.
  const ordered = [...states].sort(
    (a, b) => attentionPriority(b) - attentionPriority(a)
  );
  return (
    <Box flexDirection="column" width={width} flexShrink={0} paddingX={1}>
      <Text dimColor>◂</Text>
      <Box flexWrap="wrap" width={Math.max(1, width - 2)}>
        {ordered.length === 0 ? (
          <Text dimColor>·</Text>
        ) : (
          ordered.map((state, index) => (
            <Text key={index} color={toneOf(state)}>
              {GLYPHS[state]}
            </Text>
          ))
        )}
      </Box>
      <Text dimColor>{taskCount}w</Text>
    </Box>
  );
}
