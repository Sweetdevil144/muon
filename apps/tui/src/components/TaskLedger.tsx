import { terminalSafe } from "@muon/client";
import { Box, Text } from "ink";
import type { Task } from "@muon/client";
import type { FocusZone } from "../lib/layout.js";
import { hub } from "../lib/theme.js";
import { ZoneLabel } from "./chrome.js";

type Props = {
  tasks: Task[];
  focused: boolean;
  selectedIndex: number;
  maxRows?: number;
  focusHint?: FocusZone;
};

function statusGlyph(status: string): string {
  if (status === "done") return "✓";
  if (status === "blocked" || status === "failed") return "✗";
  if (status === "in_progress" || status === "review") return "●";
  return "○";
}

export function TaskLedger({ tasks, focused, selectedIndex, maxRows = 16 }: Props) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <ZoneLabel text="WORK" count={tasks.length} focused={focused} />
      {tasks.length === 0 ? (
        <Text dimColor>No work yet — press / to brief the crew</Text>
      ) : (
        tasks.slice(0, maxRows).map((task, index) => {
          const active = index === selectedIndex && focused;
          const marker = active ? "›" : " ";
          return (
            <Text
              key={task.id}
              wrap="truncate"
              color={active ? hub.focus : undefined}
              bold={active}
            >
              {marker} {statusGlyph(task.status)} {terminalSafe(task.title)}
              <Text dimColor>
                {" "}
                · {task.status.replace(/_/g, " ")} · {task.priority}
              </Text>
            </Text>
          );
        })
      )}
    </Box>
  );
}
