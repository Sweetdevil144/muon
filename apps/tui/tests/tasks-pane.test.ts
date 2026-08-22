import { describe, expect, it } from "vitest";
import { TasksPane } from "../src/shell/tasks-pane.js";
import type { TaskDetail } from "@muon/client";

// ── ADR-0087 M10/M11 — the packets zone renders the three ledgers ───────────
//
// What these pin: the shared classifier's word per packet (a schema
// fragment reads loudly), 0086 D1's receipt-with-the-packet (absence is
// STATED), and 0080 D3's delivery verdicts ("filed, unread" and "read by
// J" are different sentences). Strings are terminalSafe'd.

const strip = (lines: string[]) =>
  lines.map((line) => line.replaceAll(/\[[0-9;]*m/g, "")).join("\n");

function detail(over: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "task-1",
    title: "Ship the retry logic",
    description: "d",
    status: "in_progress",
    priority: "medium",
    createdAt: "2026-08-22T09:00:00Z",
    updatedAt: "2026-08-22T09:00:00Z",
    assignments: [],
    handoffs: [],
    approvals: [],
    ...over,
  } as TaskDetail;
}

const TYPED_PACKET = {
  taskGoal: "ship the retry logic",
  whatChanged: "added retries",
  whatFailed: "nothing failed",
  nextLaneRequest: "review it",
  commandsRun: [],
  checksStatus: [],
  openQuestions: [],
  provenance: { lane: "codex", createdAt: "2026-08-22T09:00:00Z" },
  degraded: { flag: false, reasons: [] },
  brainReceipt: "context_updated",
};

function handoff(over: Record<string, unknown> = {}) {
  return {
    id: "h1",
    packetTitle: "wrap packet",
    packetBody: "body",
    packetJson: TYPED_PACKET,
    status: "filed",
    createdAt: "2026-08-22T09:10:00Z",
    ...over,
  } as TaskDetail["handoffs"][number];
}

describe("the packets zone", () => {
  it("renders the classifier's word, the receipt, and the delivery verdict per packet", () => {
    const text = strip(
      new TasksPane({
        phase: "detail",
        tasks: [],
        cursor: 0,
        detail: detail({
          handoffs: [
            handoff({
              deliveries: [{ jobId: "cmb4reader0001abcdefghijk", firstAt: "t" }],
            }),
            handoff({
              id: "h2",
              packetTitle: "schema fragment",
              packetJson: { version: 1, nonsense: true },
              deliveries: [],
            }),
          ],
        }),
      }).render(200)
    );
    expect(text).toContain("typed");
    expect(text).toContain("receipt: context_updated");
    expect(text).toContain("read by");
    // The fragment reads LOUDLY, and its unread state is its own sentence.
    expect(text).toContain("packet_parse_failed");
    expect(text).toContain("filed, unread — no crew job has read this packet");
  });

  it("a typed packet WITHOUT a receipt states the absence; degradation carries its count", () => {
    const { brainReceipt: _dropped, ...withoutReceipt } = TYPED_PACKET;
    const text = strip(
      new TasksPane({
        phase: "detail",
        tasks: [],
        cursor: 0,
        detail: detail({
          handoffs: [
            handoff({
              packetJson: {
                ...withoutReceipt,
                degraded: { flag: true, reasons: ["checks not run"] },
              },
            }),
          ],
        }),
      }).render(200)
    );
    expect(text).toContain("receipt: none recorded");
    expect(text).toContain("degraded: 1 reason(s)");
  });

  it("agent-authored titles are terminal-sanitized, and a delivery-less field (agent read) renders no delivery line", () => {
    const hostile = "evil[2Jtitle";
    const text = strip(
      new TasksPane({
        phase: "detail",
        tasks: [],
        cursor: 0,
        detail: detail({
          handoffs: [handoff({ packetTitle: hostile })],
        }),
      }).render(200)
    );
    expect(text).not.toContain("[2J");
    // No deliveries field (an agent-tier read): the pane must not invent
    // "unread" from absence — absent evidence is absent, never zero.
    expect(text).not.toContain("delivery:");
  });

  it("the list phase renders tasks with a cursor and an honest empty state", () => {
    const empty = strip(
      new TasksPane({ phase: "list", tasks: [], cursor: 0 }).render(120)
    );
    expect(empty).toContain("no tasks yet");
    const listed = strip(
      new TasksPane({
        phase: "list",
        tasks: [
          { id: "t1", title: "First", status: "backlog" } as never,
          { id: "t2", title: "Second", status: "done" } as never,
        ],
        cursor: 1,
      }).render(120)
    );
    expect(listed).toContain("▸ Second");
  });
});
