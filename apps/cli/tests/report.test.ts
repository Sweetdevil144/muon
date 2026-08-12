import { describe, expect, it } from "vitest";
import { buildTaskReport } from "../src/lib/report.js";
import type { RecordedEvent, TaskDetail } from "../src/types.js";

const lane = (key: string, name: string) => ({
  id: `lane-${key}`,
  key,
  name,
  provider: "test",
  role: "peer",
  status: "available",
});

const taskDetail: TaskDetail = {
  id: "task-1",
  title: "Fix the failing backend test",
  description: "Make the API suite green again.",
  status: "review",
  priority: "high",
  createdAt: "2026-07-06T09:00:00.000Z",
  updatedAt: "2026-07-06T11:00:00.000Z",
  assignments: [
    {
      id: "assignment-1",
      summary: "muon run: Fix the failing test",
      state: "queued",
      createdAt: "2026-07-06T09:05:00.000Z",
      completedAt: null,
      lane: lane("codex", "Codex"),
    },
  ],
  handoffs: [
    {
      id: "handoff-1",
      packetTitle: "Run handoff: codex -> claude-code (task task-1)",
      packetBody: "## Task goal\nFix the failing test",
      status: "pending",
      createdAt: "2026-07-06T10:30:00.000Z",
      fromLane: lane("codex", "Codex"),
      toLane: lane("claude-code", "Claude Code"),
    },
  ],
  approvals: [
    {
      id: "approval-1",
      requestedBy: "codex",
      kind: "command",
      reason: "muon run on lane 'codex'",
      status: "approved",
      decisionNotes: "go ahead",
      createdAt: "2026-07-06T09:01:00.000Z",
      decidedAt: "2026-07-06T09:02:00.000Z",
    },
  ],
};

const events: RecordedEvent[] = [
  {
    id: "event-1",
    laneId: "codex",
    taskId: "task-1",
    kind: "task.started",
    message: "Running codex",
    metadata: { command: "codex" },
    timestamp: "2026-07-06T10:00:00.000Z",
  },
  {
    id: "event-2",
    laneId: "codex",
    taskId: "task-1",
    kind: "task.completed",
    message: "Command completed",
    metadata: { exitCode: 0 },
    timestamp: "2026-07-06T10:00:05.000Z",
  },
];

describe("buildTaskReport", () => {
  it("renders a markdown report covering who, what, when, and why", () => {
    const report = buildTaskReport({
      task: taskDetail,
      events,
      generatedAt: "2026-07-06T12:00:00.000Z",
    });

    expect(report).toContain("# MUON Run Report");
    expect(report).toContain("Fix the failing backend test");
    expect(report).toContain("task-1");

    // who
    expect(report).toContain("## Assignments");
    expect(report).toContain("Codex");
    expect(report).toContain("muon run: Fix the failing test");

    // what/when
    expect(report).toContain("## Event timeline");
    expect(report).toContain("task.started");
    expect(report).toContain("2026-07-06T10:00:00.000Z");
    expect(report).toContain("Command completed");

    // handoffs
    expect(report).toContain("## Handoffs");
    expect(report).toContain("Codex -> Claude Code");

    // why
    expect(report).toContain("## Approvals");
    expect(report).toContain("muon run on lane 'codex'");
    expect(report).toContain("approved");
    expect(report).toContain("go ahead");

    expect(report).toContain("2026-07-06T12:00:00.000Z");
  });

  it("marks empty sections explicitly instead of omitting them", () => {
    const report = buildTaskReport({
      task: {
        ...taskDetail,
        assignments: [],
        handoffs: [],
        approvals: [],
      },
      events: [],
      generatedAt: "2026-07-06T12:00:00.000Z",
    });

    expect(report).toContain("No assignments recorded");
    expect(report).toContain("No events recorded");
    expect(report).toContain("No handoffs recorded");
    expect(report).toContain("No approvals recorded");
  });
});

