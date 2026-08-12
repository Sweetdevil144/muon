import { describe, expect, it } from "vitest";
import type { Lane, RecordedEvent, Task } from "@muon/client";
import {
  buildLaneColumns,
  coalesceProgressTail,
} from "../src/lib/lane-columns.js";

const lanes: Lane[] = [
  {
    id: "lane-cc",
    key: "claude",
    name: "Claude Code",
    provider: "anthropic",
    role: "peer",
    status: "available",
  },
  {
    id: "lane-cx",
    key: "codex",
    name: "Codex",
    provider: "openai",
    role: "peer",
    status: "available",
  },
];

describe("lane-columns", () => {
  it("groups events into per-lane columns with active tasks", () => {
    const tasks: Task[] = [
      {
        id: "task-1",
        title: "Ship TUI",
        description: "",
        status: "in_progress",
        priority: "high",
        assignments: [
          {
            id: "a1",
            taskId: "task-1",
            laneId: "lane-cx",
            summary: "build",
            state: "running",
          },
        ],
      },
    ];
    const events: RecordedEvent[] = [
      {
        id: "e1",
        laneId: "lane-cx",
        taskId: "task-1",
        kind: "task.started",
        message: "go",
        metadata: {},
        timestamp: "2026-07-09T01:00:00.000Z",
      },
      {
        id: "e2",
        laneId: "lane-cc",
        taskId: "task-1",
        kind: "task.progress",
        message: "planning",
        metadata: {},
        timestamp: "2026-07-09T01:00:01.000Z",
      },
    ];

    const columns = buildLaneColumns(lanes, tasks, events);
    expect(columns).toHaveLength(2);
    expect(columns[1]?.activeTaskIds).toEqual(["task-1"]);
    expect(columns[1]?.events[0]?.id).toBe("e1");
    expect(columns[0]?.events[0]?.id).toBe("e2");
  });

  it("coalesces consecutive progress events for the same task/lane", () => {
    const events: RecordedEvent[] = [
      {
        id: "1",
        laneId: "lane-cx",
        taskId: "t1",
        kind: "task.progress",
        message: "a",
        metadata: {},
        timestamp: "2026-07-09T01:00:00.000Z",
      },
      {
        id: "2",
        laneId: "lane-cx",
        taskId: "t1",
        kind: "task.progress",
        message: "b",
        metadata: {},
        timestamp: "2026-07-09T01:00:01.000Z",
      },
      {
        id: "3",
        laneId: "lane-cx",
        taskId: "t1",
        kind: "task.completed",
        message: "done",
        metadata: {},
        timestamp: "2026-07-09T01:00:02.000Z",
      },
    ];

    const coalesced = coalesceProgressTail(events);
    expect(coalesced).toHaveLength(2);
    expect(coalesced[0]?.message).toBe("b");
    expect(coalesced[1]?.kind).toBe("task.completed");
  });
});
