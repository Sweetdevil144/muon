/**
 * ADR-0019 R2 (week F8 slice) — the MCP drift inspector.
 *
 * A pure assessor over `McpStatusReport`: for each vendor, judge the OBSERVED
 * registration (what the vendor's config actually says, re-verified this run)
 * against the EXPECTED one (what `muon mcp install` would record right now),
 * and say plainly why a session would be preauthorized, would ask, or would
 * get nothing. No new probes — the honesty of this surface is that it renders
 * only what the status run actually observed.
 *
 * Deliberately NOT the full manifest/attestation pipeline (compatibility
 * import and per-run attestation remain the v0.0.1 block this ADR names);
 * this is the operator-facing half: drift made visible where the operator
 * already looks.
 */
import type { McpStatusReport, McpVendorStatus } from "./mcp-status.js";

export type McpDriftVerdict =
  /** Registered, command resolves, matches today's install target. */
  | "in-sync"
  /** Registered but pointing at something an install would not record now. */
  | "drifted"
  /** Registered but the recorded command no longer resolves — silent failure. */
  | "broken"
  /** Vendor CLI present, MUON not registered with it. */
  | "not-registered"
  /** Vendor CLI itself is absent; registration state is moot. */
  | "vendor-missing";

export type McpDriftFinding = {
  code:
    | "command-unresolvable"
    | "command-path-drift"
    | "not-registered"
    | "vendor-missing"
    | "vendor-reason";
  severity: "error" | "warn" | "info";
  detail: string;
  /** The exact command that fixes it, when one exists. */
  fix?: string;
};

export type McpVendorDrift = {
  vendor: McpVendorStatus["vendor"];
  label: string;
  verdict: McpDriftVerdict;
  /** Observed (vendor config) vs expected (what install would record NOW). */
  observedCommand: string | null;
  expectedCommand: string | null;
  findings: McpDriftFinding[];
};

export type McpDriftReport = {
  vendors: McpVendorDrift[];
  /** The one-line authority explanation for this session's own tier. */
  authority: string;
};

/** Why a call from a session with this report is preauthorized / asks / denied. */
export function explainAuthority(report: McpStatusReport): string {
  if (report.tier === "none") {
    return "No credential would resolve: a session gets ZERO muon tools until a brain runs (never operator, by construction).";
  }
  if (report.wouldGetTierC) {
    return `Attached coordinator (Tier C): ${report.toolCount} tools including dispatch/steer/ship — ${report.tierCReason} Every write still lands on the brain's own route gates.`;
  }
  return `Agent tier: ${report.toolCount} read/coordination tools. Dispatch, steer, interrupt, ship and approvals are ABSENT from the toolset (deny-first), not merely refused; a coordinator seat requires an explicit operator attach (ADR-0028).`;
}

export function assessMcpDrift(report: McpStatusReport): McpDriftReport {
  const vendors = report.vendors.map((vendor): McpVendorDrift => {
    const findings: McpDriftFinding[] = [];
    const expected = report.resolvedCommand;

    let verdict: McpDriftVerdict;
    if (!vendor.cliInstalled) {
      verdict = "vendor-missing";
      findings.push({
        code: "vendor-missing",
        severity: "info",
        detail: `${vendor.cli} is not installed; registration state is moot until it is.`,
      });
    } else if (!vendor.installed) {
      verdict = "not-registered";
      findings.push({
        code: "not-registered",
        severity: "warn",
        detail: `MUON is not registered with ${vendor.label}; sessions there see no muon tools.`,
        fix: `muon mcp install ${vendor.vendor}`,
      });
    } else if (vendor.commandResolves === false) {
      verdict = "broken";
      findings.push({
        code: "command-unresolvable",
        severity: "error",
        detail: `${vendor.label} points at ${vendor.command ?? "an entry"} which no longer resolves — sessions fail silently inside the vendor CLI.`,
        fix: `muon mcp install ${vendor.vendor}`,
      });
    } else if (
      expected !== null &&
      vendor.command !== null &&
      vendor.command !== expected
    ) {
      verdict = "drifted";
      findings.push({
        code: "command-path-drift",
        severity: "warn",
        detail: `${vendor.label} runs ${vendor.command}, but an install today would record ${expected} (moved/updated binary).`,
        fix: `muon mcp install ${vendor.vendor}`,
      });
    } else {
      verdict = "in-sync";
    }

    // Carry the status run's own per-vendor reasons through, so the inspector
    // never hides a warning the underlying report raised.
    for (const reason of vendor.reasons) {
      if (reason.level !== "ok") {
        findings.push({
          code: "vendor-reason",
          severity: reason.level === "fail" ? "error" : "warn",
          detail: reason.detail,
        });
      }
    }

    return {
      vendor: vendor.vendor,
      label: vendor.label,
      verdict,
      observedCommand: vendor.command,
      expectedCommand: expected,
      findings,
    };
  });

  return { vendors, authority: explainAuthority(report) };
}
