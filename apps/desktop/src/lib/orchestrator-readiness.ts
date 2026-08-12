import type { VendorReadiness } from "@muon/client";
import { coordinatorPreference, vendorLabel } from "@muon/client/vendors";
import type { OrchestratorVendor } from "./crew-config.js";

export type OrchestratorReadinessIssue = {
  vendor: OrchestratorVendor;
  label: string;
  blocking: boolean;
  detail: string;
  fixHint: string;
};

/**
 * Project the selected Mission provider's readiness into one actionable UI
 * issue. Missing probe evidence is honest absence, not proof that the provider
 * cannot run. An explicit unknown probe is visible but non-blocking.
 */
export function orchestratorReadinessIssue(
  readiness: VendorReadiness[] | null | undefined,
  vendor: OrchestratorVendor
): OrchestratorReadinessIssue | null {
  const entry = readiness?.find((candidate) => candidate.vendor === vendor);
  if (!entry || (entry.installed && entry.authenticated)) {
    return null;
  }

  const label = vendorLabel(vendor);
  const probeUnknown = entry.installed && entry.authState === "unknown";
  const fixHint =
    entry.fixHint ??
    (!entry.installed
      ? `Install ${label}, then re-check readiness.`
      : probeUnknown
        ? `Re-check readiness; if it stays unknown, run ${label}'s own status command.`
        : `Finish ${label} setup in the vendor CLI, then re-check readiness.`);

  return {
    vendor,
    label,
    blocking: !probeUnknown,
    detail: entry.detail,
    fixHint,
  };
}

/**
 * Return a dispatch-ready alternative orchestrator, if one is configured.
 *
 * WAVE E: searched in the operator's COORDINATOR PREFERENCE order rather than
 * registry order. `coordinatorPreference()` is the intersection with the seated
 * set, so this can only ever reorder seats that were already legal.
 */
export function readyOrchestratorFallback(
  readiness: VendorReadiness[] | null | undefined,
  current: OrchestratorVendor
): OrchestratorVendor | null {
  return (
    coordinatorPreference().find((vendor) => {
      if (vendor === current) return false;
      const entry = readiness?.find((candidate) => candidate.vendor === vendor);
      return entry?.installed === true && entry.authenticated === true;
    }) ?? null
  );
}

export function orchestratorReadinessError(
  issue: OrchestratorReadinessIssue
): string {
  return `${issue.label} is not ready for Mission chat. ${issue.detail} ${issue.fixHint}`;
}

/**
 * Resolve the effective preflight issue. A cached definite block gets one
 * fresh probe before it is enforced; ready, unknown, and unavailable evidence
 * do not trigger extra vendor CLI work.
 */
export async function verifyOrchestratorReadiness(
  vendor: OrchestratorVendor,
  load: (refresh: boolean) => Promise<VendorReadiness[] | null>
): Promise<OrchestratorReadinessIssue | null> {
  const cached = await load(false);
  let issue = orchestratorReadinessIssue(cached, vendor);
  if (issue?.blocking) {
    const refreshed = await load(true);
    issue = orchestratorReadinessIssue(refreshed ?? cached, vendor);
  }
  return issue;
}
