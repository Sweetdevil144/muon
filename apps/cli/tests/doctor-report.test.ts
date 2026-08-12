import { describe, expect, it } from "vitest";
import {
  buildCapabilityPreflight,
  type FleetReadinessReport,
} from "@muon/client";
import { buildDoctorReport } from "../src/lib/doctor-report.js";

const NOW = new Date("2026-07-16T00:00:00.000Z");

const health = {
  status: "ok",
  service: "muon-backend",
  timestamp: NOW.toISOString(),
};

const liveRunner = {
  runner: { status: "online", lastSeenAt: NOW.toISOString() },
  live: true,
};

const byokReadiness: FleetReadinessReport = {
  vendors: [
    {
      vendor: "codex",
      installed: true,
      authenticated: true,
      credentialMethod: "custom-provider" as const,
      detail: "codex CLI configured through its active provider",
      authState: "confirmed" as const,
    },
  ],
  anyReady: true,
  generatedAt: NOW.toISOString(),
};

const cursorOnlyReadiness: FleetReadinessReport = {
  vendors: [
    {
      vendor: "cursor",
      installed: true,
      authenticated: true,
      detail: "cursor-agent connected",
      authState: "confirmed" as const,
    },
  ],
  generatedAt: NOW.toISOString(),
};

function report(input: {
  readiness: FleetReadinessReport | null;
  runner?: typeof liveRunner | null;
}) {
  const preflight = buildCapabilityPreflight({
    brain: { reachable: true },
    readiness: input.readiness,
    runner: input.runner === undefined ? liveRunner : input.runner,
    now: NOW,
  });
  return buildDoctorReport({
    preflight,
    health,
    laneCount: 2,
    pendingApprovals: 0,
    activeHandoffs: 0,
    laneDoctor: null,
  });
}

describe("buildDoctorReport", () => {
  it("never reports a cursor-only fleet as vendor-ready (the doctor cursor bug)", () => {
    const { payload } = report({ readiness: cursorOnlyReadiness });
    expect(payload.anyVendorReady).toBe(false);
  });

  it("renders vendorReadiness: null (not []) and exits 1 when readiness is unavailable", () => {
    const { payload, exitCode } = report({ readiness: null });
    expect(payload.vendorReadiness).toBeNull();
    expect(exitCode).toBe(1);
  });

  it("exits 0 when ready and keeps credentialMethod on BYOK rows", () => {
    const { payload, exitCode } = report({ readiness: byokReadiness });
    expect(exitCode).toBe(0);
    expect(payload.anyVendorReady).toBe(true);
    const rows = payload.vendorReadiness as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      vendor: "codex",
      authenticated: true,
      credentialMethod: "custom-provider",
    });
    // Runner health reaches doctor for the first time.
    expect(payload.runner).toEqual({ state: "live", live: true });
    // The full contract is embedded.
    expect((payload.preflight as Record<string, unknown>).version).toBe(1);
  });

  it("keeps every legacy doctor key", () => {
    const { payload } = report({ readiness: byokReadiness });
    for (const key of [
      "ok",
      "service",
      "timestamp",
      "laneCount",
      "pendingApprovals",
      "activeHandoffs",
      "adapterSummary",
      "adapters",
      "anyVendorReady",
      "vendorReadiness",
    ]) {
      expect(payload).toHaveProperty(key);
    }
  });

  it("never prints a token, only provenance labels and hints", () => {
    const { payload } = report({ readiness: byokReadiness });
    expect(JSON.stringify(payload)).not.toMatch(/sk-|bearer|secret/i);
  });
});
