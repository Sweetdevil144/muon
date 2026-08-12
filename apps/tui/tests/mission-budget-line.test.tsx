import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { plainFrame } from "./ansi.js";
import {
  buildBudgetLineView,
  pollFailBudgetLine,
  unknownBudgetLine,
} from "@muon/client";
import type { DispatchBudget } from "@muon/client";
import { MissionBudgetLine } from "../src/components/MissionBudgetLine.js";

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
    children: [],
    ...overrides,
  };
}

describe("MissionBudgetLine at 80x24 (compact row budget)", () => {
  it("ready: renders the bare remaining/pool summary only, no breakdown", () => {
    const { lastFrame } = render(
      <MissionBudgetLine view={buildBudgetLineView(budget())} compact />
    );
    const frame = plainFrame(lastFrame() ?? "");
    expect(frame).toContain("15m left of 30m pool");
    expect(frame).not.toContain("reserved");
    expect(frame).not.toContain("consumed");
  });

  it("exhausted: still count/summary only, and reads as the needs-you state", () => {
    const { lastFrame } = render(
      <MissionBudgetLine
        view={buildBudgetLineView(budget({ remainingMs: 0 }))}
        compact
      />
    );
    const frame = plainFrame(lastFrame() ?? "");
    expect(frame.toLowerCase()).toContain("exhausted");
    expect(frame).not.toContain("reserved");
  });

  it("unknown: an honest empty state, never a fabricated number", () => {
    const { lastFrame } = render(
      <MissionBudgetLine view={unknownBudgetLine()} compact />
    );
    const frame = plainFrame(lastFrame() ?? "");
    expect(frame).toContain("no active mission");
    expect(frame).not.toMatch(/\d/);
  });

  it("poll-fail: an honest failure line, never a stale ready number", () => {
    const { lastFrame } = render(
      <MissionBudgetLine
        view={pollFailBudgetLine("control plane unreachable")}
        compact
      />
    );
    const frame = plainFrame(lastFrame() ?? "");
    expect(frame).toContain("control plane unreachable");
    expect(frame).not.toMatch(/\d+m left/);
  });
});

describe("MissionBudgetLine at 100x30 (standard row budget)", () => {
  it("ready: extends the same row with the reserved/consumed breakdown", () => {
    const { lastFrame } = render(
      <MissionBudgetLine view={buildBudgetLineView(budget())} />
    );
    const frame = plainFrame(lastFrame() ?? "");
    expect(frame).toContain("15m left of 30m pool");
    expect(frame).toContain("reserved 5m");
    expect(frame).toContain("consumed 10m");
  });

  it("exhausted reads as the sole needs-you tone, not a plain number", () => {
    const view = buildBudgetLineView(budget({ remainingMs: 0 }));
    expect(view.status).toBe("exhausted");
    const { lastFrame } = render(<MissionBudgetLine view={view} />);
    expect(plainFrame(lastFrame() ?? "")).toContain("exhausted");
  });

  it("unknown never grows past the one-line honest summary", () => {
    const { lastFrame } = render(
      <MissionBudgetLine view={unknownBudgetLine()} />
    );
    expect(plainFrame(lastFrame() ?? "")).toContain("no active mission");
  });

  it("poll-fail never shows stale ready numbers, even with room for the full breakdown", () => {
    const { lastFrame } = render(
      <MissionBudgetLine view={pollFailBudgetLine("fetch failed")} />
    );
    const frame = plainFrame(lastFrame() ?? "");
    expect(frame).toContain("fetch failed");
    expect(frame).not.toContain("pool");
  });
});
