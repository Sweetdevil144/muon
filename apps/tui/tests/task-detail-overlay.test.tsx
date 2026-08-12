import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import {
  buildAuditTrail,
  evasionPayloads,
  residualDanger,
  type RecordedEvent,
  type TaskDetail,
} from "@muon/client";
import { plainFrame } from "./ansi.js";
import { TaskDetailOverlay } from "../src/components/TaskDetailOverlay.js";

const DETAIL: TaskDetail = {
  id: "task-1",
  title: "Ship cockpit",
  description: "build the review inbox",
  status: "in_progress",
  priority: "high",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
  assignments: [],
  handoffs: [],
  approvals: [],
};

function baseProps(events: RecordedEvent[]) {
  return { detail: DETAIL, events, memory: [], sessions: [] };
}

describe("TaskDetailOverlay timeline", () => {
  it("shows an honest empty state when there are no events", () => {
    const { lastFrame } = render(<TaskDetailOverlay {...baseProps([])} />);
    const frame = lastFrame() ?? "";

    expect(frame).toContain("no events");
  });

  it("renders approval.auto events with the SAME headline the desktop audit trail uses (reused, not duplicated copy)", () => {
    const event: RecordedEvent = {
      id: "event-auto-1",
      laneId: "lane-1",
      taskId: "task-1",
      kind: "approval.auto",
      message: "receipt r1 redeemed for edit_file",
      metadata: {},
      timestamp: "2026-07-18T00:00:05.000Z",
    };
    // The expected headline is computed via the SHARED client mapping, never
    // hardcoded here — if desktop's copy ever changes, this test tracks it.
    const expectedHeadline = buildAuditTrail([event])[0]!.headline;
    expect(expectedHeadline).toBe("Auto-approved a policy-bound action");

    const { lastFrame } = render(
      <TaskDetailOverlay {...baseProps([event])} />
    );
    const frame = lastFrame() ?? "";

    expect(frame).toContain(expectedHeadline);
    // The raw event kind string is no longer shown for approval.auto rows.
    expect(frame).not.toContain("approval.auto");
  });

  it("leaves other event kinds rendering their raw kind label (minimal, targeted change)", () => {
    const event: RecordedEvent = {
      id: "event-progress-1",
      laneId: "lane-1",
      taskId: "task-1",
      kind: "task.progress",
      message: "editing src/auth/guard.ts",
      metadata: {},
      timestamp: "2026-07-18T00:00:05.000Z",
    };
    const { lastFrame } = render(
      <TaskDetailOverlay {...baseProps([event])} />
    );
    const frame = lastFrame() ?? "";

    expect(frame).toContain("task.progress");
    expect(frame).toContain("editing src/auth/guard.ts");
  });
});

// ── Round-3 #8: the corpus at this overlay's render boundary ────────────────
//
// Seven agent-authored fields here rendered raw until 2026-08-08 — including
// `approval.reason` and `note.text`, both of which OTHER panels already
// sanitized. That is the drift a single implementation cannot prevent by
// itself: one call site forgets, and no lock catches it. These replays are
// what make the sweep durable.
describe("evasion corpus replay — TaskDetailOverlay", () => {
  function frameFor(text: string): string {
    const event: RecordedEvent = {
      id: "event-hostile",
      laneId: "lane-1",
      taskId: "task-1",
      kind: "task.progress",
      message: text,
      metadata: {},
      timestamp: "2026-07-18T00:00:05.000Z",
    };
    const { lastFrame } = render(
      <TaskDetailOverlay
        detail={{
          ...DETAIL,
          title: text,
          description: text,
          approvals: [
            {
              id: "approval-1",
              taskId: "task-1",
              requestedBy: "claude-code",
              kind: "command",
              reason: text,
              status: "pending",
              createdAt: "2026-07-18T00:00:00.000Z",
            },
          ] as TaskDetail["approvals"],
        }}
        events={[event]}
        memory={[]}
        sessions={[]}
      />
    );
    return lastFrame() ?? "";
  }

  it("no control-carrying payload reaches the frame through any field", () => {
    for (const payload of evasionPayloads(
      "invisible-directive",
      "reorder",
      "repaint",
      "row-forgery"
    )) {
      const raw = frameFor(payload.text);
      expect(
        residualDanger(plainFrame(raw), ["\n"]),
        `${payload.id} left hostile bytes in the frame`
      ).toEqual([]);
      // Without this, the row-forgery payload could render COMPLETELY raw
      // and still pass: its only dangerous code point is U+000A, which the
      // preserved set above subtracts (the frame is a multi-line box).
      expect(raw, `${payload.id} rendered verbatim`).not.toContain(
        payload.text
      );
    }
  }, 30_000);
});
