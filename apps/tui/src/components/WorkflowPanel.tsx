import { terminalSafe } from "@muon/client";
import { Box, Text } from "ink";
import type { WorkflowRunRecord } from "@muon/client";
import { hub, panelBorder } from "../lib/theme.js";

type Props = {
  runs: WorkflowRunRecord[];
  selectedIndex: number;
};

const STATUS_GLYPHS: Record<string, string> = {
  proposed: "◇",
  applied: "◆",
  running: "●",
  paused: "◐",
  done: "✓",
  abandoned: "✗",
};

export function WorkflowPanel({ runs, selectedIndex }: Props) {
  const selected = runs[selectedIndex];
  return (
    <Box
      flexDirection="column"
      borderStyle={panelBorder}
      borderColor={hub.border}
      borderDimColor
      paddingX={1}
      width="80%"
    >
      <Text bold>WORKFLOW RUNS</Text>
      {runs.length === 0 ? (
        <Text dimColor>
          No workflow runs yet — press / and describe a goal, or run: muon plan
        </Text>
      ) : (
        runs.slice(0, 8).map((run, index) => (
          <Text
            key={run.id}
            wrap="truncate"
            color={index === selectedIndex ? hub.focus : undefined}
            bold={index === selectedIndex}
          >
            {index === selectedIndex ? "› " : "  "}
            {STATUS_GLYPHS[run.status] ?? "·"} [{run.status}]{" "}
            {terminalSafe(run.templateKey ?? "ad-hoc")},{" "}
            {terminalSafe(run.proposal.summary).slice(0, 60)}
          </Text>
        ))
      )}
      {selected ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor wrap="truncate">
            steps ({selected.id}):
          </Text>
          {selected.proposal.steps.map((step) => (
            <Text key={step.stepKey} wrap="truncate" dimColor>
              {"  "}
              {step.stepKey} · {step.role === "human" ? "human" : step.laneKey ?? step.role}
              {step.harnessKey ? ` +${step.harnessKey}` : ""}
              {step.loop ? ` ↻${step.loop.maxIterations}` : ""}
              {step.gate ? ` ⛔${step.gate}` : ""}
            </Text>
          ))}
        </Box>
      ) : null}
      <Text dimColor>j/k select · a apply · x apply + execute here · Esc close</Text>
    </Box>
  );
}
