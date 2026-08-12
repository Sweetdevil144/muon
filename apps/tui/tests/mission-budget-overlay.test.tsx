import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import {
  buildBudgetLineView,
  pollFailBudgetLine,
  unknownBudgetLine,
} from "@muon/client";
import type { DispatchBudget } from "@muon/client";
import { MissionBudgetOverlay } from "../src/components/MissionBudgetOverlay.js";

function budget(overrides: Partial<DispatchBudget> = {}): DispatchBudget {
  return {
    jobId: "job-root",
    capabilityMode: "orchestrator",
    rootWallMs: 1_800_000,
    maxDescendantWallMs: 1_800_000,
    poolMs: 1_800_000,
    reservedMs: 300_000,
    consumedMs: 600_000,
    remainingMs: 900_000,
    deadlineAt: null,
    childrenIssued: 1,
    maxChildren: 3,
    descendantsIssued: 1,
    maxDescendants: 8,
    depth: 0,
    maxDepth: 3,
    children: [
      {
        jobId: "child-a",
        vendor: "codex",
        status: "running",
        depth: 1,
        reservedMs: 300_000,
        consumedMs: 120_000,
      },
      {
        jobId: "child-b",
        vendor: "claude-code",
        status: "done",
        depth: 1,
        reservedMs: 0,
        consumedMs: 60_000,
      },
    ],
    ...overrides,
  };
}

describe("MissionBudgetOverlay (per-descendant breakdown, crew view)", () => {
  it("ready: lists pool/reserved/consumed/remaining and every descendant", () => {
    const { lastFrame } = render(
      <MissionBudgetOverlay view={buildBudgetLineView(budget())} />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Mission budget");
    expect(frame).toContain("pool 30m");
    expect(frame).toContain("reserved 5m");
    expect(frame).toContain("consumed 10m");
    expect(frame).toContain("remaining 15m");
    expect(frame).toContain("Codex");
    expect(frame).toContain("running");
    expect(frame).toContain("Claude");
    expect(frame).toContain("done");
    expect(frame).toContain("Esc close");
  });

  it("exhausted: the sole needs-you state, breakdown still visible", () => {
    const view = buildBudgetLineView(budget({ remainingMs: 0 }));
    const { lastFrame } = render(<MissionBudgetOverlay view={view} />);
    const frame = lastFrame() ?? "";
    expect(frame.toLowerCase()).toContain("exhausted");
    expect(frame).toContain("Codex");
  });

  it("unknown: honest empty state, no descendant rows fabricated", () => {
    const { lastFrame } = render(
      <MissionBudgetOverlay view={unknownBudgetLine()} />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("no active mission");
    expect(frame).not.toContain("Codex");
  });

  it("poll-fail: the failure detail replaces the breakdown, never stale numbers", () => {
    const { lastFrame } = render(
      <MissionBudgetOverlay view={pollFailBudgetLine("control plane unreachable")} />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("control plane unreachable");
    expect(frame).not.toContain("Codex");
    expect(frame).not.toContain("pool 30m");
  });
});
