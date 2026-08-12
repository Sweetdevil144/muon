/**
 * Aggregate honest per-vendor token usage for a mission (chat) from the
 * append-only audit ledger. Only events that carry numeric `metadata.usage`
 * contribute — Cursor stays "unavailable" until a managed lane emits real
 * numbers.
 */

import type { RecordedEvent } from "@muon/client";
import {
  FLEET_VENDOR_LABELS,
  FLEET_VENDORS,
  type FleetVendor,
} from "./fleet.js";

export type VendorUsageRow = {
  vendor: FleetVendor;
  label: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** False when this vendor has no honest usage signal yet. */
  available: boolean;
  runs: number;
  /** Sum of explicit vendor-reported dollars only. */
  reportedCostUsd: number;
  costAvailable: boolean;
  costedRuns: number;
  averageLatencyMs?: number;
  latencyRuns: number;
  peakContextOccupancy?: number;
  contextRuns: number;
};

export type MissionTokenUsage = {
  byVendor: VendorUsageRow[];
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  hasAny: boolean;
  reportedCostUsd: number;
  hasCost: boolean;
  costedRuns: number;
  measuredRuns: number;
};

function asNonNegInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return undefined;
}

function asNonNegNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return undefined;
}

function normalizeVendor(raw: unknown): FleetVendor | null {
  if (raw === "claude-code" || raw === "codex" || raw === "cursor") {
    return raw;
  }
  if (raw === "claude") return "claude-code";
  return null;
}

function readUsage(
  event: RecordedEvent
): {
  vendor: FleetVendor;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  latencyMs?: number;
  contextOccupancy?: number;
} | null {
  const usage = event.metadata?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  const vendor =
    normalizeVendor(record.vendor) ?? normalizeVendor(event.laneId);
  if (!vendor || vendor === "cursor") return null;
  const inputTokens =
    asNonNegInt(record.inputTokens) ?? asNonNegInt(record.input_tokens);
  const outputTokens =
    asNonNegInt(record.outputTokens) ?? asNonNegInt(record.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return null;
  const costUsd =
    asNonNegNumber(record.costUsd) ?? asNonNegNumber(record.cost_usd);
  const latencyMs =
    asNonNegInt(record.latencyMs) ?? asNonNegInt(record.latency_ms);
  const contextUsedTokens = asNonNegInt(record.contextUsedTokens);
  const contextWindowTokens = asNonNegInt(record.contextWindowTokens);
  return {
    vendor,
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(contextUsedTokens !== undefined &&
    contextWindowTokens !== undefined &&
    contextWindowTokens > 0
      ? { contextOccupancy: contextUsedTokens / contextWindowTokens }
      : {}),
  };
}

export function aggregateMissionTokenUsage(
  events: readonly RecordedEvent[]
): MissionTokenUsage {
  const totals = new Map<
    FleetVendor,
    {
      inputTokens: number;
      outputTokens: number;
      runs: number;
      reportedCostUsd: number;
      costedRuns: number;
      latencyMs: number;
      latencyRuns: number;
      peakContextOccupancy?: number;
      contextRuns: number;
    }
  >();

  for (const event of events) {
    const parsed = readUsage(event);
    if (!parsed) continue;
    const prev = totals.get(parsed.vendor) ?? {
      inputTokens: 0,
      outputTokens: 0,
      runs: 0,
      reportedCostUsd: 0,
      costedRuns: 0,
      latencyMs: 0,
      latencyRuns: 0,
      contextRuns: 0,
    };
    prev.inputTokens += parsed.inputTokens;
    prev.outputTokens += parsed.outputTokens;
    prev.runs += 1;
    if (parsed.costUsd !== undefined) {
      prev.reportedCostUsd += parsed.costUsd;
      prev.costedRuns += 1;
    }
    if (parsed.latencyMs !== undefined) {
      prev.latencyMs += parsed.latencyMs;
      prev.latencyRuns += 1;
    }
    if (parsed.contextOccupancy !== undefined) {
      prev.peakContextOccupancy = Math.max(
        prev.peakContextOccupancy ?? 0,
        parsed.contextOccupancy
      );
      prev.contextRuns += 1;
    }
    totals.set(parsed.vendor, prev);
  }

  const byVendor: VendorUsageRow[] = FLEET_VENDORS.map((vendor) => {
    const row = totals.get(vendor);
    if (vendor === "cursor") {
      return {
        vendor,
        label: FLEET_VENDOR_LABELS[vendor],
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        available: false,
        runs: 0,
        reportedCostUsd: 0,
        costAvailable: false,
        costedRuns: 0,
        latencyRuns: 0,
        contextRuns: 0,
      };
    }
    if (!row) {
      return {
        vendor,
        label: FLEET_VENDOR_LABELS[vendor],
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        available: true,
        runs: 0,
        reportedCostUsd: 0,
        costAvailable: false,
        costedRuns: 0,
        latencyRuns: 0,
        contextRuns: 0,
      };
    }
    return {
      vendor,
      label: FLEET_VENDOR_LABELS[vendor],
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.inputTokens + row.outputTokens,
      available: true,
      runs: row.runs,
      reportedCostUsd: row.reportedCostUsd,
      costAvailable: row.costedRuns > 0,
      costedRuns: row.costedRuns,
      ...(row.latencyRuns > 0
        ? { averageLatencyMs: row.latencyMs / row.latencyRuns }
        : {}),
      latencyRuns: row.latencyRuns,
      ...(row.peakContextOccupancy !== undefined
        ? { peakContextOccupancy: row.peakContextOccupancy }
        : {}),
      contextRuns: row.contextRuns,
    };
  });

  const inputTokens = byVendor.reduce((n, row) => n + row.inputTokens, 0);
  const outputTokens = byVendor.reduce((n, row) => n + row.outputTokens, 0);
  const hasAny = byVendor.some((row) => row.available && row.runs > 0);
  const reportedCostUsd = byVendor.reduce(
    (n, row) => n + row.reportedCostUsd,
    0
  );
  const costedRuns = byVendor.reduce((n, row) => n + row.costedRuns, 0);
  const measuredRuns = byVendor.reduce((n, row) => n + row.runs, 0);

  return {
    byVendor,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    hasAny,
    reportedCostUsd,
    hasCost: costedRuns > 0,
    costedRuns,
    measuredRuns,
  };
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatReportedUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatDurationMs(n: number): string {
  if (n < 1_000) return `${Math.round(n)}ms`;
  return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}s`;
}
