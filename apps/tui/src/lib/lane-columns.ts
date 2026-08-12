import type { Assignment, Lane, RecordedEvent, Task } from "@muon/client";

export type LaneColumnModel = {
  lane: Lane;
  activeTaskIds: string[];
  events: RecordedEvent[];
};

export function groupEventsByLane(
  lanes: Lane[],
  events: RecordedEvent[],
  limitPerLane = 12
): Map<string, RecordedEvent[]> {
  const byLane = new Map<string, RecordedEvent[]>();
  for (const lane of lanes) {
    byLane.set(lane.id, []);
  }

  const sorted = [...events].sort((a, b) =>
    a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0
  );

  for (const event of sorted) {
    const bucket = byLane.get(event.laneId);
    if (!bucket) {
      continue;
    }
    if (bucket.length < limitPerLane) {
      bucket.push(event);
    }
  }

  return byLane;
}

export function buildLaneColumns(
  lanes: Lane[],
  tasks: Task[],
  events: RecordedEvent[]
): LaneColumnModel[] {
  const eventsByLane = groupEventsByLane(lanes, events);

  return lanes.map((lane) => {
    const activeTaskIds = tasks
      .filter((task) =>
        (task.assignments ?? []).some(
          (assignment: Assignment) =>
            assignment.laneId === lane.id &&
            assignment.state !== "completed" &&
            assignment.state !== "cancelled"
        )
      )
      .map((task) => task.id);

    return {
      lane,
      activeTaskIds,
      events: eventsByLane.get(lane.id) ?? [],
    };
  });
}

export function coalesceProgressTail(
  events: RecordedEvent[]
): RecordedEvent[] {
  const result: RecordedEvent[] = [];
  for (const event of events) {
    const prev = result[result.length - 1];
    if (
      prev &&
      prev.kind === "task.progress" &&
      event.kind === "task.progress" &&
      prev.laneId === event.laneId &&
      prev.taskId === event.taskId
    ) {
      result[result.length - 1] = event;
      continue;
    }
    result.push(event);
  }
  return result;
}
