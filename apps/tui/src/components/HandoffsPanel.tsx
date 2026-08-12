import { Box, Text } from "ink";
import { terminalSafe, type Handoff } from "@muon/client";
import { hub } from "../lib/theme.js";
import { ZoneLabel } from "./chrome.js";

type Props = {
  handoffs: Handoff[];
  focused: boolean;
  selectedIndex: number;
  maxRows?: number;
};

export function HandoffsPanel({
  handoffs,
  focused,
  selectedIndex,
  maxRows = 8,
}: Props) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <ZoneLabel text="HANDOFFS" count={handoffs.length} focused={focused} />
      {handoffs.length === 0 ? (
        <Text dimColor>None yet — appears when a lane hands work to another</Text>
      ) : (
        handoffs.slice(0, maxRows).map((handoff, index) => {
          const active = index === selectedIndex && focused;
          const marker = active ? "›" : " ";
          const from = handoff.fromLane?.key ?? "?";
          const to = handoff.toLane?.key ?? "?";
          return (
            <Text
              key={handoff.id}
              wrap="truncate"
              color={active ? hub.focus : undefined}
              bold={active}
            >
              {marker} {from} → {to}
              <Text dimColor>
                {" "}
                · {handoff.status} · {terminalSafe(handoff.packetTitle)}
              </Text>
            </Text>
          );
        })
      )}
    </Box>
  );
}
