import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import type { AgentRecord, DispatchJobRecord, Task } from "@muon/client";
import { LaneDesk } from "../src/components/LaneDesk.js";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");

const agents: AgentRecord[] = Array.from({ length: 6 }, (_, index) => ({
  id: `agent-${index + 1}`,
  vendor: index % 2 === 0 ? "codex" : "claude-code",
  name: `crew-${index + 1}`,
  ordinal: index + 1,
  status: "working",
  currentTaskId: `task-${index + 1}`,
  currentJobId: `job-${index + 1}`,
}));

const jobs = agents.map(
  (agent, index) =>
    ({
      id: `job-${index + 1}`,
      agentId: agent.id,
      taskId: `task-${index + 1}`,
      status: "running",
      interruptRequested: false,
      createdAt: new Date(NOW - 5_000).toISOString(),
      lastProgressAt: new Date(NOW - 1_000).toISOString(),
      currentActivity: `editing module-${index + 1}.ts`,
    }) as DispatchJobRecord
);

const tasks: Task[] = agents.map((_, index) => ({
  id: `task-${index + 1}`,
  title: `Feature ${index + 1}`,
  description: "",
  status: "in_progress",
  priority: "high",
}));

describe("LaneDesk", () => {
  it("renders five live, addressable seats and windows to the selection", () => {
    const { lastFrame } = render(
      <LaneDesk
        agents={agents}
        jobs={jobs}
        tasks={tasks}
        events={[]}
        focused
        selectedIndex={5}
        now={NOW}
      />
    );
    const frame = lastFrame() ?? "";

    expect(frame).toContain("CREW DESK");
    expect(frame).not.toContain("crew-1");
    for (let index = 2; index <= 6; index += 1) {
      expect(frame).toContain(`crew-${index}`);
    }
    expect(frame).toContain("editing module-6");
    expect(frame).toContain("s Stop this lane");
    expect(frame).toContain("Working");
  });
});
