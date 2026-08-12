import type { CapabilityPreflight } from "@muon/client";

/** The lane-doctor evidence `muon doctor` has always rendered (best-effort). */
export type DoctorLaneEvidence = {
  summary: unknown;
  records: Array<{
    lane: { name: string; key: string };
    adapterFound: boolean;
    health?: { status?: string } | null;
  }>;
};

export type DoctorReportInput = {
  /** The P0.5 capability preflight (the one contract; never null — the collector never rejects). */
  preflight: CapabilityPreflight;
  health: { status: string; service: string; timestamp: string } | null;
  laneCount: number;
  pendingApprovals: number;
  activeHandoffs: number;
  laneDoctor: DoctorLaneEvidence | null;
};

/**
 * Project the capability preflight (plus the legacy lane evidence) into the
 * human `muon doctor` payload. Pure so it tests deterministically.
 *
 * Honesty rules baked in:
 *  - `anyVendorReady` comes from the contract's cursor-excluded verdict, so a
 *    cursor-only fleet can never read as dispatch-ready (the old doctor bug).
 *  - Unavailable readiness renders `vendorReadiness: null`, never a dishonest
 *    empty list.
 *  - `credentialMethod` is a fixed provenance label, never a credential value.
 */
export function buildDoctorReport(input: DoctorReportInput): {
  payload: Record<string, unknown>;
  exitCode: number;
} {
  const { preflight, health, laneDoctor } = input;
  const payload: Record<string, unknown> = {
    ok: health?.status === "ok",
    service: health?.service ?? "unknown",
    timestamp: health?.timestamp ?? preflight.generatedAt,
    laneCount: input.laneCount,
    pendingApprovals: input.pendingApprovals,
    activeHandoffs: input.activeHandoffs,
    adapterSummary: laneDoctor?.summary ?? null,
    adapters: (laneDoctor?.records ?? []).map((record) => ({
      lane: record.lane.name,
      key: record.lane.key,
      adapterFound: record.adapterFound,
      health: record.health?.status ?? "unknown",
    })),
    // Cursor-excluded dispatch verdict straight from the contract.
    anyVendorReady: preflight.readiness.anyDispatchReady,
    vendorReadiness:
      preflight.readiness.source === "unavailable"
        ? null
        : preflight.vendors.map((vendor) => ({
            vendor: vendor.vendor,
            installed: vendor.installed,
            authenticated: vendor.auth === "authenticated",
            authState: vendor.auth,
            credentialMethod:
              vendor.authMethod === "none" || vendor.authMethod === "unknown"
                ? null
                : vendor.authMethod,
            detail: vendor.detail,
            fixHint: vendor.fixHint ?? null,
          })),
    runner: {
      state: preflight.runnerHealth.state,
      live: preflight.runnerHealth.live,
    },
    // The one pointer docs/design/cc-as-superagent-delivery.md §3.2 asks for.
    // `muon doctor` is the WRONG home for MCP-attachment state — it emits the
    // versioned `collectCapabilityPreflight` contract and none of that state
    // belongs in that schema — but a stale absolute muon-mcp path fails silently
    // inside the user's own vendor CLI, and re-verifying only works if something
    // tells the user to run the command that re-verifies. This key lives on the
    // LEGACY human payload only; the `--json` contract path never reaches here.
    mcpStatus:
      "run `muon mcp status` for MUON's MCP registration in your own coding-agent CLIs (tier, token source, and whether each recorded muon-mcp path still resolves)",
    preflight,
  };
  return {
    payload,
    exitCode: preflight.status === "ready" ? 0 : 1,
  };
}
