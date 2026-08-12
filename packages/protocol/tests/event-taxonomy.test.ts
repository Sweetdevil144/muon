import { describe, expect, it } from "vitest";
import {
  classifyContextWindowChunkFromLaneEvent,
  contextWindowChunkKindSchema,
  isContextWindowChunkKind,
  isSystemRecordedEventKind,
  laneEventKindSchema,
  type LaneEvent,
} from "../src/events.js";

const laneEvent = (
  kind: LaneEvent["kind"],
  metadata: LaneEvent["metadata"] = {}
): Pick<LaneEvent, "kind" | "metadata"> => ({
  kind,
  metadata,
});

describe("event taxonomy (TODO 5.6)", () => {
  it("keeps context-window and system-recorded kind sets disjoint", () => {
    for (const kind of contextWindowChunkKindSchema.options) {
      expect(laneEventKindSchema.safeParse(kind).success).toBe(false);
    }
    for (const kind of laneEventKindSchema.options) {
      expect(contextWindowChunkKindSchema.safeParse(kind).success).toBe(false);
    }
  });

  it("classifies assistant prose, control-plane activity, and milestones", () => {
    expect(
      classifyContextWindowChunkFromLaneEvent(
        laneEvent("task.progress", { outputMode: "message" })
      )
    ).toBe("output.message");
    expect(
      classifyContextWindowChunkFromLaneEvent(laneEvent("task.progress", {}))
    ).toBe("output");
    expect(
      classifyContextWindowChunkFromLaneEvent(
        laneEvent("task.progress", { controlPlane: true })
      )
    ).toBe("activity");
    expect(
      classifyContextWindowChunkFromLaneEvent(laneEvent("task.started", {}))
    ).toBe("milestone");
  });

  it("exposes narrow type guards for each taxonomy", () => {
    expect(isContextWindowChunkKind("output")).toBe(true);
    expect(isContextWindowChunkKind("task.progress")).toBe(false);
    expect(isSystemRecordedEventKind("task.progress")).toBe(true);
    expect(isSystemRecordedEventKind("output")).toBe(false);
  });
});
