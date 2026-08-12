import { describe, expect, it } from "vitest";
import {
  buildMissionEvidence,
  filterMissionEvidence,
} from "../src/lib/mission-evidence.js";

/**
 * U3 — the Evidence tab's default is this mission's own record, and the search
 * box filters it. These pin both halves: content without a query, and a query
 * that narrows rather than gates.
 */

const vendorLabel = (vendor: string) =>
  vendor === "codex" ? "Codex" : "Claude Code";
const statusLabel = (status?: string | null) =>
  status === "running" ? "Working" : (status ?? "Unknown");

const JOBS = [
  {
    id: "job-1",
    taskId: "task-1",
    vendor: "codex",
    status: "running",
    brief: "Research: GitNexus web frontend",
    capabilityMode: "delegate",
    workspacePath: "/repo/wt-1",
    createdAt: "2026-07-26T10:00:00.000Z",
    checks: [{ name: "npm test" }],
    result: "Wrote docs/research/frontend.md",
  },
  {
    id: "job-2",
    taskId: "task-2",
    vendor: "claude-code",
    status: "done",
    brief: "Wire the composer",
    capabilityMode: "worker",
    workspacePath: "/repo/wt-2",
    createdAt: "2026-07-26T11:00:00.000Z",
  },
] as const;

const EVENTS = [
  {
    id: "ev-1",
    taskId: "task-1",
    kind: "approval.requested",
    message: "session tool request: Bash",
    timestamp: "2026-07-26T10:05:00.000Z",
  },
  {
    id: "ev-2",
    taskId: "task-1",
    kind: "handoff.created",
    message: "handoff packet for task-1",
    timestamp: "2026-07-26T10:06:00.000Z",
  },
  {
    id: "ev-3",
    taskId: "task-1",
    kind: "task.progress",
    message: "noise that is not evidence",
    timestamp: "2026-07-26T10:07:00.000Z",
  },
] as const;

function build() {
  return buildMissionEvidence({
    jobs: JOBS,
    events: EVENTS,
    taskTitles: new Map([
      ["task-1", "Frontend research"],
      ["task-2", "Composer"],
    ]),
    vendorLabel,
    statusLabel,
  });
}

describe("buildMissionEvidence", () => {
  it("has content with NO query — the mission's own record", () => {
    const evidence = build();
    expect(evidence.empty).toBe(false);
    expect(evidence.counts.worked).toBe(2);
    expect(evidence.counts.produced).toBe(1);
    expect(evidence.counts.decided).toBe(1);
    expect(evidence.counts.cited).toBe(1);
  });

  it("names each agent, its task, its authority, and its workspace", () => {
    const worked = build().items.find((item) => item.id === "job:job-1");
    expect(worked?.title).toBe("Codex · Frontend research");
    expect(worked?.body).toContain("GitNexus web frontend");
    expect(worked?.meta).toContain("Working");
    expect(worked?.meta).toContain("delegate");
    expect(worked?.meta).toContain("/repo/wt-1");
  });

  it("keeps lifecycle noise out of evidence", () => {
    const evidence = build();
    expect(evidence.items.some((item) => item.id === "event:ev-3")).toBe(false);
  });

  it("reads newest first", () => {
    const evidence = build();
    expect(evidence.items[0]?.timestamp).toBe("2026-07-26T11:00:00.000Z");
  });

  it("is honestly empty for a mission that has not run anything", () => {
    const evidence = buildMissionEvidence({
      jobs: [],
      events: [],
      vendorLabel,
      statusLabel,
    });
    expect(evidence.empty).toBe(true);
    expect(evidence.items).toHaveLength(0);
  });

  it("bounds an unbounded mission and says how many it dropped", () => {
    const many = Array.from({ length: 400 }, (_, index) => ({
      id: `job-${index}`,
      taskId: "task-1",
      vendor: "codex",
      status: "done",
      brief: "x",
      createdAt: `2026-07-26T10:${String(index % 60).padStart(2, "0")}:00.000Z`,
    }));
    const evidence = buildMissionEvidence({
      jobs: many,
      events: [],
      vendorLabel,
      statusLabel,
    });
    expect(evidence.items.length).toBe(300);
    expect(evidence.omitted).toBe(100);
  });

  it("bounds an over-long agent-authored brief", () => {
    const evidence = buildMissionEvidence({
      jobs: [
        {
          id: "job-x",
          taskId: "task-1",
          vendor: "codex",
          status: "done",
          brief: "b".repeat(5_000),
        },
      ],
      events: [],
      vendorLabel,
      statusLabel,
    });
    expect(evidence.items[0]!.body.length).toBeLessThanOrEqual(600);
  });
});

describe("filterMissionEvidence", () => {
  it("returns everything for an empty query — search never gates", () => {
    const evidence = build();
    expect(filterMissionEvidence(evidence.items, "")).toHaveLength(
      evidence.items.length
    );
    expect(filterMissionEvidence(evidence.items, "   ")).toHaveLength(
      evidence.items.length
    );
  });

  it("narrows on every term, not just one", () => {
    const evidence = build();
    expect(filterMissionEvidence(evidence.items, "codex").length).toBeGreaterThan(
      0
    );
    expect(
      filterMissionEvidence(evidence.items, "codex composer")
    ).toHaveLength(0);
  });

  it("is case-insensitive over titles, bodies, and coordinates", () => {
    const evidence = build();
    expect(
      filterMissionEvidence(evidence.items, "GITNEXUS").length
    ).toBeGreaterThan(0);
    expect(filterMissionEvidence(evidence.items, "/repo/wt-2").length).toBe(1);
  });
});
