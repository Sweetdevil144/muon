import { describe, expect, it } from "vitest";
import type { RecordedEvent } from "@muon/client";
import {
  aggregateMissionTokenUsage,
  formatTokenCount,
} from "../src/lib/mission-token-usage.js";

function event(
  over: Partial<RecordedEvent> & { metadata: Record<string, unknown> }
): RecordedEvent {
  return {
    id: over.id ?? "e1",
    laneId: over.laneId ?? "claude-code",
    taskId: over.taskId ?? "t1",
    kind: over.kind ?? "task.completed",
    message: over.message ?? "done",
    timestamp: over.timestamp ?? "2026-01-01T00:00:00.000Z",
    metadata: over.metadata,
  };
}

describe("mission token usage", () => {
  it("aggregates per-vendor from honest metadata.usage events", () => {
    const usage = aggregateMissionTokenUsage([
      event({
        laneId: "claude-code",
        metadata: {
          usage: {
            vendor: "claude-code",
            inputTokens: 100,
            outputTokens: 20,
            costUsd: 0.03,
            latencyMs: 1_200,
          },
        },
      }),
      event({
        id: "e2",
        laneId: "codex",
        metadata: {
          usage: {
            vendor: "codex",
            inputTokens: 50,
            outputTokens: 10,
            latencyMs: 900,
            contextUsedTokens: 50,
            contextWindowTokens: 100,
          },
        },
      }),
      event({
        id: "e3",
        laneId: "claude-code",
        metadata: {
          usage: {
            vendor: "claude-code",
            inputTokens: 5,
            outputTokens: 5,
            costUsd: 0.01,
            latencyMs: 800,
          },
        },
      }),
    ]);

    expect(usage.hasAny).toBe(true);
    expect(usage.totalTokens).toBe(190);
    const claude = usage.byVendor.find((r) => r.vendor === "claude-code")!;
    const codex = usage.byVendor.find((r) => r.vendor === "codex")!;
    const cursor = usage.byVendor.find((r) => r.vendor === "cursor")!;
    expect(claude.inputTokens).toBe(105);
    expect(claude.outputTokens).toBe(25);
    expect(claude.runs).toBe(2);
    expect(claude.reportedCostUsd).toBeCloseTo(0.04);
    expect(claude.costedRuns).toBe(2);
    expect(claude.averageLatencyMs).toBe(1_000);
    expect(codex.totalTokens).toBe(60);
    expect(codex.costAvailable).toBe(false);
    expect(codex.peakContextOccupancy).toBe(0.5);
    expect(cursor.available).toBe(false);
    expect(usage.reportedCostUsd).toBeCloseTo(0.04);
    expect(usage.costedRuns).toBe(2);
    expect(usage.measuredRuns).toBe(3);
  });

  it("ignores events without numeric usage", () => {
    const usage = aggregateMissionTokenUsage([
      event({ metadata: { note: "no usage" } }),
      event({
        id: "e2",
        metadata: { usage: { vendor: "claude-code", inputTokens: "n/a" } },
      }),
    ]);
    expect(usage.hasAny).toBe(false);
    expect(usage.totalTokens).toBe(0);
  });

  it("formats compact token counts", () => {
    expect(formatTokenCount(42)).toBe("42");
    expect(formatTokenCount(1500)).toBe("1.5k");
    expect(formatTokenCount(12_400)).toBe("12k");
  });

  it("does not turn missing vendor dollars into zero cost", () => {
    const usage = aggregateMissionTokenUsage([
      event({
        metadata: {
          usage: {
            vendor: "claude-code",
            inputTokens: 4,
            outputTokens: 2,
          },
        },
      }),
    ]);
    const claude = usage.byVendor.find((row) => row.vendor === "claude-code")!;
    expect(claude.costAvailable).toBe(false);
    expect(claude.reportedCostUsd).toBe(0);
    expect(usage.hasCost).toBe(false);
  });
});
