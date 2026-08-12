import { Text } from "ink";
import { hub } from "../lib/theme.js";

/** Horizontal hairline — the only divider between vertical regions. */
export function Rule({ width }: { width: number }) {
  return <Text dimColor>{"─".repeat(Math.max(0, width))}</Text>;
}

/**
 * The caps role: every panel header routes through this. Caps text stays dim
 * unless the zone is focused (cyan) or carries a needs-you count (yellow).
 */
export function ZoneLabel({
  text,
  count,
  focused,
  attention,
}: {
  text: string;
  count?: number;
  focused?: boolean;
  attention?: boolean;
}) {
  return (
    <Text
      color={attention ? hub.warn : focused ? hub.focus : undefined}
      dimColor={!focused && !attention}
    >
      {text}
      {count !== undefined ? ` [${count}]` : ""}
    </Text>
  );
}