describe("ADR-0037 phase 2 — the flakiness annotation reaches a human", () => {
  // Phase 1 computed this annotation and NOBODY ever saw it: every consumer
  // re-validated with `handoffPacketSchema`, which strips unknown keys, and
  // `orderForReport` had no production caller. The acceptance test for phase 2
  // is therefore "does a human see it?", not "is it computed?".

  const packet = (checks: unknown[]) => ({
    taskGoal: "goal",
    whatChanged: "changed",
    whatFailed: "failed",
    nextLaneRequest: "next",
    commandsRun: [],
    checksStatus: [],
    openQuestions: [],
    provenance: { lane: "codex", createdAt: "2026-08-07T00:00:00.000Z" },
    checks,
  });

  const reportFor = (checks: unknown[]) =>
    buildTaskReport({
      task: {
        ...taskDetail,
        handoffs: [{ ...taskDetail.handoffs[0]!, packetJson: packet(checks) }],
      },
      events: [] as RecordedEvent[],
    });

  it("PRINTS the note MUON computed, beside the outcome", () => {
    const report = reportFor([
      {
        name: "npm test",
        outcome: "failed",
        summary: "1 failing",
        flakiness: { kind: "flaky", runs: 9, failures: 1 },
        flakinessNote: "known-flaky: failed 1 of 9 recorded runs",
      },
    ]);
    expect(report).toContain("known-flaky: failed 1 of 9 recorded runs");
    // D1: the outcome is printed AS-IS. The note is appended, never
    // substituted — a reader cannot see the history without the failure.
    expect(report).toContain("[failed] npm test");
  });

  it("keeps a known-flaky failure IN the report, only lower (D4 lossless)", () => {
    const report = reportFor([
      {
        name: "flaky-one",
        outcome: "failed",
        summary: "",
        flakiness: { kind: "flaky", runs: 9, failures: 1 },
        flakinessNote: "known-flaky: failed 1 of 9 recorded runs",
      },
      { name: "unexplained", outcome: "failed", summary: "" },
    ]);
    expect(report).toContain("flaky-one");
    expect(report).toContain("unexplained");
    // The unexplained failure wants a person first.
    expect(report.indexOf("unexplained")).toBeLessThan(
      report.indexOf("flaky-one")
    );
  });

  it("puts a consistently-failing check at the very top — it is broken, not flaky", () => {
    const report = reportFor([
      { name: "passing-check", outcome: "passed", summary: "" },
      {
        name: "broken-check",
        outcome: "failed",
        summary: "",
        flakiness: { kind: "consistently-failing", runs: 5, failures: 5 },
        flakinessNote: "failed 5 of 5 recorded runs",
      },
    ]);
    const checksSection = report.slice(report.indexOf("**Checks**"));
    expect(checksSection.indexOf("broken-check")).toBeLessThan(
      checksSection.indexOf("passing-check")
    );
  });

  it("never tells a reader to ignore, retry, or dismiss a check", () => {
    // D3. "so you can ignore it" is exactly the conclusion this must not
    // license, and it is the whole reason ADR-0037 exists.
    const report = reportFor([
      {
        name: "npm test",
        outcome: "failed",
        summary: "",
        flakiness: { kind: "flaky", runs: 9, failures: 1 },
        flakinessNote: "known-flaky: failed 1 of 9 recorded runs",
      },
    ]);
    const checksSection = report.slice(report.indexOf("**Checks**"));
    expect(checksSection).not.toMatch(/ignore|safe to|dismiss|can be skipped/i);
  });

  it("renders an UNANNOTATED packet without inventing a history", () => {
    // A check MUON has never seen must not read as anything. Absent stays
    // absent — the same rule the annotator itself follows.
    const report = reportFor([
      { name: "npm test", outcome: "passed", summary: "ok" },
    ]);
    expect(report).toContain("[passed] npm test");
    expect(report).not.toMatch(/recorded runs|known-flaky|stable/);
  });

  it("prints nothing extra for a packet with no checks, or none at all", () => {
    expect(reportFor([])).not.toContain("**Checks**");
    const noPacket = buildTaskReport({
      task: taskDetail,
      events: [] as RecordedEvent[],
    });
    expect(noPacket).not.toContain("**Checks**");
  });

  it("survives a malformed packet rather than failing the whole report", () => {
    // packetJson is agent-authored and stored as JSON; a report that throws on
    // one bad packet loses the audit trail for everything else in the task.
    for (const bad of ["not-an-object", 42, { checks: "not-an-array" }, null]) {
      const report = buildTaskReport({
        task: {
          ...taskDetail,
          handoffs: [{ ...taskDetail.handoffs[0]!, packetJson: bad }],
        },
        events: [] as RecordedEvent[],
      });
      expect(report, String(bad)).toContain("## Handoffs");
    }
  });
});
