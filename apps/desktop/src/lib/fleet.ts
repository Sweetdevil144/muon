/**
 * Fleet sizing rules: 0–3 instances per vendor, always whole numbers.
 *
 * WAVE D: `FLEET_VENDORS` and its labels are PROJECTIONS of the ADR-0022
 * registry, not a third hand-written mirror of the backend route. This table
 * drifted once already: the app kept sizing three lanes after Cursor became a
 * MANAGED read-only lane and a fourth lane arrived, so `muon fleet set --<lane>`
 * worked from the terminal while the app had no row for it at all.
 *
 * Which ROLES each lane may hold is still not decided here — that comes from the
 * role model (`vendorRoleScope`), and sizing a lane grants it nothing.
 */

import {
  fleetVendorIds,
  vendorLabel,
  type VendorId,
} from "@muon/client/vendors";

export const FLEET_VENDORS = fleetVendorIds();

/**
 * The GLOBAL standing-consent predicate: true only when EVERY managed lane is
 * selected. THE one spelling (P0-1): main-process consumers (the
 * standing-approver lease, MUON_FULL_AUTO, schedule canClaim) and renderer
 * chrome (the Auto-approve panel) must agree on what "machine-wide" means, and
 * two predicates over the same list is how a subset got rendered as "every
 * lane". Lives here rather than settings.ts because settings.ts imports
 * node:fs and the renderer may not.
 */
export function isGlobalStandingConsent(
  vendors: readonly string[]
): boolean {
  return (
    FLEET_VENDORS.length > 0 &&
    FLEET_VENDORS.every((id) => vendors.includes(id))
  );
}

export type FleetVendor = VendorId;

export const FLEET_VENDOR_LABELS: Record<string, string> = Object.fromEntries(
  FLEET_VENDORS.map((vendor) => [vendor, vendorLabel(vendor)])
);

export const FLEET_MAX = 3;

export function clampFleetCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(FLEET_MAX, Math.max(0, Math.trunc(value)));
}

/**
 * Steps one vendor's count by delta and returns a full, normalized counts
 * object (every vendor present, all values clamped 0–3) ready for setFleet.
 */
export function stepFleet(
  counts: Partial<Record<string, number>>,
  vendor: FleetVendor,
  delta: number
): Record<FleetVendor, number> {
  const next = {} as Record<FleetVendor, number>;
  for (const key of FLEET_VENDORS) {
    next[key] = clampFleetCount(counts[key] ?? 0);
  }
  next[vendor] = clampFleetCount(next[vendor] + delta);
  return next;
}
