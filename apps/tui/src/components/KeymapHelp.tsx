import { Box, Text } from "ink";
import {
  filterKeymap,
  formatKeys,
  KEYMAP_GROUP_LABEL,
  KEYMAP_GROUP_ORDER,
  type KeymapEntry,
} from "../lib/keymap.js";
import { hub } from "../lib/theme.js";

/**
 * ADR-0032 D6 — the `?` overlay, rendered from the one keymap table.
 *
 * Deliberately not a curated subset: the whole point of the table is that the
 * help screen cannot fall behind the bindings. A binding that exists but is
 * dispatched inside a panel shows the panel's name, so "where does this key
 * work" is answerable from the screen.
 */
export function KeymapHelp({
  query,
  width,
  maxRows = 24,
}: {
  query: string;
  width: number;
  /**
   * Rows available for the list. The full table is taller than most terminals,
   * and Ink OVERLAPS rather than clips when a flex child overflows a sized
   * parent — two bindings drawn on the same line, which is worse than not
   * showing them. Everything past the budget is reported as a count and reached
   * by filtering.
   */
  maxRows?: number;
}) {
  const matches = filterKeymap(query);
  const byGroup = KEYMAP_GROUP_ORDER.map((group) => ({
    group,
    entries: matches.filter((entry) => entry.group === group),
  })).filter((section) => section.entries.length > 0);

  // Budget rows across groups in order: each group costs a heading plus its
  // entries. Truncation is reported, never silent.
  const budget = Math.max(2, maxRows - 2);
  const shown: { group: (typeof byGroup)[number]["group"]; entries: KeymapEntry[] }[] = [];
  let used = 0;
  let hidden = 0;
  for (const section of byGroup) {
    if (used + 1 >= budget) {
      hidden += section.entries.length;
      continue;
    }
    used += 1; // heading
    const room = Math.max(0, budget - used);
    const entries = section.entries.slice(0, room);
    hidden += section.entries.length - entries.length;
    used += entries.length;
    if (entries.length > 0) shown.push({ group: section.group, entries });
  }

  return (
    <Box flexDirection="column" width={width} paddingX={1} overflow="hidden">
      <Text bold color={hub.focus}>
        KEYS · {matches.length} binding{matches.length === 1 ? "" : "s"}
        {query ? ` · filter: ${query}` : ""}
        {hidden > 0 ? ` · ${hidden} more, type to filter` : ""}
      </Text>
      {byGroup.length === 0 ? (
        <Text dimColor>no binding matches “{query}”</Text>
      ) : (
        shown.map((section) => (
          <Box key={section.group} flexDirection="column">
            <Text bold>{KEYMAP_GROUP_LABEL[section.group]}</Text>
            {section.entries.map((entry) => (
              <KeyRow key={entry.id} entry={entry} />
            ))}
          </Box>
        ))
      )}
    </Box>
  );
}

function KeyRow({ entry }: { entry: KeymapEntry }) {
  const scope = entry.zone ?? entry.panel;
  return (
    <Box>
      <Box width={12} flexShrink={0}>
        <Text color={hub.accent}>{formatKeys(entry)}</Text>
      </Box>
      <Text>{entry.description}</Text>
      {scope ? <Text dimColor> · {scope}</Text> : null}
    </Box>
  );
}
