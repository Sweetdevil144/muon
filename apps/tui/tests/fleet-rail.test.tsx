import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import type { AgentRecord, DispatchJobRecord } from "@muon/client";
import { FleetRail } from "../src/components/FleetRail.js";

const NOW = Date.parse("2026-07-19T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function agent(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    vendor: "codex",
    name: "codex-1",
    ordinal: 1,
    status: "working",
    currentTaskId: "task-1",
    currentJobId: "job-1",
    ...over,
  };
}

function job(over: Partial<DispatchJobRecord>): DispatchJobRecord {
  return {
    id: "job-1",
    agentId: "agent-1",
    taskId: "task-1",
    status: "running",
    createdAt: iso(5_000),
    ...over,
  } as unknown as DispatchJobRecord;
}

function frameOf(agents: AgentRecord[], jobs: DispatchJobRecord[]): string {
  const { lastFrame } = render(
    <FleetRail
      agents={agents}
      jobs={jobs}
      focused={false}
      selectedIndex={0}
      now={NOW}
    />
  );
  return lastFrame() ?? "";
}

describe("FleetRail crew-liveness (Wave 4.2 TUI parity)", () => {
  it("a silent agent in [warn, watchdog) reads Stalled (amber-before-death, same as desktop)", () => {
    const frame = frameOf(
      [agent({ currentJobId: "job-stall" })],
      [job({ id: "job-stall", status: "running", createdAt: iso(60_000) })]
    );
    expect(frame).toContain("codex-1");
    expect(frame).toContain("Stalled");
  });

  it("a long-running row with no durable output past the watchdog stays actionable", () => {
    const frame = frameOf(
      [agent({ currentJobId: "job-long" })],
      [job({ id: "job-long", status: "running", createdAt: iso(600_000) })]
    );
    expect(frame).toContain("Stalled");
    expect(frame).not.toContain("Live");
  });

  it("times the window from startedAt, not enqueue — a long-queued, freshly-launched silent job reads Stalled", () => {
    const frame = frameOf(
      [agent({ currentJobId: "job-late" })],
      [
        job({
          id: "job-late",
          status: "running",
          createdAt: iso(600_000), // enqueued 10min ago (past watchdog)
          startedAt: iso(60_000), // but launched only 60s ago
        }),
      ]
    );
    expect(frame).toContain("Stalled");
    expect(frame).not.toContain("Live");
  });

  it("real output overrides the elapsed clock — a producing job reads Working, never a false Stalled", () => {
    const frame = frameOf(
      [agent({ currentJobId: "job-out" })],
      [
        job({
          id: "job-out",
          status: "running",
          startedAt: iso(60_000),
          lastProgressAt: iso(2_000),
        }),
      ]
    );
    expect(frame).toContain("Working");
    expect(frame).not.toContain("Stalled");
  });

  it("a fresh agent within the startup window stays calm (Launching)", () => {
    const frame = frameOf(
      [agent({ currentJobId: "job-fresh" })],
      [job({ id: "job-fresh", status: "running", createdAt: iso(5_000) })]
    );
    expect(frame).toContain("Launching");
    expect(frame).not.toContain("Stalled");
  });

  it("a failed agent reads Needs attention (red)", () => {
    const frame = frameOf(
      [agent({ currentJobId: "job-bad" })],
      [job({ id: "job-bad", status: "failed" })]
    );
    expect(frame).toContain("Needs attention");
  });

  it("a clean exit reads Done", () => {
    const frame = frameOf(
      [agent({ currentJobId: "job-ok" })],
      [job({ id: "job-ok", status: "done", exitCode: 0 })]
    );
    expect(frame).toContain("Done");
  });

  it("an agent with no matching job keeps the plain status glyph — no liveness label", () => {
    const frame = frameOf([agent({ currentJobId: "nope", status: "working" })], []);
    expect(frame).toContain("codex-1");
    expect(frame).not.toContain("Stalled");
    expect(frame).not.toContain("Launching");
    expect(frame).not.toContain("Needs attention");
  });

  it("binds to the CURRENT job, never a stale agentId-matched one", () => {
    const frame = frameOf(
      [agent({ id: "agent-x", currentJobId: "job-new" })],
      [
        // Older terminal job shares the agentId; an un-prioritized match would
        // misreport this agent as failed.
        job({ id: "job-old", agentId: "agent-x", status: "failed" }),
        job({
          id: "job-new",
          agentId: "agent-x",
          status: "running",
          createdAt: iso(5_000),
        }),
      ]
    );
    expect(frame).toContain("Launching");
    expect(frame).not.toContain("Needs attention");
  });
});
